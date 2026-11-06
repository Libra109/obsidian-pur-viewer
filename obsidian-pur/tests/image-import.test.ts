import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { imageDimensions, importImage } from "../src/image-import";
import { parsePur } from "../src/parser";
import { animatedWebp, bmpFixture, gifFixture } from "./raster-fixtures";

const fixture = new Uint8Array(readFileSync(new URL(
  "../../crates/purcore/tests/fixtures/S1_redbar-new.pur", import.meta.url)));

test("PNG and JPEG headers validate exact dimensions and reject oversized or unsupported images before decoding", async () => {
  const png = (await parsePur(fixture)).images[0].data;
  assert.deepEqual(imageDimensions(png), { width: 64, height: 48, mime: "image/png" });
  const jpeg = new Uint8Array([255, 216, 255, 224, 0, 4, 0, 0,
    255, 192, 0, 11, 8, 0, 48, 0, 64, 1, 1, 17, 0]);
  assert.deepEqual(imageDimensions(jpeg), { width: 64, height: 48, mime: "image/jpeg" });
  for (const bytes of [new Uint8Array(), new TextEncoder().encode("<svg/>"),
    new TextEncoder().encode("GIF89a"), png.slice(0, 24), jpeg.slice(0, 15)])
    assert.throws(() => imageDimensions(bytes));
  const huge = png.slice();
  const view = new DataView(huge.buffer);
  view.setUint32(16, 10000); view.setUint32(20, 4001);
  assert.throws(() => imageDimensions(huge), /40メガピクセル/);
  view.setUint32(20, 4000);
  assert.equal(imageDimensions(huge).width, 10000);
});

test("GIF, WebP and BMP dimensions are checked before decoding including animation canvases and top-down BMP", () => {
  for (const data of [gifFixture(), gifFixture(true), bmpFixture(), bmpFixture(true), bmpFixture(false, true)]) {
    const dimensions = imageDimensions(data);
    assert.equal(dimensions.width, 3); assert.equal(dimensions.height, 2);
  }
  const webp = animatedWebp([]);
  assert.deepEqual(imageDimensions(webp), { width: 3, height: 2, mime: "image/webp" });
  for (const type of ["VP8L", "VP8 "]) {
    const bytes = new Uint8Array(type === "VP8L" ? 26 : 30);
    bytes.set(new TextEncoder().encode("RIFF"));
    const view = new DataView(bytes.buffer);
    view.setUint32(4, bytes.length - 8, true);
    bytes.set(new TextEncoder().encode("WEBP"), 8);
    bytes.set(new TextEncoder().encode(type), 12);
    view.setUint32(16, type === "VP8L" ? 5 : 10, true);
    if (type === "VP8L") {
      bytes[20] = 0x2f; view.setUint32(21, 2 | (1 << 14), true);
    } else {
      bytes.set([0x9d, 1, 0x2a], 23);
      view.setUint16(26, 3, true); view.setUint16(28, 2, true);
    }
    assert.deepEqual(imageDimensions(bytes), { width: 3, height: 2, mime: "image/webp" });
  }
  const huge = webp.slice();
  huge.set([255, 255, 255], 24); huge.set([255, 255, 255], 27);
  assert.throws(() => imageDimensions(huge), /40メガピクセル/);
  const hugeGif = gifFixture();
  new DataView(hugeGif.buffer).setUint16(6, 65535, true);
  new DataView(hugeGif.buffer).setUint16(8, 65535, true);
  assert.throws(() => imageDimensions(hugeGif), /40メガピクセル/);
  const hugeBmp = bmpFixture();
  new DataView(hugeBmp.buffer).setInt32(18, 100000, true);
  new DataView(hugeBmp.buffer).setInt32(22, -100000, true);
  assert.throws(() => imageDimensions(hugeBmp), /40メガピクセル/);
  for (const data of [gifFixture().slice(0, 8), webp.slice(0, 25), bmpFixture().slice(0, 30)])
    assert.throws(() => imageDimensions(data));
});

test("imports preserve original raster bytes and refuse limits, cancellation and unsupported decoders", async () => {
  const original = globalThis.createImageBitmap;
  let closed = 0;
  globalThis.createImageBitmap = (async () =>
    ({ width: 3, height: 2, close() { closed++; } } as ImageBitmap)) as typeof createImageBitmap;
  try {
    for (const data of [gifFixture(), animatedWebp([]), bmpFixture()])
      await assert.rejects(importImage(data, { x: 0, y: 0 }, 80_000_000,
        new AbortController().signal), /80メガピクセル/);
    assert.equal(closed, 0, "aggregate limits refuse all new formats before decoding");
    for (const data of [gifFixture(), gifFixture(true), animatedWebp([]), bmpFixture(), bmpFixture(true)]) {
      const before = data.slice();
      const result = await importImage(data, { x: 0, y: 0 }, 0, new AbortController().signal);
      assert.deepEqual(result.content.data, before);
      assert.equal(result.content.mime, imageDimensions(data).mime);
      assert.deepEqual(data, before);
      result.bitmap.close();
    }
    assert.equal(closed, 5);
    const controller = new AbortController();
    globalThis.createImageBitmap = (async () => {
      controller.abort();
      return { width: 3, height: 2, close() { closed++; } } as ImageBitmap;
    }) as typeof createImageBitmap;
    await assert.rejects(importImage(gifFixture(), { x: 0, y: 0 }, 0, controller.signal), { name: "AbortError" });
    assert.equal(closed, 6);
    await assert.rejects(importImage(new Uint8Array(64 * 1024 * 1024 + 1),
      { x: 0, y: 0 }, 0, new AbortController().signal), /64 MiB/);
    globalThis.createImageBitmap = (async () => { throw new Error("unsupported codec"); }) as typeof createImageBitmap;
    await assert.rejects(importImage(bmpFixture(), { x: 0, y: 0 }, 0,
      new AbortController().signal), /image\/bmp.*端末.*unsupported codec/);
  } finally { globalThis.createImageBitmap = original; }
});

test("imports center the native-size image and release bitmap on cancellation or dimension mismatch", async () => {
  const data = (await parsePur(fixture)).images[0].data;
  const original = globalThis.createImageBitmap;
  let closed = 0, calls = 0;
  try {
    globalThis.createImageBitmap = (async () => {
      calls++;
      return { width: 64, height: 48, close() { closed++; } } as ImageBitmap;
    }) as typeof createImageBitmap;
    const result = await importImage(data, { x: 200, y: 300 }, 0, new AbortController().signal);
    assert.deepEqual(result.content.item, [1, 0, 0, 1, 200, 300]);
    assert.deepEqual(result.content.image, [1, 0, 0, 1, -32, -24]);
    assert.equal(result.content.clip?.elements.length, 5);
    result.bitmap.close();
    await assert.rejects(importImage(data, { x: 0, y: 0 }, 80_000_000, new AbortController().signal), /80メガピクセル/);
    assert.equal(calls, 1, "aggregate limits are checked before allocating a bitmap");
    const controller = new AbortController();
    globalThis.createImageBitmap = (async () => {
      controller.abort();
      return { width: 64, height: 48, close() { closed++; } } as ImageBitmap;
    }) as typeof createImageBitmap;
    await assert.rejects(importImage(data, { x: 0, y: 0 }, 0, controller.signal), { name: "AbortError" });
    assert.equal(closed, 2);
    globalThis.createImageBitmap = (async () =>
      ({ width: 65, height: 48, close() { closed++; } } as ImageBitmap)) as typeof createImageBitmap;
    await assert.rejects(importImage(data, { x: 0, y: 0 }, 0, new AbortController().signal), /実寸/);
    assert.equal(closed, 3);
  } finally { globalThis.createImageBitmap = original; }
});
