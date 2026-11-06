import createHeif from "libheif-js/libheif-wasm/libheif-bundle.js";
import { codecPixels, HeicLimits } from "./heic-codec";

declare const self: {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<{ id: number; data: Uint8Array; limits: HeicLimits }>) => void) | null;
};
const scope = self;
scope.postMessage({ kind: "boot" });
async function start(): Promise<void> {
  try {
    if (typeof WebAssembly === "undefined") {
      scope.postMessage({ kind: "unavailable", message: "この端末ではWebAssemblyを利用できません" });
      return;
    }
    const lib = await createHeif({
      print: message => console.info("[PUR HEIC]", message),
      printErr: message => console.error("[PUR HEIC]", message),
    });
    let queue = Promise.resolve();
    scope.onmessage = event => {
      const { id, data, limits } = event.data;
      queue = queue.then(async () => {
        try {
          const pixels = await codecPixels(new Uint8Array(data), new AbortController().signal, lib, limits);
          scope.postMessage({ kind: "pixels", id, ...pixels }, [pixels.data.buffer]);
        } catch (error) {
          scope.postMessage({ kind: "error", id, message: error instanceof Error ? error.message : String(error) });
        }
      });
    };
    scope.postMessage({ kind: "ready" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unavailable = !/memory|allocation|メモリ/i.test(message) &&
      (error instanceof WebAssembly.CompileError ||
        error instanceof DOMException && ["SecurityError", "NotSupportedError"].includes(error.name));
    scope.postMessage({ kind: unavailable ? "unavailable" : "startup-error",
      message });
  }
}
void start();
