import type { HeifLibrary } from "libheif-js/libheif/libheif.js";
import { check } from "./binary";

export interface HeicLimits { maxPixels?: number; width?: number; height?: number }
export interface HeicPixels { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }

export function heicMime(data: Uint8Array): string | undefined {
  if (data.length < 24 || new TextDecoder().decode(data.subarray(4, 8)) !== "ftyp") return undefined;
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  if (length < 24 || length > data.length || length > 4096 || length % 4 !== 0) return undefined;
  const brands = [new TextDecoder().decode(data.subarray(8, 12))];
  for (let p = 16; p < length; p += 4) brands.push(new TextDecoder().decode(data.subarray(p, p + 4)));
  if (["hevc", "hevx", "hevm", "hevs", "msf1"].includes(brands[0]) || brands.includes("msf1"))
    return "image/heic-sequence";
  return brands.some(brand => ["heic", "heix", "heim", "heis"].includes(brand)) ? "image/heic" : undefined;
}

function openHeic(data: Uint8Array, lib: HeifLibrary, limits: HeicLimits = {}) {
  check(heicMime(data) === "image/heic", "HEICの時系列シーケンスまたはこのHEIF形式は未対応です");
  check(data.length <= 64 * 1024 * 1024, "64 MiBを超えるHEICは読み込めません");
  const context = lib.heif_context_alloc();
  check(context, "HEICデコーダーのメモリーを確保できません");
  const handles: Parameters<HeifLibrary["heif_image_handle_release"]>[0][] = [];
  const close = () => {
    for (const handle of handles) lib.heif_image_handle_release(handle);
    lib.heif_context_free(context);
  };
  try {
    const error = lib.heif_context_read_from_memory(context, data);
    check(error.code === lib.heif_error_Ok, `HEICを解析できません: ${error.message}`);
    const ids = lib.heif_js_context_get_list_of_top_level_image_IDs(context);
    check(Array.isArray(ids), `HEICの画像一覧を取得できません: ${"message" in ids ? ids.message : ""}`);
    check(ids.length > 0 && ids.length <= 10000, "HEICの画像数が不正か上限を超えています");
    for (const id of ids) {
      const handle = lib.heif_js_context_get_image_handle(context, id);
      check(!("code" in handle), `HEICの画像属性を取得できません: ${"message" in handle ? handle.message : ""}`);
      handles.push(handle);
    }
    const image = handles.find(handle => lib.heif_image_handle_is_primary_image(handle) !== 0);
    check(image, "HEICの主画像を取得できません");
    const width = lib.heif_image_handle_get_width(image), height = lib.heif_image_handle_get_height(image);
    check(Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
      width > 0 && height > 0 && width * height <= 40_000_000,
    "画像の寸法が不正か、1画像40メガピクセルの上限を超えています");
    check(width * height <= (limits.maxPixels ?? 40_000_000),
      "Undo用の画像を含む合計80メガピクセルの上限を超えています");
    check((limits.width === undefined || width === limits.width) &&
      (limits.height === undefined || height === limits.height), "画像ヘッダーの寸法と保存寸法が一致しません");
    return { lib, image, width, height, close };
  } catch (error) { close(); throw error; }
}

export function codecDimensions(data: Uint8Array, lib: HeifLibrary): { width: number; height: number } {
  const image = openHeic(data, lib);
  try { return { width: image.width, height: image.height }; }
  finally { image.close(); }
}

export async function codecPixels(data: Uint8Array, signal: AbortSignal, lib: HeifLibrary,
  limits: HeicLimits = {}): Promise<HeicPixels> {
  signal.throwIfAborted();
  const opened = openHeic(data, lib, limits);
  try {
    signal.throwIfAborted();
    const decoded = await opened.lib.heif_js_decode_image2(opened.image,
      opened.lib.heif_colorspace_RGB, opened.lib.heif_chroma_interleaved_RGBA);
    check(!("code" in decoded), `HEICを展開できません: ${"message" in decoded ? decoded.message : ""}`);
    try {
      signal.throwIfAborted();
      const plane = decoded.channels.find(channel => channel.id === opened.lib.heif_channel_interleaved);
      check(plane && plane.width === opened.width && plane.height === opened.height &&
        plane.stride >= plane.width * 4 && plane.data.length >= plane.stride * plane.height,
      "HEICの展開寸法またはRGBAデータが不正です");
      const rgba = new Uint8ClampedArray(opened.width * opened.height * 4);
      for (let y = 0; y < plane.height; y++)
        rgba.set(plane.data.subarray(y * plane.stride, y * plane.stride + plane.width * 4), y * plane.width * 4);
      return { width: plane.width, height: plane.height, data: rgba };
    } finally { opened.lib.heif_image_release(decoded.image); }
  } finally { opened.close(); }
}
