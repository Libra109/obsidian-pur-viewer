import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const fixture = new Uint8Array(readFileSync(new URL("./fixtures/example.heic", import.meta.url)));
const bundled = (async () => {
  const { browserOptions } = await import("../build.mjs");
  return (await build({ ...browserOptions, entryPoints: ["src/heic.ts"], write: false,
    format: "iife", globalName: "Heic", minify: true })).outputFiles[0].text;
})();
interface Request { id: number; data: Uint8Array; limits: { maxPixels?: number } }

async function setup(mode: "ready" | "unavailable" | "memory" | "security" | "runtime" |
  "policy" | "unknown" | "timeout" = "ready") {
  const workers: FakeWorker[] = [];
  const warnings: string[] = [], notifications: string[] = [], revoked: string[] = [];
  const violations = new Set<(event: { effectiveDirective: string; blockedURI: string }) => void>();
  class FakeWorker {
    onmessage?: (event: { data: object }) => void;
    onerror?: (event: { message: string; error?: Error; preventDefault(): void }) => void;
    onmessageerror?: () => void;
    requests: Request[] = [];
    terminated = false;
    constructor(_url: string) {
      if (mode === "security") throw new DOMException("Worker blocked by policy", "SecurityError");
      workers.push(this);
      queueMicrotask(() => {
        if (mode === "timeout") return;
        if (mode === "policy" || mode === "unknown") {
          if (mode === "policy")
            for (const callback of violations) callback({ effectiveDirective: "worker-src", blockedURI: "blob" });
          this.onerror?.({ message: mode === "policy" ? "" : "unknown startup failure", preventDefault() {} });
          return;
        }
        if (mode === "runtime") {
          this.onerror?.({ message: "out of memory", error: new RangeError("out of memory"), preventDefault() {} });
          return;
        }
        this.emit({ kind: "boot" });
        this.emit(mode === "unavailable" ? { kind: "unavailable", message: "WASM blocked by policy" } :
          mode === "memory" ? { kind: "startup-error", message: "out of memory" } : { kind: "ready" });
      });
    }
    emit(data: object) { this.onmessage?.({ data }); }
    postMessage(request: Request, transfer?: unknown[]) {
      assert.equal(transfer, undefined, "original input buffer must not be transferred");
      this.requests.push(request);
    }
    terminate() { this.terminated = true; }
  }
  const sandbox = vm.createContext({
    console: { ...console, warn: (...args: unknown[]) => warnings.push(args.join(" ")) },
    TextDecoder, TextEncoder,
    setTimeout: mode === "timeout" ? (callback: () => void) => setTimeout(callback, 0) : setTimeout,
    clearTimeout, AbortController, DOMException,
    addEventListener: (_name: string, callback: (event: { effectiveDirective: string; blockedURI: string }) => void) =>
      violations.add(callback),
    removeEventListener: (_name: string, callback: (event: { effectiveDirective: string; blockedURI: string }) => void) =>
      violations.delete(callback),
    Uint8Array, Uint8ClampedArray, Blob, Worker: FakeWorker, WebAssembly,
    URL: { createObjectURL: () => `blob:worker-${workers.length}`, revokeObjectURL: (url: string) => revoked.push(url) },
    fixture, notify: (message: string) => notifications.push(message),
  });
  vm.runInContext(await bundled, sandbox);
  vm.runInContext("Heic.setHeicFallbackHandler(notify)", sandbox);
  const api = vm.runInContext("Heic", sandbox) as {
    heicPixels(data: Uint8Array, signal: AbortSignal, limits?: { maxPixels?: number }): Promise<{
      width: number; height: number; data: Uint8ClampedArray;
    }>;
    disposeHeicWorker(): void;
  };
  return { api, workers, warnings, notifications, revoked, violations };
}

test("HEIC Worker routes concurrent requests, preserves input and terminates after final response", async () => {
  const { api, workers, warnings, revoked } = await setup();
  const bytes = fixture.slice(), original = bytes.slice();
  const a = api.heicPixels(bytes, new AbortController().signal);
  const b = api.heicPixels(bytes, new AbortController().signal);
  await Promise.resolve();
  assert.equal(workers.length, 1);
  const worker = workers[0];
  assert.equal(worker.requests.length, 2);
  const [first, second] = worker.requests;
  worker.emit({ kind: "pixels", id: second.id, width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) });
  assert.equal((await b).data[0], 1);
  assert.equal(worker.terminated, false);
  worker.emit({ kind: "pixels", id: first.id, width: 1, height: 1, data: new Uint8ClampedArray([4, 5, 6, 255]) });
  assert.equal((await a).data[0], 4);
  assert.equal(worker.terminated, true);
  assert.equal(revoked.length, 1);
  assert.deepEqual(bytes, original);
  assert.equal(warnings.length, 0);
});

test("HEIC Worker cancellation kills synchronous work and restarts other requests without stale replies", async () => {
  const { api, workers } = await setup();
  const controller = new AbortController();
  const canceled = api.heicPixels(fixture, controller.signal);
  const survivor = api.heicPixels(fixture, new AbortController().signal);
  const rejection = assert.rejects(canceled, { name: "AbortError" });
  await Promise.resolve();
  const old = workers[0], oldId = old.requests[0].id;
  controller.abort();
  await rejection;
  await Promise.resolve();
  assert.equal(old.terminated, true);
  assert.equal(workers.length, 2);
  old.emit({ kind: "pixels", id: oldId, width: 1, height: 1, data: new Uint8ClampedArray(4) });
  const next = workers[1];
  next.emit({ kind: "pixels", id: next.requests[0].id, width: 1, height: 1, data: new Uint8ClampedArray(4) });
  assert.equal((await survivor).width, 1);
  assert.equal(next.terminated, true);
  const pending = api.heicPixels(fixture, new AbortController().signal);
  const disposed = assert.rejects(pending, { name: "AbortError" });
  api.disposeHeicWorker();
  await disposed;
  assert.equal(workers[2].terminated, true);
});

test("HEIC unavailable Worker/WASM notifies once and falls back with exact legacy pixels", async () => {
  for (const mode of ["unavailable", "security", "policy"] as const) {
    const { api, workers, warnings, notifications, violations } = await setup(mode);
    const before = fixture.slice();
    const decoded = await api.heicPixels(fixture, new AbortController().signal);
    assert.equal(decoded.width, 1280);
    const { createHash } = await import("node:crypto");
    assert.equal(createHash("sha256").update(decoded.data).digest("hex"),
      "7f8f77c3e33f64338ebea81ce0102de5a0cf132061bef3176cad0373d7bada3b");
    await assert.rejects(api.heicPixels(fixture.slice(0, 28), new AbortController().signal), /HEIC.*解析/);
    assert.equal(warnings.length, 1);
    assert.equal(notifications.length, 1);
    assert.ok(workers.every(worker => worker.terminated));
    assert.equal(violations.size, 0);
    assert.deepEqual(fixture, before);
  }
});

test("HEIC decode errors, startup/runtime OOM and malformed responses never trigger fallback", async () => {
  for (const mode of ["memory", "runtime"] as const) {
    const { api, warnings, workers } = await setup(mode);
    await assert.rejects(api.heicPixels(fixture, new AbortController().signal), /memory/);
    assert.equal(warnings.length, 0);
    assert.ok(workers[0].terminated);
  }
  for (const mode of ["unknown", "timeout"] as const) {
    const { api, warnings, workers } = await setup(mode);
    await assert.rejects(api.heicPixels(fixture, new AbortController().signal), /failure|タイムアウト/);
    assert.equal(warnings.length, 0, "unknown startup failures are not capability fallback");
    assert.ok(workers[0].terminated);
  }
  const { api, workers, warnings } = await setup();
  const broken = api.heicPixels(fixture, new AbortController().signal);
  const failed = assert.rejects(broken, /corrupt/);
  await Promise.resolve();
  workers[0].emit({ kind: "error", id: workers[0].requests[0].id, message: "corrupt HEIC" });
  await failed;
  const invalid = api.heicPixels(fixture, new AbortController().signal, { maxPixels: 1 });
  const invalidFailure = assert.rejects(invalid, /応答.*不正/);
  await Promise.resolve();
  workers[1].emit({ kind: "pixels", id: workers[1].requests[0].id,
    width: 2, height: 2, data: new Uint8ClampedArray(16) });
  await invalidFailure;
  assert.equal(warnings.length, 0);
  assert.ok(workers.every(worker => worker.terminated));
});
