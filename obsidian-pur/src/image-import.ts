import { check } from "./binary";
import { BoardImage, imageMime, Point } from "./board";
import { MAX_FILE_BYTES } from "./parser";
import { decodeSvg, svgDimensions } from "./svg";
import { decodeHeic, heicDimensions, heicPixels, heicBitmap } from "./heic";
import type { HeicLimits } from "./heic-codec";

export function imageDimensions(data: Uint8Array): { width: number; height: number; mime: string } {
  const mime = imageMime(data);
  check(mime, "対応する画像はPNG、JPEG、GIF、WebP、BMP、SVG、HEICです");
  if (mime === "image/svg+xml") return { ...svgDimensions(data), mime };
  if (mime === "image/heic" || mime === "image/heic-sequence") return { ...heicDimensions(data), mime };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let width = 0, height = 0;
  if (mime === "image/png") {
    check(data.length >= 33 && view.getUint32(8) === 13 &&
      new TextDecoder().decode(data.subarray(12, 16)) === "IHDR", "PNGのヘッダーが不正です");
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (mime === "image/gif") {
    check(data.length >= 13, "GIFのヘッダーが途切れています");
    width = view.getUint16(6, true); height = view.getUint16(8, true);
  } else if (mime === "image/bmp") {
    check(data.length >= 26, "BMPのヘッダーが途切れています");
    const header = view.getUint32(14, true);
    check([12, 40, 52, 56, 108, 124].includes(header), "BMPのヘッダー形式は未対応です");
    check(14 + header <= data.length && view.getUint32(10, true) >= 14 + header &&
      view.getUint32(10, true) < data.length, "BMPのヘッダーまたは画像データ位置が不正です");
    if (header === 12) {
      width = view.getUint16(18, true); height = view.getUint16(20, true);
    } else {
      width = view.getInt32(18, true); height = Math.abs(view.getInt32(22, true));
    }
  } else if (mime === "image/webp") {
    check(data.length >= 20 && view.getUint32(4, true) + 8 === data.length, "WebPのRIFF長が不正です");
    let pos = 12;
    while (pos + 8 <= data.length) {
      const type = new TextDecoder().decode(data.subarray(pos, pos + 4));
      const length = view.getUint32(pos + 4, true);
      const start = pos + 8;
      check(start + length <= data.length, "WebPのチャンクが途切れています");
      if (type === "VP8X") {
        check(length === 10, "WebPの拡張ヘッダーが不正です");
        width = 1 + data[start + 4] + (data[start + 5] << 8) + (data[start + 6] << 16);
        height = 1 + data[start + 7] + (data[start + 8] << 8) + (data[start + 9] << 16);
        break;
      }
      if (type === "VP8L") {
        check(length >= 5 && data[start] === 0x2f, "WebPの可逆ヘッダーが不正です");
        const bits = view.getUint32(start + 1, true);
        width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
        break;
      }
      if (type === "VP8 ") {
        check(length >= 10 && data[start + 3] === 0x9d && data[start + 4] === 1 &&
          data[start + 5] === 0x2a, "WebPの非可逆ヘッダーが不正です");
        width = view.getUint16(start + 6, true) & 0x3fff;
        height = view.getUint16(start + 8, true) & 0x3fff;
        break;
      }
      pos = start + length + (length & 1);
    }
  } else {
    let pos = 2;
    while (pos < data.length) {
      check(data[pos++] === 255, "JPEGのマーカーが不正です");
      while (data[pos] === 255) pos++;
      const marker = data[pos++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      check(pos + 2 <= data.length, "JPEGのヘッダーが途切れています");
      const length = view.getUint16(pos);
      check(length >= 2 && pos + length <= data.length, "JPEGのセグメント長が不正です");
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        check(length >= 8 && data[pos + 2] === 8, "このJPEGの符号化は未対応です");
        height = view.getUint16(pos + 3); width = view.getUint16(pos + 5);
        break;
      }
      pos += length;
    }
  }
  check(width > 0 && height > 0 && width * height <= 40_000_000,
    "画像の寸法が不正か、1画像40メガピクセルの上限を超えています");
  return { width, height, mime };
}

export async function decodeRaster(data: Uint8Array, mime: string, signal: AbortSignal,
  limits: HeicLimits = {}): Promise<ImageBitmap> {
  signal.throwIfAborted();
  if (mime === "image/svg+xml") return decodeSvg(data, signal);
  if (mime === "image/heic" || mime === "image/heic-sequence") return decodeHeic(data, signal, limits);
  let bitmap: ImageBitmap;
  try {
    // createImageBitmap selects the default (first) frame of an animated image.
    bitmap = await createImageBitmap(new Blob([Uint8Array.from(data)], { type: mime }),
      { imageOrientation: "none" });
  } catch (error) {
    throw new Error(`${mime}をこの端末の画像デコーダーで展開できません: ${
      error instanceof Error ? error.message : String(error)}`);
  }
  if (signal.aborted) { bitmap.close(); signal.throwIfAborted(); }
  return bitmap;
}

export async function importImage(data: Uint8Array, center: Point, retainedPixels: number,
  signal: AbortSignal):
  Promise<{ content: Omit<BoardImage, "id" | "z">; bitmap: ImageBitmap }> {
  signal.throwIfAborted();
  check(data.length <= MAX_FILE_BYTES, "64 MiBを超える画像は追加できません");
  const mime = imageMime(data);
  const heic = mime === "image/heic" || mime === "image/heic-sequence"
    ? await heicPixels(data, signal, { maxPixels: 80_000_000 - retainedPixels }) : undefined;
  const dimensions = heic ? { width: heic.width, height: heic.height, mime: mime! } : imageDimensions(data);
  check(retainedPixels + dimensions.width * dimensions.height <= 80_000_000,
    "Undo用の画像を含む合計80メガピクセルの上限を超えています");
  const bitmap = heic ? await heicBitmap(heic, signal) : await decodeRaster(data, dimensions.mime, signal);
  try {
    signal.throwIfAborted();
    check(bitmap.width === dimensions.width && bitmap.height === dimensions.height,
      "画像の実寸とヘッダーの寸法が一致しません");
    const x = -dimensions.width / 2, y = -dimensions.height / 2;
    return {
      bitmap,
      content: {
        ...dimensions, data, opacity: 1, item: [1, 0, 0, 1, center.x, center.y],
        image: [1, 0, 0, 1, x, y],
        clip: { fillRule: "evenodd", elements: [
          { type: 0, x, y }, { type: 1, x: -x, y }, { type: 1, x: -x, y: -y },
          { type: 1, x, y: -y }, { type: 1, x, y },
        ] },
      },
    };
  } catch (error) { bitmap.close(); throw error; }
}
