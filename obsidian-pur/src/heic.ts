import createHeif, { HeifLibrary } from "libheif-js/libheif/libheif.js";
import { codecDimensions, codecPixels, HeicLimits, HeicPixels } from "./heic-codec";
import workerSource from "./heic-worker-source";

export { heicMime } from "./heic-codec";
let engine: HeifLibrary | undefined;
let fallbackReason: string | undefined;
let fallbackHandler: ((message: string) => void) | undefined;

export function setHeicFallbackHandler(handler?: (message: string) => void): void {
  fallbackHandler = handler;
  fallbackReason = undefined;
}
function legacy(): HeifLibrary {
  return engine ??= createHeif({
    print: message => console.info("[PUR HEIC]", message),
    printErr: message => console.error("[PUR HEIC]", message),
  });
}
export function heicDimensions(data: Uint8Array): { width: number; height: number } {
  return codecDimensions(data, legacy());
}
async function legacyPixels(data: Uint8Array, signal: AbortSignal, limits: HeicLimits): Promise<HeicPixels> {
  signal.throwIfAborted();
  return codecPixels(data, signal, legacy(), limits);
}

interface Pending {
  data: Uint8Array; limits: HeicLimits;
  resolve: (pixels: HeicPixels) => void; reject: (error: Error) => void;
  signal: AbortSignal; abort: () => void;
}
let active: { worker: Worker; url: string; ready: boolean; booted: boolean;
  blocked: boolean; violation: (event: SecurityPolicyViolationEvent) => void;
  timer: ReturnType<typeof setTimeout>; pending: Map<number, Pending> } | undefined;
let nextId = 0;

export function disposeHeicWorker(): void {
  stop(new DOMException("HEIC処理を中断しました", "AbortError"));
}
function stop(error?: Error): void {
  const current = active;
  if (!current) return;
  active = undefined;
  clearTimeout(current.timer);
  globalThis.removeEventListener?.("securitypolicyviolation", current.violation);
  current.worker.terminate();
  URL.revokeObjectURL(current.url);
  for (const pending of current.pending.values()) {
    pending.signal.removeEventListener("abort", pending.abort);
    pending.reject(error ?? new Error("HEIC Workerが終了しました"));
  }
  current.pending.clear();
}
function fallback(message: string): void {
  fallbackReason = message;
  console.warn("[PUR HEIC] WASM/Workerを利用できないため従来方式へ切り替えます:", message);
  fallbackHandler?.(`HEIC高速デコーダーを利用できないため従来方式へ切り替えます: ${message}`);
  const waiting = [...(active?.pending.values() ?? [])];
  active?.pending.clear();
  stop();
  for (const pending of waiting) {
    pending.signal.removeEventListener("abort", pending.abort);
    void legacyPixels(pending.data, pending.signal, pending.limits).then(pending.resolve, pending.reject);
  }
}
function workerPixels(data: Uint8Array, signal: AbortSignal, limits: HeicLimits): Promise<HeicPixels> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    if (!active) {
      let url: string | undefined;
      let worker: Worker | undefined;
      try {
        url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
        worker = new Worker(url);
        const createdWorker = worker;
        const violation = (event: SecurityPolicyViolationEvent) => {
          if (active?.worker === createdWorker && ["worker-src", "child-src", "script-src", "default-src"]
            .includes(event.effectiveDirective) &&
            (event.blockedURI === "blob" || event.blockedURI.startsWith("blob:"))) active.blocked = true;
        };
        const current = { worker, url, ready: false, booted: false, blocked: false, violation,
          timer: setTimeout(() => stop(new Error("HEIC Workerの起動がタイムアウトしました")), 15000),
          pending: new Map<number, Pending>() };
        active = current;
        globalThis.addEventListener?.("securitypolicyviolation", violation);
        worker.onerror = event => {
          event.preventDefault();
          if (active !== current) return;
          if (!current.booted && current.blocked &&
            !/memory|allocation|メモリ/i.test(event.message ?? ""))
            fallback("端末の制限によりWorkerスクリプトを起動できません");
          else stop(new Error(`HEIC Workerの実行に失敗しました: ${event.message}`));
        };
        worker.onmessageerror = () => {
          if (active === current) stop(new Error("HEIC Workerの応答を読み取れません"));
        };
        worker.onmessage = event => {
          if (active !== current) return;
          const message = event.data;
          if (!message || typeof message !== "object" || typeof message.kind !== "string") {
            stop(new Error("HEIC Workerの応答形式が不正です"));
            return;
          }
          if (message.kind === "boot") { current.booted = true; return; }
          if (message.kind === "unavailable") { fallback(message.message); return; }
          if (message.kind === "startup-error") { stop(new Error(message.message)); return; }
          if (message.kind === "ready") {
            clearTimeout(current.timer);
            current.ready = true;
            for (const [id, pending] of current.pending)
              try { createdWorker.postMessage({ id, data: pending.data, limits: pending.limits }); }
              catch (error) { stop(error instanceof Error ? error : new Error(String(error))); break; }
            return;
          }
          const pending = current.pending.get(message.id);
          if (!pending) { stop(new Error("HEIC Workerの応答IDが不正です")); return; }
          current.pending.delete(message.id);
          pending.signal.removeEventListener("abort", pending.abort);
          if (message.kind === "error") pending.reject(new Error(message.message));
          else if (message.kind === "pixels" && message.data instanceof Uint8ClampedArray &&
            Number.isSafeInteger(message.width) && Number.isSafeInteger(message.height) &&
            message.width > 0 && message.height > 0 && message.width * message.height <= 40_000_000 &&
            message.width * message.height <= (pending.limits.maxPixels ?? 40_000_000) &&
            (pending.limits.width === undefined || message.width === pending.limits.width) &&
            (pending.limits.height === undefined || message.height === pending.limits.height) &&
            message.data.length === message.width * message.height * 4) pending.resolve(message);
          else pending.reject(new Error("HEIC Workerの画像応答が不正です"));
          if (!current.pending.size) stop();
        };
      } catch (error) {
        if (active?.worker === worker && worker) stop();
        else { worker?.terminate(); if (url) URL.revokeObjectURL(url); }
        if (error instanceof DOMException && ["SecurityError", "NotSupportedError"].includes(error.name)) {
          fallback(error.message);
          void legacyPixels(data, signal, limits).then(resolve, reject);
        } else reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    const current = active!;
    const id = ++nextId;
    const abort = () => {
      const pending = current.pending.get(id);
      if (!pending) return;
      current.pending.delete(id);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
      // A synchronous codec cannot accept an abort message while running.
      const waiting = [...current.pending.values()];
      current.pending.clear();
      stop();
      for (const other of waiting) {
        other.signal.removeEventListener("abort", other.abort);
        void workerPixels(other.data, other.signal, other.limits).then(other.resolve, other.reject);
      }
    };
    current.pending.set(id, { data, limits, signal, abort, resolve, reject });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    if (current.ready) {
      try { current.worker.postMessage({ id, data, limits }); }
      catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    }
  });
}
export async function heicPixels(data: Uint8Array, signal: AbortSignal,
  limits: HeicLimits = {}): Promise<HeicPixels> {
  signal.throwIfAborted();
  if (!fallbackReason && typeof Worker === "undefined") fallback("この端末ではWorkerを利用できません");
  if (!fallbackReason && typeof WebAssembly === "undefined") fallback("この端末ではWebAssemblyを利用できません");
  return fallbackReason ? legacyPixels(data, signal, limits) : workerPixels(data, signal, limits);
}
export async function heicBitmap(pixels: HeicPixels, signal: AbortSignal): Promise<ImageBitmap> {
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(new ImageData(pixels.data, pixels.width, pixels.height));
  if (signal.aborted) { bitmap.close(); signal.throwIfAborted(); }
  return bitmap;
}
export async function decodeHeic(data: Uint8Array, signal: AbortSignal, limits: HeicLimits = {}): Promise<ImageBitmap> {
  return heicBitmap(await heicPixels(data, signal, limits), signal);
}
