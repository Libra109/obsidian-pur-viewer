import { BoardImage, invert, Matrix, multiply, Point, transform, transformedBounds } from "./board";
import { check } from "./binary";

const POSITIONS: Point[] = [
  { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 },
  { x: 1, y: 1 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0.5 },
];

export type ImageGeometry = Pick<BoardImage, "width" | "height" | "item" | "image">;

export function selectionFrame(images: BoardImage[]): ImageGeometry | undefined {
  if (images.length < 2) return images[0];
  const bounds = transformedBounds(images);
  return { width: bounds.width, height: bounds.height,
    item: [1, 0, 0, 1, bounds.x, bounds.y], image: [1, 0, 0, 1, 0, 0] };
}

export function intersectsSelection(image: ImageGeometry, start: Point, end: Point): boolean {
  const left = Math.min(start.x, end.x), right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y), bottom = Math.max(start.y, end.y);
  const rectangle = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
  const corners = imageHandles(image).filter((_, index) => index % 2 === 0);
  const axes = [{ x: 1, y: 0 }, { x: 0, y: 1 }, ...corners.map((corner, index) => {
    const next = corners[(index + 1) % corners.length];
    return { x: -(next.y - corner.y), y: next.x - corner.x };
  })];
  return axes.every(axis => {
    const a = corners.map(point => point.x * axis.x + point.y * axis.y);
    const b = rectangle.map(point => point.x * axis.x + point.y * axis.y);
    return Math.max(...a) >= Math.min(...b) && Math.max(...b) >= Math.min(...a);
  });
}

export function imageHandles(image: ImageGeometry): Point[] {
  const matrix = multiply(image.item, image.image);
  return POSITIONS.map(point => transform(matrix, { x: point.x * image.width, y: point.y * image.height }));
}

export function imageCenter(image: ImageGeometry): Point {
  return transform(multiply(image.item, image.image), { x: image.width / 2, y: image.height / 2 });
}

export function resizeCursor(image: ImageGeometry, index: number): string {
  const handles = imageHandles(image);
  const handle = handles[index];
  const anchor = handles[(index + 4) % 8];
  check(handle && anchor, "拡縮ハンドルの位置が不正です");
  let angle = Math.atan2(handle.y - anchor.y, handle.x - anchor.x) % Math.PI;
  if (angle < 0) angle += Math.PI;
  const direction = Math.round(angle / (Math.PI / 4)) % 4;
  return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][direction];
}

export function rotationHandles(image: ImageGeometry, offset: number): Point[] {
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
