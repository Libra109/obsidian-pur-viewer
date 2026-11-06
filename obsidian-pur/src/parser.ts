import initSqlJs from "sql.js/dist/sql-asm.js";
import type { Database, SqlJsStatic, SqlValue } from "sql.js";
import { check, Reader, verifyChecksum } from "./binary";
import { Board, BoardImage, imageMime } from "./board";
import { compareOrder, decodeClip, decodeOrder, decodeTransform, Rational } from "./codecs";

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
let engine: Promise<SqlJsStatic> | undefined;

export function sqlite(): Promise<SqlJsStatic> {
  if (!engine) engine = initSqlJs().catch(error => { engine = undefined; throw error; });
  return engine;
}

export function extractDatabase(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes);
  check(r.string() === "2.1", "対応するコンテナー形式は2.1のみです");
  r.take(4);
  const size = r.u64();
  r.string(); // Writer version, not the container version.
  check(r.u32() === 64, "チェックサム欄の長さが不正です");
  const stored = new TextDecoder("utf-16be").decode(r.take(64));
  check(r.pos === 104, "未対応のコンテナーヘッダーです");
  const chunk = 108 + r.u32();
  check(chunk <= size && size + chunk === bytes.length, "コンテナーの長さが不正です");
  verifyChecksum(bytes, 104, stored);
  const db = new Uint8Array(size);
  db.set(bytes.subarray(size));
  db.set(bytes.subarray(chunk, size), chunk);
  check(new TextDecoder().decode(db.subarray(0, 16)) === "SQLite format 3\0",
    "SQLiteヘッダーがありません");
  return db;
}

type Row = Record<string, SqlValue>;
function rows(db: Database, query: string): Row[] {
  const statement = db.prepare(query);
  try {
    const result: Row[] = [];
    while (statement.step()) result.push(statement.getAsObject());
    return result;
  } finally { statement.free(); }
}

function number(value: SqlValue, name: string, fallback?: number): number {
  if (value === null && fallback !== undefined) return fallback;
  check(typeof value === "number" && Number.isFinite(value), `${name} が数値ではありません`);
  return value;
}
function integer(value: SqlValue, name: string): number {
  const result = number(value, name);
  check(Number.isSafeInteger(result), `${name} が整数の対応範囲を超えています`);
  return result;
}

function storedVariant(row: Row, column: string): SqlValue {
  const value = row[column];
  if (value === null || row[`${column}_type`] !== "text") return value;
  check(value instanceof Uint8Array, `${column} のTEXTバイト列を取得できません`);
  // sql.js getString stops at NUL, but PureRef stores binary QVariant in TEXT.
  // CAST AS BLOB preserves the entire UTF-8 string, including embedded NULs.
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

export async function parsePur(bytes: Uint8Array): Promise<Board> {
  check(bytes.length <= MAX_FILE_BYTES, "64 MiBを超える .pur はこの版では開けません");
  const r = new Reader(bytes);
  const version = r.string();
  check(version === "2.1", `未対応の .pur 形式です: ${version}。このプラグインはコンテナー2.1のみ対応しています`);
  const database = extractDatabase(bytes);
  const SQL = await sqlite();
  const db = new SQL.Database(database);
  try { return boardFromDatabase(db); }
  finally { db.close(); }
}

export function boardFromDatabase(db: Database): Board {
  db.run("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
  check(rows(db, "PRAGMA application_id")[0]?.application_id === 940753918,
    "PureRefのデータベースではありません");
  check(rows(db, "PRAGMA user_version")[0]?.user_version === 200101,
    "未対応のデータベース世代です");
  const warnings = new Set<string>();
  const board: Board = { version: "2.1", images: [], warnings: [] };
  const rootZ = rows(db, `SELECT id,z,CAST(sort_order AS BLOB) AS sort_order,
    typeof(sort_order) AS sort_order_type FROM items WHERE parent=-1 OR parent IS NULL`);
  board.maxRootZ = rootZ.reduce((max, row) => Math.max(max, number(row.z, "items.z", 0)), -Infinity);
  const topRoots = rootZ.filter(row => number(row.z, "items.z", 0) === board.maxRootZ)
    .map(row => ({ id: integer(row.id, "items.id"), order: decodeOrder(storedVariant(row, "sort_order")) }));
  topRoots.sort((a, b) => compareOrder(a.order, b.order) || a.id - b.id);
  board.frontmostRootId = topRoots[topRoots.length - 1]?.id;
  const imageRows = rows(db, "SELECT id,width,height,data,source_type FROM images LIMIT 10001");
  check(imageRows.length <= 10000, "画像数が10000件の上限を超えています");
  const images = new Map(imageRows.map(row => [integer(row.id, "images.id"), row]));
  const items = rows(db, `SELECT i.id,i.parent,i.opacity,i.z,
    CAST(i.transform AS BLOB) AS transform,typeof(i.transform) AS transform_type,
    CAST(i.sort_order AS BLOB) AS sort_order,typeof(i.sort_order) AS sort_order_type,
    CAST(ii.image_transform AS BLOB) AS image_transform,typeof(ii.image_transform) AS image_transform_type,
    CAST(ii.image_bounds AS BLOB) AS image_bounds,typeof(ii.image_bounds) AS image_bounds_type,
    ii.image,ii.flags,ii.playback_state,ii.playback_frame
    FROM items i JOIN items_images ii ON i.id=ii.id ORDER BY i.id LIMIT 10001`);
  check(items.length <= 10000, "画像項目数が10000件の上限を超えています");
  const ordered: { image: BoardImage; order: Rational }[] = [];
  for (const row of items) {
    const id = integer(row.id, "items.id");
    if (number(row.parent, "parent", -1) !== -1) {
      warnings.add("グループ内の画像は未対応のため表示していません"); continue;
    }
    const source = row.image === null ? undefined : images.get(integer(row.image, "image"));
    if (!source || source.source_type !== 1 || !(source.data instanceof Uint8Array)) {
      warnings.add("外部リンク画像または画像データのない項目は表示していません"); continue;
    }
    if (number(row.playback_state, "playback_state", 0) !== 0 ||
        number(row.playback_frame, "playback_frame", 0) !== 0) {
      warnings.add("動画と保存された再生フレームは未対応のため表示していません"); continue;
    }
    // Both the default 0 and the real 2.1.3 fixture's 1 are accepted.
    // Other bits have no verified rendering semantics in the current corpus.
    if (![0, 1].includes(number(row.flags, "flags", 0))) {
      warnings.add("未対応の画像フラグを持つ項目は表示していません"); continue;
    }
    const mime = imageMime(source.data);
    if (!mime) {
      warnings.add("PNG、JPEG、GIF、WebP以外の画像は表示していません"); continue;
    }
    const width = integer(source.width, "width"), height = integer(source.height, "height");
    check(width > 0 && height > 0 && width * height <= 40_000_000,
      `画像 ${id} が40メガピクセルの上限を超えるか、寸法が不正です`);
    const opacity = number(row.opacity, "opacity", 1);
    check(opacity >= 0 && opacity <= 1, `画像 ${id} の不透明度が不正です`);
    ordered.push({
      order: decodeOrder(storedVariant(row, "sort_order")),
      image: {
        id, data: source.data, mime, width, height, opacity,
        z: number(row.z, "z", 0), item: decodeTransform(storedVariant(row, "transform")),
        image: decodeTransform(storedVariant(row, "image_transform")),
        clip: decodeClip(storedVariant(row, "image_bounds")),
      },
    });
    if (mime === "image/gif" || mime === "image/webp")
      warnings.add("アニメーションは再生せず、ブラウザーが読み込んだフレームを静止表示します");
  }
  ordered.sort((a, b) => a.image.z - b.image.z || compareOrder(a.order, b.order) || a.image.id - b.image.id);
  board.images = ordered.map(value => value.image);
  const displayedIds = new Set(board.images.map(image => image.id));
  board.maxHiddenRootZ = rootZ.filter(row => !displayedIds.has(integer(row.id, "items.id")))
    .reduce((max, row) => Math.max(max, number(row.z, "items.z", 0)), -Infinity);
  for (const [table, label] of [
    ["items_groups", "グループの背景"], ["items_notes", "ノート"], ["items_drawings", "描画ストローク"],
  ]) {
    if (rows(db, `SELECT id FROM ${table} LIMIT 1`).length)
      warnings.add(`${label}は未対応のため表示していません`);
  }
  if (rows(db, `SELECT i.id FROM items i LEFT JOIN items_images ii ON i.id=ii.id
    LEFT JOIN items_groups g ON i.id=g.id LEFT JOIN items_notes n ON i.id=n.id
    LEFT JOIN items_drawings d ON i.id=d.id
    WHERE ii.id IS NULL AND g.id IS NULL AND n.id IS NULL AND d.id IS NULL LIMIT 1`).length)
    warnings.add("種類を判定できない項目は表示していません");
  board.warnings = [...warnings];
  return board;
}
