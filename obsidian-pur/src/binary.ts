import SparkMD5 from "spark-md5";

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export class Reader {
  private readonly view: DataView;
  pos = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  take(length: number): Uint8Array {
    check(Number.isSafeInteger(length) && length >= 0 && this.pos + length <= this.bytes.length,
      `データが途切れています (offset ${this.pos}, length ${length})`);
    const result = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return result;
  }

  u32(): number { const p = this.pos; this.take(4); return this.view.getUint32(p); }
  i32(): number { const p = this.pos; this.take(4); return this.view.getInt32(p); }
  u64(): number {
    const value = this.u32() * 4294967296 + this.u32();
    check(Number.isSafeInteger(value), "64 bit整数が対応範囲を超えています");
    return value;
  }
  f64(): number {
    const p = this.pos;
    this.take(8);
    const value = this.view.getFloat64(p);
    check(Number.isFinite(value), "有限でない座標が含まれています");
    return value;
  }
  string(): string {
    const length = this.u32();
    check(length % 2 === 0, "UTF-16文字列の長さが不正です");
    return new TextDecoder("utf-16be", { fatal: true }).decode(this.take(length));
  }
}

export function verifyChecksum(bytes: Uint8Array, offset: number, stored: string): void {
  const hash = new SparkMD5.ArrayBuffer();
  // append() expects an ArrayBuffer, not a possibly offset Uint8Array.
  hash.append(Uint8Array.from(bytes.subarray(offset)).buffer);
  check(/^[0-9a-f]{32}$/.test(stored) && hash.end() === stored,
    "チェックサムが一致しません。破損した .pur は開けません");
}
