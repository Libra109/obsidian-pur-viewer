import { BoardImage, invert, Matrix, multiply, Point, transform } from "./board";
import { check } from "./binary";

const POSITIONS: Point[] = [
  { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 },
  { x: 1, y: 1 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0.5 },
];

export function imageHandles(image: BoardImage): Point[] {
  const matrix = multiply(image.item, image.image);
  return POSITIONS.map(point => transform(matrix, { x: point.x * image.width, y: point.y * image.height }));
}

export function imageCenter(image: BoardImage): Point {
  return transform(multiply(image.item, image.image), { x: image.width / 2, y: image.height / 2 });
}

export function resizeCursor(image: BoardImage, index: number): string {
  const handles = imageHandles(image);
  const handle = handles[index];
  const anchor = handles[(index + 4) % 8];
  check(handle && anchor, "拡縮ハンドルの位置が不正です");
  let angle = Math.atan2(handle.y - anchor.y, handle.x - anchor.x) % Math.PI;
  if (angle < 0) angle += Math.PI;
  const direction = Math.round(angle / (Math.PI / 4)) % 4;
  return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][direction];
}

export function rotationHandles(image: BoardImage, offset: number): Point[] {
  const handles = imageHandles(image);
  const center = imageCenter(image);
  return [0, 2, 4, 6].map(index => {
    const corner = handles[index];
    const dx = corner.x - center.x, dy = corner.y - center.y;
    const length = Math.hypot(dx, dy);
    check(Number.isFinite(length) && length > 0, "回転ハンドルを配置できません");
    return { x: corner.x + dx / length * offset, y: corner.y + dy / length * offset };
  });
}

export function rotateMatrixAboutPoint(before: Matrix, center: Point, angle: number): Matrix {
  check(Number.isFinite(angle), "回転角度が不正です");
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const rotation: Matrix = [cos, sin, -sin, cos,
    center.x - cos * center.x + sin * center.y,
    center.y - sin * center.x - cos * center.y];
  const result = multiply(rotation, before);
  check(result.every(Number.isFinite), "回転後の画像座標が対応範囲を超えています");
  return result;
}

export function flipItem(image: BoardImage, axis: "horizontal" | "vertical"): Matrix {
  const inverseImage = invert(image.image);
  check(inverseImage, "画像の変換を反転できないため、反転を適用できません");
  const reflection: Matrix = axis === "horizontal"
    ? [-1, 0, 0, 1, image.width, 0]
    : [1, 0, 0, -1, 0, image.height];
  const result = multiply(multiply(multiply(image.item, image.image), reflection), inverseImage);
  check(result.every(Number.isFinite), "反転後の画像座標が対応範囲を超えています");
  return result;
}

export function resizeFromHandle(
  before: Matrix, anchor: Point, vector: Point, start: Point, current: Point,
): Matrix {
  const lengthSquared = vector.x * vector.x + vector.y * vector.y;
  if (!Number.isFinite(lengthSquared) || lengthSquared < 1e-20) return [...before];
  const factor = Math.min(20, Math.max(0.05, 1 +
    ((current.x - start.x) * vector.x + (current.y - start.y) * vector.y) / lengthSquared));
  if (!Number.isFinite(factor)) return [...before];
  return multiply([factor, 0, 0, factor, anchor.x * (1 - factor), anchor.y * (1 - factor)], before);
}
