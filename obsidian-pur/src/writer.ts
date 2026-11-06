import SparkMD5 from "spark-md5";
import { check } from "./binary";
import { Matrix } from "./board";
import { extractDatabase, MAX_FILE_BYTES, parsePur, sqlite } from "./parser";

export interface Placement { id: number; item: Matrix; z?: number }

export function wrapDatabase(original: Uint8Array, database: Uint8Array): Uint8Array {
  extractDatabase(original);
  const chunk = 108 + new DataView(original.buffer, original.byteOffset).getUint32(104);
  check(database.length >= chunk && database.length + chunk <= MAX_FILE_BYTES, "保存サイズが対応範囲を超えています");
  const output = new Uint8Array(database.length + chunk);
  output.set(original.subarray(0, chunk));
  output.set(database.subarray(chunk), chunk);
  output.set(database.subarray(0, chunk), database.length);
  new DataView(output.buffer).setBigUint64(14, BigInt(database.length));
  const hash = new SparkMD5.ArrayBuffer();
  hash.append(output.slice(104).buffer);
  const checksum = hash.end();
  for (let i = 0; i < checksum.length; i++) {
    output[40 + i * 2] = 0;
    output[41 + i * 2] = checksum.charCodeAt(i);
  }
  return output;
}

function storedTransform(matrix: Matrix): Uint8Array {
  check(matrix.length === 6 && matrix.every(Number.isFinite), "保存する画像配置が不正です");
  const bytes = new Uint8Array(77);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 80);
  [matrix[0], matrix[1], 0, matrix[2], matrix[3], 0, matrix[4], matrix[5], 1]
    .forEach((value, i) => view.setFloat64(5 + i * 8, value));
  return new TextEncoder().encode(Array.from(bytes, b => String.fromCharCode(b)).join(""));
}

export async function writePurCopy(original: Uint8Array, placements: Placement[]): Promise<Uint8Array> {
  const board = await parsePur(original);
  const supported = new Map(board.images.map(image => [image.id, image]));
  const ids = new Set<number>();
  const SQL = await sqlite();
  const db = new SQL.Database(extractDatabase(original));
  try {
    db.run("PRAGMA trusted_schema = OFF");
    check(!db.exec("SELECT name FROM sqlite_master WHERE type='trigger'").length,
      "トリガーを含むDBは未編集データの保持を保証できないため保存できません");
    db.run("BEGIN");
    for (const placement of placements) {
      const before = supported.get(placement.id);
      check(before && !ids.has(placement.id), "未対応または重複した画像項目は保存できません");
      ids.add(placement.id);
      if (placement.z !== undefined && placement.z !== before.z) {
        check(Number.isFinite(placement.z), "保存する重なり順が不正です");
        db.run("UPDATE items SET z=? WHERE id=?", [placement.z, placement.id]);
        check(db.getRowsModified() === 1, "画像の重なり順を更新できませんでした");
      }
      if (before.item.every((value, i) => value === placement.item[i])) continue;
      // Bind UTF-8 bytes and cast to TEXT: direct sql.js string binding truncates embedded NULs.
      db.run("UPDATE items SET transform=CAST(? AS TEXT) WHERE id=?", [storedTransform(placement.item), placement.id]);
      check(db.getRowsModified() === 1, "画像配置を更新できませんでした");
    }
    db.run("COMMIT");
    check(db.exec("PRAGMA integrity_check")[0]?.values[0]?.[0] === "ok", "保存DBの整合性検証に失敗しました");
    const output = wrapDatabase(original, db.export());
    const restored = await parsePur(output);
    for (const placement of placements) {
      const image = restored.images.find(image => image.id === placement.id);
      check(image && placement.item.every((value, i) => value === image.item[i]), "保存後の画像配置が一致しません");
      check(placement.z === undefined || image.z === placement.z, "保存後の重なり順が一致しません");
    }
    return output;
  } finally { db.close(); }
}
