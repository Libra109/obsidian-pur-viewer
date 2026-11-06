import assert from "node:assert/strict";
import { test } from "node:test";
import { imageMime } from "../src/board";
import { imageDimensions, importImage } from "../src/image-import";
import { svgDataUrl, svgDimensions } from "../src/svg";
import { svgFixture } from "./svg-fixtures";

test("SVG dimensions support pixels and viewBox without changing source bytes", () => {
  assert.equal(imageMime(svgFixture), "image/svg+xml");
  assert.deepEqual(imageDimensions(svgFixture), { width: 3, height: 2, mime: "image/svg+xml" });
  for (const [root, width, height] of [
    ['viewBox="0 0 49 49"', 49, 49],
    ['width="98" viewBox="0 0 49 49"', 98, 98],
    ['height="98px" viewBox="0 0 49 49"', 98, 98],
    ['width="3.5" height="2.1"', 4, 3],
  ] as const)
    assert.deepEqual(svgDimensions(new TextEncoder().encode(
      `<?xml version="1.0"?>\n<!--test--><svg xmlns="http://www.w3.org/2000/svg" ${root}></svg>`)),
    { width, height });
  for (const root of ['width="100%" height="2"', 'viewBox="0 0 0 2"',
    'width="10000" height="4001"', 'width="1e999" height="2"', 'width="2"', '']) {
    assert.throws(() => svgDimensions(new TextEncoder().encode(`<svg ${root}></svg>`)));
  }
  assert.throws(() => svgDimensions(new TextEncoder().encode('<!DOCTYPE svg><svg width="3" height="2"/>')));
});

test("SVG data URL decoding preserves exact bytes and rejects malformed encodings and other URLs", () => {
  const base64 = Buffer.from(svgFixture).toString("base64");
  assert.deepEqual(svgDataUrl(`data:image/svg+xml;base64,${base64}`), svgFixture);
  assert.deepEqual(svgDataUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    new TextDecoder().decode(svgFixture))}`), svgFixture);
  for (const text of ["https://example.invalid/a.svg", "data:image/png;base64,AAAA",
    "data:image/svg+xml;base64,@@@", "data:image/svg+xml,%GG", "data:image/svg+xml,abc",
    "data:image/svg+xml;charset=latin1,%00"])
    assert.throws(() => svgDataUrl(text));
});

test("SVG aggregate pixel limits and cancellation reject before allocating a decoder", async () => {
  await assert.rejects(importImage(svgFixture, { x: 0, y: 0 }, 80_000_000,
    new AbortController().signal), /80メガピクセル/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(importImage(svgFixture, { x: 0, y: 0 }, 0, controller.signal),
    { name: "AbortError" });
});
