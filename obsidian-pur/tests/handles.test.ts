import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardImage, Matrix, multiply, transform } from "../src/board";
import {
  flipItem, imageCenter, imageHandles, resizeCursor, resizeFromHandle, rotateMatrixAboutPoint, rotationHandles,
} from "../src/handles";

test("all eight handles scale uniformly around the opposite handle, preserving affine geometry", () => {
  for (const item of [
    [1, 0, 0, 1, 30, -10], [0, 2, -2, 0, 5, 6], [-2, 0, 0, 2, 12, 16], [1, 0.3, 0.5, 2, -7, 9],
  ] as Matrix[]) {
    const image: BoardImage = {
      id: 1, width: 64, height: 48, item, image: [0.8, 0.2, -0.1, 0.9, 3, 4],
      data: new Uint8Array(), mime: "image/png", opacity: 1, z: 0,
    };
    const handles = imageHandles(image);
    assert.equal(handles.length, 8);
    for (let i = 0; i < 8; i++) {
      const handle = handles[i], anchor = handles[(i + 4) % 8];
      const vector = { x: handle.x - anchor.x, y: handle.y - anchor.y };
      const start = { x: handle.x + 7, y: handle.y - 5 };
      assert.deepEqual(resizeFromHandle(item, anchor, vector, start, start), item, "off-center hit must not jump");
      for (const factor of [0.5, 1.5, 2]) {
        const current = { x: start.x + vector.x * (factor - 1), y: start.y + vector.y * (factor - 1) };
        const resized = resizeFromHandle(item, anchor, vector, start, current);
        const after = imageHandles({ ...image, item: resized });
        const fixed = after[(i + 4) % 8];
        assert.ok(Math.hypot(fixed.x - anchor.x, fixed.y - anchor.y) < 1e-10);
        for (let j = 0; j < 4; j++) assert.ok(Math.abs(resized[j] - item[j] * factor) < 1e-10);
        assert.ok(Math.abs(after[i].x - anchor.x - vector.x * factor) < 1e-10);
        assert.ok(Math.abs(after[i].y - anchor.y - vector.y * factor) < 1e-10);
      }
      const crossed = resizeFromHandle(item, anchor, vector, start,
        { x: start.x - 3 * vector.x, y: start.y - 3 * vector.y });
      assert.ok(Math.sign(crossed[0] * crossed[3] - crossed[1] * crossed[2]) ===
        Math.sign(item[0] * item[3] - item[1] * item[2]), "crossing the anchor must not flip or collapse the image");
      const perpendicular = resizeFromHandle(item, anchor, vector, start,
        { x: start.x - vector.y, y: start.y + vector.x });
      perpendicular.forEach((value, j) => assert.ok(Math.abs(value - item[j]) < 1e-10));
    }
  }
});

test("rotation preserves the image center and turns all transformed corners in board coordinates", () => {
  const image: BoardImage = {
    id: 1, width: 64, height: 48, item: [1, 0.3, 0.5, 2, -7, 9],
    image: [0.8, 0.2, -0.1, 0.9, 3, 4], data: new Uint8Array(), mime: "image/png", opacity: 1, z: 0,
  };
  const before = [...image.item] as Matrix;
  const center = imageCenter(image);
  const originalCorners = imageHandles(image);
  const rotated = rotateMatrixAboutPoint(before, center, Math.PI / 2);
  const updated = { ...image, item: rotated };
  const afterCorners = imageHandles(updated);
  const afterCenter = imageCenter(updated);
  assert.ok(Math.hypot(center.x - afterCenter.x, center.y - afterCenter.y) < 1e-10);
  for (let index = 0; index < originalCorners.length; index++) {
    const old = originalCorners[index];
    const expected = { x: center.x - (old.y - center.y), y: center.y + (old.x - center.x) };
    assert.ok(Math.hypot(expected.x - afterCorners[index].x, expected.y - afterCorners[index].y) < 1e-10);
  }
  const rotations = rotationHandles(updated, 20);
  assert.equal(rotations.length, 4);
  for (let index = 0; index < rotations.length; index++)
    assert.ok(Math.hypot(rotations[index].x - afterCorners[index * 2].x,
      rotations[index].y - afterCorners[index * 2].y) > 19.99);
});

test("resize cursors follow the transformed handle direction", () => {
  const image: BoardImage = {
    id: 1, width: 64, height: 48, item: [1, 0, 0, 1, 0, 0],
    image: [1, 0, 0, 1, 0, 0], data: new Uint8Array(), mime: "image/png", opacity: 1, z: 0,
  };
  assert.equal(resizeCursor(image, 0), "nwse-resize");
  assert.equal(resizeCursor(image, 1), "ns-resize");
  assert.equal(resizeCursor(image, 2), "nesw-resize");
  assert.equal(resizeCursor(image, 3), "ew-resize");
  image.item = [0, 1, -1, 0, 48, 0];
  assert.equal(resizeCursor(image, 0), "nesw-resize");
  assert.equal(resizeCursor(image, 1), "ew-resize");
});

test("horizontal and vertical flips keep the image center fixed and flip its source-local axes", () => {
  const image: BoardImage = {
    id: 1, width: 64, height: 48, item: [0, 2, -2, 0, 5, 6],
    image: [0.8, 0.2, -0.1, 0.9, 3, 4], data: new Uint8Array(), mime: "image/png", opacity: 1, z: 0,
  };
  const center = imageCenter(image);
  const horizontal = { ...image, item: flipItem(image, "horizontal") };
  const vertical = { ...image, item: flipItem(image, "vertical") };
  for (const flipped of [horizontal, vertical]) {
    const point = imageCenter(flipped);
    assert.ok(Math.hypot(center.x - point.x, center.y - point.y) < 1e-10);
  }
  const horizontalComposite = multiply(horizontal.item, image.image);
  const verticalComposite = multiply(vertical.item, image.image);
  const right = transform(multiply(image.item, image.image), { x: image.width, y: image.height / 2 });
  const left = transform(multiply(image.item, image.image), { x: 0, y: image.height / 2 });
  const flippedRight = transform(horizontalComposite, { x: image.width, y: image.height / 2 });
  const flippedLeft = transform(horizontalComposite, { x: 0, y: image.height / 2 });
  assert.ok(Math.hypot(flippedRight.x - left.x, flippedRight.y - left.y) < 1e-10);
  assert.ok(Math.hypot(flippedLeft.x - right.x, flippedLeft.y - right.y) < 1e-10);
  const top = transform(multiply(image.item, image.image), { x: image.width / 2, y: 0 });
  const bottom = transform(multiply(image.item, image.image), { x: image.width / 2, y: image.height });
  const flippedTop = transform(verticalComposite, { x: image.width / 2, y: 0 });
  const flippedBottom = transform(verticalComposite, { x: image.width / 2, y: image.height });
  assert.ok(Math.hypot(flippedTop.x - bottom.x, flippedTop.y - bottom.y) < 1e-10);
  assert.ok(Math.hypot(flippedBottom.x - top.x, flippedBottom.y - top.y) < 1e-10);
});
