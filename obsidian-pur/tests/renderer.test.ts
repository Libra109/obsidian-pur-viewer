import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BoardImage, boardBounds, IDENTITY } from "../src/board";
import { decodeClip } from "../src/codecs";
import { Camera, gesturePoints } from "../src/camera";
import { parsePur } from "../src/parser";
import { decodeImages, drawBoard } from "../src/renderer";

test("real pur image reaches Canvas draw with item transform, clip, image transform in order", async () => {
  const bytes = new Uint8Array(readFileSync(new URL("../../crates/purcore/tests/fixtures/S1_redbar-new.pur", import.meta.url)));
  const board = await parsePur(bytes);
  const operations: unknown[][] = [];
  const context = new Proxy({}, {
    get: (_, name) => (...args: unknown[]) => { operations.push([name, ...args]); },
    set: (_, name, value) => { operations.push([name, value]); return true; },
  }) as CanvasRenderingContext2D;
  const bitmap = { width: 64, height: 48, close() {} } as ImageBitmap;
  const camera = new Camera();
  camera.fit(boardBounds(board.images), 1048, 798);
  drawBoard(context, [{ image: board.images[0], bitmap }], camera);
  assert.deepEqual(operations.filter(o => o[0] === "transform"), [
    ["transform", 15.625, 0, 0, 15.625, 500, 375],
    ["transform", 1, 0, 0, 1, -32, -24],
  ]);
  assert.deepEqual(operations.find(o => o[0] === "drawImage"), ["drawImage", bitmap, 0, 0, 64, 48]);
  assert.deepEqual(operations.find(o => o[0] === "clip"), ["clip", "evenodd"]);
  const clipIndex = operations.findIndex(o => o[0] === "clip");
  const imageTransformIndex = operations.findIndex(o => o[0] === "transform" && o[5] === -32);
  assert.ok(clipIndex < imageTransformIndex);
  assert.equal(operations.filter(o => o[0] === "save").length,
    operations.filter(o => o[0] === "restore").length);
});

test("fit, cursor-pinned zoom, one-finger pan and two-finger pinch preserve coordinates", () => {
  const camera = new Camera();
  camera.fit({ x: 0, y: 0, width: 1000, height: 750 }, 1048, 798);
  assert.equal(camera.scale, 1);
  assert.equal(camera.x, 24);
  assert.equal(camera.y, 24);
  const from = gesturePoints([{ x: 100, y: 100 }]);
  const to = gesturePoints([{ x: 150, y: 120 }]);
  camera.gesture(from.center, to.center, 1);
  assert.equal(camera.x, 74);
  assert.equal(camera.y, 44);
  const anchor = { x: 250, y: 150 };
  const world = { x: (anchor.x - camera.x) / camera.scale, y: (anchor.y - camera.y) / camera.scale };
  camera.gesture(anchor, anchor, 2);
  assert.equal(world.x * camera.scale + camera.x, anchor.x);
  assert.equal(world.y * camera.scale + camera.y, anchor.y);
  const before = gesturePoints([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  const after = gesturePoints([{ x: 25, y: 25 }, { x: 225, y: 25 }]);
  const wx = (before.center.x - camera.x) / camera.scale;
  camera.gesture(before.center, after.center, after.distance / before.distance);
  assert.equal(camera.scale, 4);
  assert.equal(wx * camera.scale + camera.x, after.center.x);
  camera.gesture(anchor, anchor, 1e99);
  assert.equal(camera.scale, 64);
  camera.gesture(anchor, anchor, 1e-99);
  assert.equal(camera.scale, 0.000001);
});

test("Qt cubic clipping paths decode and reach Canvas with winding rule and opacity", () => {
  const name = "QPainterPath";
  const bytes = new Uint8Array(9 + name.length + 1 + 4 + 4 * 20 + 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1024);
  view.setUint32(5, name.length + 1);
  bytes.set(new TextEncoder().encode(name), 9);
  let pos = 9 + name.length + 1;
  view.setUint32(pos, 4); pos += 4;
  for (const [type, x, y] of [[0, 0, 0], [2, 10, 0], [3, 20, 10], [3, 30, 30]]) {
    view.setInt32(pos, type); view.setFloat64(pos + 4, x); view.setFloat64(pos + 12, y); pos += 20;
  }
  view.setInt32(pos, 0); view.setInt32(pos + 4, 1);
  const clip = decodeClip(bytes);
  assert.equal(clip?.fillRule, "nonzero");
  const image: BoardImage = {
    id: 1, data: new Uint8Array(), mime: "image/png", width: 30, height: 30,
    item: [...IDENTITY], image: [...IDENTITY], opacity: 0.3, z: 0, clip,
  };
  const operations: unknown[][] = [];
  const context = new Proxy({}, {
    get: (_, name) => (...args: unknown[]) => { operations.push([name, ...args]); },
    set: (_, name, value) => { operations.push([name, value]); return true; },
  }) as CanvasRenderingContext2D;
  drawBoard(context, [{ image, bitmap: {} as ImageBitmap }], new Camera());
  assert.ok(operations.some(o => o[0] === "globalAlpha" && o[1] === 0.3));
  assert.deepEqual(operations.find(o => o[0] === "bezierCurveTo"), ["bezierCurveTo", 10, 0, 20, 10, 30, 30]);
  assert.deepEqual(operations.find(o => o[0] === "clip"), ["clip", "nonzero"]);
  view.setInt32(9 + name.length + 1 + 4 + 2 * 20, 1);
  assert.throws(() => decodeClip(bytes), /制御点/);
});

test("decoder releases already decoded images on failure and cancellation", async () => {
  const board = await parsePur(new Uint8Array(readFileSync(
    new URL("../../crates/purcore/tests/fixtures/S1_redbar-new.pur", import.meta.url))));
  const original = globalThis.createImageBitmap;
  let closed = 0, calls = 0;
  try {
    globalThis.createImageBitmap = (async () => {
      if (++calls === 2) throw new Error("invalid image");
      return { width: 64, height: 48, close() { closed++; } } as ImageBitmap;
    }) as typeof createImageBitmap;
    await assert.rejects(decodeImages([board.images[0], board.images[0]], new AbortController().signal), /invalid image/);
    assert.equal(closed, 1);
    const controller = new AbortController();
    globalThis.createImageBitmap = (async () => {
      controller.abort();
      return { width: 64, height: 48, close() { closed++; } } as ImageBitmap;
    }) as typeof createImageBitmap;
    await assert.rejects(decodeImages(board.images, controller.signal), { name: "AbortError" });
    assert.equal(closed, 2);
  } finally { globalThis.createImageBitmap = original; }
});
