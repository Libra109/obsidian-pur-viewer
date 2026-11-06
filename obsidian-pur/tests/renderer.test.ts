import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BoardImage, boardBounds, IDENTITY } from "../src/board";
import { decodeClip } from "../src/codecs";
import { Camera, gesturePoints } from "../src/camera";
import { parsePur } from "../src/parser";
import { BoardRenderer, decodeImages, drawBoard } from "../src/renderer";
import { BoardEditor } from "../src/editor";
import { imageCenter, imageHandles, resizeCursor, resizeFromHandle,
  rotateMatrixAboutPoint, rotationHandles, selectionFrame } from "../src/handles";

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

test("canvas modifier selection, group drag, camera gestures and single-selection transforms do not interfere", () => {
  const oldObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const first: BoardImage = { id: 1, data: new Uint8Array(), mime: "image/png", width: 100, height: 100,
    item: [...IDENTITY], image: [...IDENTITY], z: 0, opacity: 1 };
  const second: BoardImage = { ...first, id: 2, item: [1, 0, 0, 1, 200, 150], z: 1 };
  const editor = new BoardEditor([first, second]);
  let draws = 0, arcs = 0;
  class CanvasStub extends EventTarget {
    clientWidth = 640;
    clientHeight = 480;
    width = 640;
    height = 480;
    style = { cursor: "" };
    ownerDocument = { defaultView: {
      devicePixelRatio: 1, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    } };
    focus() {}
    setPointerCapture() {}
    getBoundingClientRect() { return { left: 0, top: 0 }; }
    getContext() { return new Proxy({}, { get: (_, name) => () => {
      if (name === "drawImage") draws++;
      if (name === "arc") arcs++;
    } }); }
  }
  const canvas = new CanvasStub();
  const renderer = new BoardRenderer(canvas as unknown as HTMLCanvasElement,
    [first, second].map(image => ({ image, bitmap: { close() {} } as ImageBitmap })),
    boardBounds(editor.images), editor, () => {}, error => { throw error; }, () => true);
  const send = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, pointerType: "mouse", button: 0,
      clientX: x * renderer.camera.scale + renderer.camera.x,
      clientY: y * renderer.camera.scale + renderer.camera.y, ...extra });
    canvas.dispatchEvent(event);
    return event;
  };
  const click = (x: number, y: number, extra: Record<string, unknown> = {}) => {
    send("pointerdown", x, y, extra); send("pointerup", x, y, extra);
  };
  try {
    renderer.setEditMode(true);
    click(50, 50, { ctrlKey: true });
    click(250, 200, { metaKey: true });
    assert.deepEqual(editor.selectedImages, [first, second]);
    assert.equal(editor.canUndo, false, "modifier selection never promotes");
    assert.equal(renderer.canTransformSelected, false);
    assert.equal(renderer.canAlignSelected, true);
    click(50, 50);
    assert.equal(editor.selectedImages.length, 2, "plain click on the group keeps it selected");
    assert.equal(editor.canUndo, false);
    const before = editor.snapshot();
    send("pointerdown", 50, 50);
    send("pointermove", 70, 80);
    send("pointerup", 70, 80);
    assert.ok(Math.abs(first.item[4] - 20) < 1e-9);
    assert.ok(Math.abs(second.item[4] - 220) < 1e-9);
    assert.equal(second.item[5] - first.item[5], 150);
    renderer.undo();
    assert.deepEqual(editor.snapshot(), before);
    assert.equal(editor.canUndo, false);
    renderer.redo();
    renderer.undo();
    send("pointerdown", 50, 50, { pointerType: "touch" });
    send("pointerdown", 250, 200, { pointerId: 2, pointerType: "touch" });
    send("pointermove", 270, 220, { pointerId: 2, pointerType: "touch" });
    send("pointerup", 270, 220, { pointerId: 2, pointerType: "touch" });
    send("pointerup", 50, 50, { pointerType: "touch" });
    assert.deepEqual(editor.snapshot(), before);
    assert.equal(editor.selectedImages.length, 2);
    renderer.alignSelected("left");
    assert.equal(second.item[4], first.item[4]);
    renderer.undo();
    click(50, 50, { ctrlKey: true });
    assert.equal(editor.selectedId, second.id);
    assert.equal(renderer.canAlignSelected, false);
    assert.equal(renderer.canTransformSelected, true);
    const single = editor.snapshot();
    renderer.alignSelected("right");
    assert.deepEqual(editor.snapshot(), single);
    click(50, 50);
    assert.equal(editor.selectedId, first.id, "plain click on an unselected image replaces selection");
    assert.ok(first.z > second.z, "ordinary single selection still promotes");
    renderer.undo();
    click(-100, -100);
    assert.equal(editor.selectedImages.length, 0);
    click(50, 50, { metaKey: true });
    const escape = new Event("keydown", { cancelable: true });
    Object.assign(escape, { key: "Escape" });
    canvas.dispatchEvent(escape);
    assert.equal(editor.selectedImages.length, 0);
    const clean = editor.snapshot();
    const cameraBefore = { x: renderer.camera.x, y: renderer.camera.y };
    send("pointerdown", -20, -20, { shiftKey: true });
    send("pointermove", 1, 1, { shiftKey: true });
    assert.equal(editor.selectedImages.length, 0, "selection applies on release only");
    send("pointerup", 1, 1, { shiftKey: true });
    assert.equal(editor.selectedId, first.id, "partial overlap selects, not only full containment");
    assert.deepEqual({ x: renderer.camera.x, y: renderer.camera.y }, cameraBefore);
    assert.deepEqual(editor.snapshot(), clean);
    send("pointerdown", 350, 300, { shiftKey: true });
    send("pointermove", 250, 200, { shiftKey: true });
    send("pointerup", 250, 200, { shiftKey: true });
    assert.equal(editor.selectedId, second.id, "reverse marquee replaces the previous selection");
    send("pointerdown", -20, -20, { shiftKey: true });
    send("pointermove", 400, 400, { shiftKey: true });
    send("pointercancel", 400, 400, { shiftKey: true });
    assert.equal(editor.selectedId, second.id, "cancel leaves the original selection intact");
    send("pointerdown", -20, -20, { shiftKey: true });
    send("pointerdown", 400, 400, { pointerId: 2, pointerType: "touch" });
    send("pointerup", 400, 400, { pointerId: 2, pointerType: "touch" });
    send("pointerup", -20, -20, { shiftKey: true });
    assert.equal(editor.selectedId, second.id, "second pointer aborts marquee without replacing selection");
    send("pointerdown", -20, -20, { shiftKey: true });
    send("pointermove", 400, 400, { shiftKey: true });
    send("pointerup", 400, 400, { shiftKey: true });
    assert.equal(editor.selectedImages.length, 2);
    assert.equal(editor.dirty, false);
    assert.equal(editor.canUndo, false);

    first.item = [0, 2, -1, 0.3, -100, 50];
    first.image = [0.8, 0.2, -0.1, 0.9, 3, 4];
    second.item = [-1, 0.2, 0.4, 1, 200, -100];
    second.image = [1, 0.1, -0.2, 1, -50, -50];
    editor.acceptSaved(editor.snapshot());
    const group = editor.snapshot();
    const initialHandles = imageHandles(selectionFrame(editor.selectedImages)!);
    for (const start of [initialHandles[0], rotationHandles(selectionFrame(editor.selectedImages)!,
      20 / renderer.camera.scale)[0]]) {
      send("pointerdown", start.x, start.y, { pointerType: "touch" });
      send("pointerdown", 300, 300, { pointerId: 2, pointerType: "touch" });
      send("pointermove", 320, 320, { pointerId: 2, pointerType: "touch" });
      send("pointerup", 320, 320, { pointerId: 2, pointerType: "touch" });
      send("pointerup", start.x, start.y, { pointerType: "touch" });
      assert.deepEqual(editor.snapshot(), group, "second pointer on a transform handle switches to camera only");
      assert.equal(editor.canUndo, false);
    }
    for (let index = 0; index < 8; index++) {
      const frame = selectionFrame(editor.selectedImages)!;
      const handles = imageHandles(frame), start = handles[index], anchor = handles[(index + 4) % 8];
      const vector = { x: start.x - anchor.x, y: start.y - anchor.y };
      const end = { x: start.x + vector.x / 2, y: start.y + vector.y / 2 };
      send("pointerdown", start.x, start.y);
      const previousDraws = draws;
      arcs = 0;
      send("pointermove", end.x, end.y);
      assert.equal(draws - previousDraws, 2, "every group pointermove repaints all images immediately");
      assert.equal(arcs, 8, "one common frame draws exactly eight resize handles");
      send("pointerup", end.x, end.y);
      const resized = editor.snapshot();
      group.forEach(before => {
        const actual = resized.find(entry => entry.id === before.id)!;
        const expected = resizeFromHandle(before.item, anchor, vector, start, end);
        actual.item.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-8));
        assert.deepEqual(actual.content.image, before.content.image);
        assert.equal(actual.z, before.z);
      });
      renderer.undo();
      assert.deepEqual(editor.snapshot(), group);
      assert.equal(editor.canUndo, false);
      renderer.redo();
      assert.deepEqual(editor.snapshot(), resized);
      renderer.undo();
    }
    const frame = selectionFrame(editor.selectedImages)!, center = imageCenter(frame);
    const start = rotationHandles(frame, 20 / renderer.camera.scale)[0];
    const angle = 0.7;
    const end = { x: center.x + Math.cos(angle) * (start.x - center.x) - Math.sin(angle) * (start.y - center.y),
      y: center.y + Math.sin(angle) * (start.x - center.x) + Math.cos(angle) * (start.y - center.y) };
    send("pointerdown", start.x, start.y);
    const rotateDraws = draws;
    arcs = 0;
    send("pointermove", end.x, end.y);
    assert.equal(draws - rotateDraws, 2);
    assert.equal(arcs, 8, "rotation does not draw rotation handles");
    send("pointerup", end.x, end.y);
    const rotated = editor.snapshot();
    group.forEach(before => {
      const actual = rotated.find(entry => entry.id === before.id)!;
      const expected = rotateMatrixAboutPoint(before.item, center, angle);
      actual.item.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-8));
      assert.deepEqual(actual.content.image, before.content.image);
    });
    const orientedFrame = { ...frame, item: rotateMatrixAboutPoint(frame.item, center, angle) };
    const orientedHandle = imageHandles(orientedFrame)[1];
    send("pointermove", orientedHandle.x, orientedHandle.y);
    assert.equal(canvas.style.cursor, resizeCursor(orientedFrame, 1), "hover follows the rotated common frame");
    const orientedAnchor = imageHandles(orientedFrame)[5];
    send("pointerdown", orientedHandle.x, orientedHandle.y);
    const vector = { x: orientedHandle.x - orientedAnchor.x, y: orientedHandle.y - orientedAnchor.y };
    const resizeEnd = { x: orientedHandle.x + vector.x / 2, y: orientedHandle.y + vector.y / 2 };
    send("pointermove", resizeEnd.x, resizeEnd.y);
    send("pointerup", resizeEnd.x, resizeEnd.y);
    editor.snapshot().forEach(actual => {
      const before = rotated.find(entry => entry.id === actual.id)!;
      const expected = resizeFromHandle(before.item, orientedAnchor, vector, orientedHandle, resizeEnd);
      actual.item.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-8,
        "hit-testing uses the same oriented frame that is drawn"));
    });
    renderer.undo();
    assert.deepEqual(editor.snapshot(), rotated);
    renderer.undo();
    assert.deepEqual(editor.snapshot(), group);
    assert.equal(editor.canUndo, false);
    renderer.redo();
    assert.deepEqual(editor.snapshot(), rotated);
    renderer.undo();
    renderer.rotateSelected(Math.PI / 2);
    const menuRotated = editor.snapshot();
    group.forEach(before => {
      const expected = rotateMatrixAboutPoint(before.item, center, Math.PI / 2);
      menuRotated.find(actual => actual.id === before.id)!.item.forEach((value, i) =>
        assert.ok(Math.abs(value - expected[i]) < 1e-8));
    });
    renderer.undo();
    assert.deepEqual(editor.snapshot(), group);
    renderer.redo();
    assert.deepEqual(editor.snapshot(), menuRotated);
    renderer.undo();
    renderer.setEditMode(false);
    const readOnlySelection = editor.selectedImages.map(image => image.id);
    click(50, 50, { ctrlKey: true });
    send("pointerdown", -500, -500, { shiftKey: true });
    send("pointermove", 500, 500, { shiftKey: true });
    send("pointerup", 500, 500, { shiftKey: true });
    assert.deepEqual(editor.selectedImages.map(image => image.id), readOnlySelection);
    assert.equal(renderer.canAlignSelected, false);
  } finally {
    renderer.dispose();
    globalThis.ResizeObserver = oldObserver;
  }
});
