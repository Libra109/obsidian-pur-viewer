import { check } from "./binary";
import { looksLikeSvg } from "./svg";
import { heicMime } from "./heic";
import type { SqlValue } from "sql.js";

/** Canvas/CSS order: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export interface Point { x: number; y: number }
export interface Clip {
  elements: { type: number; x: number; y: number }[];
  fillRule: CanvasFillRule;
}
export interface StoredRow {
  values: Record<string, SqlValue>;
  textColumns: string[];
}
export interface BoardImage {
  id: number;
  data: Uint8Array;
  mime: string;
  width: number;
  height: number;
  item: Matrix;
  localItem?: Matrix;
  localItemWorld?: Matrix;
  image: Matrix;
  clip?: Clip;
  opacity: number;
  z: number;
  /** Original sibling rank, not the flattened draw-list index. */
  stackOrder?: number;
  /** Group items share transform geometry but have no encoded bitmap. */
  group?: {
    color: string | null;
    unsupported?: string;
    stored?: StoredRow;
    sortOrder?: { value: SqlValue; text: boolean };
  };
  parent?: {
    id: number;
    transform: Matrix;
    ancestors: { id: number; z: number; order: number }[];
    hiddenMaxZ: number;
    frontmostId?: number;
  };
  stored?: { item: StoredRow; imageItem: StoredRow; source: StoredRow };
}
export interface Board {
  version: string;
  images: BoardImage[];
  groups?: BoardImage[];
  structureIssue?: string;
  hiddenItems?: { id: number; parent: number; z: number }[];
  warnings: string[];
  maxRootZ?: number;
  maxHiddenRootZ?: number;
  frontmostRootId?: number;
  maxItemId?: number;
}
export function parentId(image: BoardImage): number { return image.parent?.id ?? -1; }

export function rememberLocal(item: BoardImage, preserve = false): void {
  if (!preserve) {
    const inverse = item.parent ? invert(item.parent.transform) : IDENTITY;
    check(inverse, "親の変換を逆変換できません");
    item.localItem = multiply(inverse, item.item);
  }
  item.localItemWorld = [...item.item];
}

export function updateHierarchy(items: BoardImage[]): void {
  const groups = new Map(items.filter(item => item.group).map(item => [item.id, item]));
  const childrenByParent = new Map<number, BoardImage[]>();
  for (const item of items) {
    const siblings = childrenByParent.get(parentId(item)) ?? [];
    siblings.push(item);
    childrenByParent.set(parentId(item), siblings);
  }
  const visited = new Set<number>();
  const update = (item: BoardImage, chain = new Set<number>()): void => {
    if (visited.has(item.id)) return;
    check(!chain.has(item.id) && chain.size < 64, "グループ階層が循環しているか深すぎます");
    chain.add(item.id);
    if (item.parent) {
      const parent = groups.get(item.parent.id);
      check(parent, "親グループがありません");
      update(parent, chain);
      item.parent = { ...item.parent, transform: [...parent.item],
        ancestors: [...parent.parent?.ancestors ?? [],
          { id: parent.id, z: parent.z, order: parent.stackOrder ?? 0 }] };
    }
    chain.delete(item.id);
    visited.add(item.id);
  };
  items.forEach(item => update(item));
  const measure = (group: BoardImage): void => {
    const children = childrenByParent.get(group.id) ?? [];
    for (const child of children) if (child.group) measure(child);
    if (!children.length) { group.width = 20; group.height = 20; group.image = [1, 0, 0, 1, -10, -10]; return; }
    const inverse = invert(group.item);
    check(inverse, "グループの変換を逆変換できません");
    const bounds = transformedBounds(children.map(child => ({ ...child, item: multiply(inverse, child.item) })));
    group.width = bounds.width + 20;
    group.height = bounds.height + 20;
    group.image = [1, 0, 0, 1, bounds.x - 10, bounds.y - 10];
  };
  for (const group of groups.values()) if (!group.parent) measure(group);
}
export interface Bounds { x: number; y: number; width: number; height: number }

export function compareImageStack(a: BoardImage, b: BoardImage, aOrder: number, bOrder: number): number {
  if (!a.parent && !b.parent) return a.z - b.z ||
    (a.stackOrder ?? aOrder) - (b.stackOrder ?? bOrder) || aOrder - bOrder;
  aOrder = a.stackOrder ?? aOrder;
  bOrder = b.stackOrder ?? bOrder;
  const left = [...a.parent?.ancestors ?? [], { id: a.id, z: a.z, order: aOrder }];
  const right = [...b.parent?.ancestors ?? [], { id: b.id, z: b.z, order: bOrder }];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i].id === right[i].id) continue;
    return left[i].z - right[i].z || left[i].order - right[i].order || left[i].id - right[i].id;
  }
  return left.length - right.length;
}

export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function transform(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function invert(m: Matrix): Matrix | undefined {
  const determinant = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-14) return undefined;
  const a = m[3] / determinant, b = -m[1] / determinant;
  const c = -m[2] / determinant, d = m[0] / determinant;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function boardBounds(images: BoardImage[]): Bounds {
  const bounds = transformedBounds(images);
  return { ...bounds, width: Math.max(bounds.width, 1), height: Math.max(bounds.height, 1) };
}

export function transformedBounds(images: BoardImage[]): Bounds {
  if (!images.length) return { x: 0, y: 0, width: 1, height: 1 };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const image of images) {
    const matrix = multiply(image.item, image.image);
    for (const p of [{ x: 0, y: 0 }, { x: image.width, y: 0 },
      { x: 0, y: image.height }, { x: image.width, y: image.height }]) {
      const q = transform(matrix, p);
      check(Number.isFinite(q.x) && Number.isFinite(q.y), "画像の座標が対応範囲を超えています");
      left = Math.min(left, q.x); right = Math.max(right, q.x);
      top = Math.min(top, q.y); bottom = Math.max(bottom, q.y);
    }
  }
  const width = right - left, height = bottom - top;
  check(Number.isFinite(width) && Number.isFinite(height), "ボードの範囲が大きすぎます");
  return { x: left, y: top, width, height };
}

export function imageMime(data: Uint8Array): string | undefined {
  if (data.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => data[i] === v))
    return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (new TextDecoder().decode(data.subarray(0, 6)).match(/^GIF8[79]a$/)) return "image/gif";
  if (new TextDecoder().decode(data.subarray(0, 4)) === "RIFF" &&
      new TextDecoder().decode(data.subarray(8, 12)) === "WEBP") return "image/webp";
  if (data[0] === 66 && data[1] === 77) return "image/bmp";
  if (looksLikeSvg(data)) return "image/svg+xml";
  return heicMime(data);
}
