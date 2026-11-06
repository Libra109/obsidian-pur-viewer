import { check, Reader } from "./binary";
import { Clip, IDENTITY, Matrix } from "./board";

export function variant(value: unknown, type: number | string): Reader {
  let bytes: Uint8Array;
  if (typeof value === "string") {
    check([...value].every(c => c.charCodeAt(0) <= 255), "latin-1列に不正な文字があります");
    bytes = Uint8Array.from(value, c => c.charCodeAt(0));
  } else {
    check(value instanceof Uint8Array, "QVariant列の型が不正です");
    bytes = value;
  }
  const reader = new Reader(bytes);
  const id = reader.u32();
  check(reader.take(1)[0] === 0, "null QVariantには対応していません");
  if (typeof type === "string") {
    check(id === 1024 || id === 65536, "QVariantのユーザー型が不正です");
    const name = reader.take(reader.u32());
    check(name.length > 0 && name[name.length - 1] === 0 &&
      new TextDecoder().decode(name.subarray(0, -1)) === type, `QVariantは ${type} ではありません`);
  } else check(id === type, `QVariant型 ${id} は未対応です (expected ${type})`);
  return reader;
}

export function decodeTransform(value: unknown): Matrix {
  if (value === null) return [...IDENTITY];
  const r = variant(value, 80);
  const q = Array.from({ length: 9 }, () => r.f64());
  check(r.pos === r.bytes.length, "QTransformのサイズが不正です");
  check(q[2] === 0 && q[5] === 0 && q[8] === 1,
    "射影変換には対応していません");
  return [q[0], q[1], q[3], q[4], q[6], q[7]];
}

export function decodeClip(value: unknown): Clip | undefined {
  if (value === null) return undefined;
  const r = variant(value, "QPainterPath");
  const count = r.u32();
  check(count <= (r.bytes.length - r.pos) / 20, "パスの要素数が不正です");
  if (count === 0) {
    check(r.pos === r.bytes.length, "空パスのサイズが不正です");
    return undefined;
  }
  const elements = Array.from({ length: count }, () =>
    ({ type: r.i32(), x: r.f64(), y: r.f64() }));
  r.i32(); // Qt's current subpath start; not needed by Canvas.
  const fill = r.i32();
  check(r.pos === r.bytes.length && (fill === 0 || fill === 1), "パスの末尾が不正です");
  for (let i = 0; i < elements.length; i++) {
    const type = elements[i].type;
    check(type === 0 || type === 1 || type === 2, "パスの要素型が不正です");
    if (type === 2) {
      check(elements[i + 1]?.type === 3 && elements[i + 2]?.type === 3,
        "ベジェ曲線の制御点が不足しています");
      i += 2;
    }
  }
  check(elements[0].type === 0, "パスの始点がありません");
  return { elements, fillRule: fill === 0 ? "evenodd" : "nonzero" };
}

export interface Rational { numerator: bigint; denominator: bigint }
export function decodeOrder(value: unknown): Rational {
  if (value === null) return { numerator: 0n, denominator: 1n };
  const r = variant(value, "BigRational");
  const sign = r.i32();
  const limbs = (): bigint => {
    const length = r.u64();
    check(length <= 1024 && length <= (r.bytes.length - r.pos) / 4,
      "BigRationalの桁数が不正か、1024 limbの上限を超えています");
    let value = 0n;
    for (let i = 0; i < length; i++) value |= BigInt(r.u32()) << BigInt(32 * i);
    return value;
  };
  const numerator = limbs() * BigInt(sign);
  const denominatorSign = r.i32();
  const denominator = limbs() * BigInt(denominatorSign);
  check(r.pos === r.bytes.length && denominator > 0n && [-1, 0, 1].includes(sign),
    "BigRationalが不正です");
  return { numerator, denominator };
}

export function compareOrder(a: Rational, b: Rational): number {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
