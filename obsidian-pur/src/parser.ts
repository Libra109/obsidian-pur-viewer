import initSqlJs from "sql.js/dist/sql-asm.js";
import type { Database, SqlJsStatic, SqlValue } from "sql.js";
import { check, Reader, verifyChecksum } from "./binary";
import { Board, BoardImage, compareImageStack, IDENTITY, imageMime, invert, Matrix, multiply, StoredRow, updateHierarchy } from "./board";
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

function storedRows(db: Database, table: string, where = ""): Map<number, StoredRow> {
  const columns = rows(db, `PRAGMA table_info("${table}")`).map(row => String(row.name));
  const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const expressions = columns.flatMap((column, index) => [
    `CASE WHEN typeof(${quoted(column)})='text' THEN CAST(${quoted(column)} AS BLOB)
      ELSE ${quoted(column)} END AS ${quoted(column)}`,
    `typeof(${quoted(column)}) AS "__stored_type_${index}"`,
  ]);
  return new Map(rows(db, `SELECT ${expressions.join(",")} FROM "${table}" ${where}`).map(row => {
    const values: Row = {};
    const textColumns: string[] = [];
    columns.forEach((column, index) => {
      values[column] = row[column];
      if (row[`__stored_type_${index}`] === "text") textColumns.push(column);
    });
    return [integer(row.id, `${table}.id`), { values, textColumns }];
  }));
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
  board.maxItemId = integer(rows(db, `SELECT COALESCE(MAX(id),-1) AS id FROM (
    SELECT id FROM items UNION ALL SELECT id FROM items_images UNION ALL SELECT id FROM items_groups
    UNION ALL SELECT id FROM items_notes UNION ALL SELECT id FROM items_drawings)`)[0].id, "最大項目ID");
  const rootZ = rows(db, `SELECT id,z,CAST(sort_order AS BLOB) AS sort_order,
    typeof(sort_order) AS sort_order_type FROM items WHERE parent=-1 OR parent IS NULL`);
  board.maxRootZ = rootZ.reduce((max, row) => Math.max(max, number(row.z, "items.z", 0)), -Infinity);
  const topRoots = rootZ.filter(row => number(row.z, "items.z", 0) === board.maxRootZ)
    .map(row => ({ id: integer(row.id, "items.id"), order: decodeOrder(storedVariant(row, "sort_order")) }));
  topRoots.sort((a, b) => compareOrder(a.order, b.order) || a.id - b.id);
  board.frontmostRootId = topRoots[topRoots.length - 1]?.id;
  const sourceRows = storedRows(db, "images", "LIMIT 10001");
  check(sourceRows.size <= 10000, "画像数が10000件の上限を超えています");
  const images = new Map([...sourceRows].map(([id, row]) => [id, row.values]));
  const hierarchyRows = rows(db, `SELECT id,parent,z,opacity,locked,
    CAST(transform AS BLOB) AS transform,typeof(transform) AS transform_type,
    CAST(sort_order AS BLOB) AS sort_order,typeof(sort_order) AS sort_order_type FROM items LIMIT 20001`);
  check(hierarchyRows.length <= 20000, "階層項目数が20000件の上限を超えています");
  const hierarchy = new Map(hierarchyRows.map(row => [integer(row.id, "items.id"), row]));
  const groups = new Map(rows(db, "SELECT id,lock_mode,background_color FROM items_groups")
    .map(row => [integer(row.id, "items_groups.id"), row]));
  const rank = new Map<number, number>();
  const children = new Map<number, Row[]>();
  for (const row of hierarchyRows) {
    const parent = integer(row.parent ?? -1, "parent");
    const siblings = children.get(parent) ?? [];
    siblings.push(row);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) {
    const ordered = siblings.map(row => ({ row, z: number(row.z, "items.z", 0),
      order: decodeOrder(storedVariant(row, "sort_order")) }));
    ordered.sort((a, b) => a.z - b.z || compareOrder(a.order, b.order) ||
      integer(a.row.id, "items.id") - integer(b.row.id, "items.id"));
    ordered.forEach(({ row }, index) => rank.set(integer(row.id, "items.id"), index));
  }
  const parents = new Map<number, BoardImage["parent"] | null>();
  const parentOf = (row: Row): BoardImage["parent"] | null => {
    const parentId = integer(row.parent ?? -1, "parent");
    if (parentId === -1) return undefined;
    if (parents.has(parentId)) return parents.get(parentId);
    const chain: Row[] = [];
    const seen = new Set<number>([integer(row.id, "items.id")]);
    let id = parentId;
    while (id !== -1) {
      check(!seen.has(id), "グループ階層が循環しています");
      check(chain.length < 64, "グループ階層が64段の上限を超えています");
      seen.add(id);
      const ancestor = hierarchy.get(id), group = groups.get(id);
      if (!ancestor || !group) {
        warnings.add("親グループを確認できないグループ内画像は表示していません");
        parents.set(parentId, null);
        return null;
      }
      if (number(ancestor.opacity, "グループの不透明度", 1) !== 1 ||
          number(ancestor.locked, "グループのロック", 0) !== 0 ||
          number(group.lock_mode, "グループのロックモード", 1) !== 1) {
        warnings.add("未検証の不透明度またはロック設定を持つグループ内画像は表示していません");
        parents.set(parentId, null);
        return null;
      }
      chain.unshift(ancestor);
      id = integer(ancestor.parent ?? -1, "parent");
    }
    let transform: Matrix = [...IDENTITY];
    for (const ancestor of chain) transform = multiply(transform, decodeTransform(storedVariant(ancestor, "transform")));
    check(invert(transform), "親グループの変換を逆変換できません");
    const siblings = children.get(parentId)!;
    const parent: BoardImage["parent"] = { id: parentId, transform,
      ancestors: chain.map(ancestor => ({ id: integer(ancestor.id, "items.id"),
        z: number(ancestor.z, "items.z", 0), order: rank.get(integer(ancestor.id, "items.id"))! })),
      hiddenMaxZ: -Infinity,
      frontmostId: integer(siblings.reduce((top, sibling) =>
        rank.get(integer(sibling.id, "items.id"))! > rank.get(integer(top.id, "items.id"))! ? sibling : top).id,
      "items.id") };
    parents.set(parentId, parent);
    return parent;
  };
  const items = rows(db, `SELECT i.id,i.parent,i.opacity,i.z,
    CAST(i.transform AS BLOB) AS transform,typeof(i.transform) AS transform_type,
    CAST(i.sort_order AS BLOB) AS sort_order,typeof(i.sort_order) AS sort_order_type,
    CAST(ii.image_transform AS BLOB) AS image_transform,typeof(ii.image_transform) AS image_transform_type,
    CAST(ii.image_bounds AS BLOB) AS image_bounds,typeof(ii.image_bounds) AS image_bounds_type,
    ii.image,ii.flags,ii.playback_state,ii.playback_frame
    FROM items i JOIN items_images ii ON i.id=ii.id ORDER BY i.id LIMIT 10001`);
  check(items.length <= 10000, "画像項目数が10000件の上限を超えています");
  const ordered: { image: BoardImage; order: Rational }[] = [];
  const groupItems: BoardImage[] = [];
  const groupRows = storedRows(db, "items_groups"), baseRows = storedRows(db, "items");
  for (const [id, group] of groups) {
    const row = hierarchy.get(id);
    if (!row) { warnings.add("基底項目のないグループは表示していません"); continue; }
    const parent = parentOf(row);
    if (parent === null) continue;
    const unsupported = number(row.opacity, "グループの不透明度", 1) !== 1 ||
      number(row.locked, "グループのロック", 0) !== 0 ||
      number(group.lock_mode, "グループのロックモード", 1) !== 1;
    if (unsupported) { warnings.add("未検証の不透明度またはロック設定を持つグループは表示していません"); continue; }
    const color = group.background_color;
    check(color === null || typeof color === "string" && /^#[\da-f]{8}$/i.test(color),
      "未対応のグループ背景色です");
    groupItems.push({ id, data: new Uint8Array(), mime: "application/x-pur-group",
      width: 20, height: 20, image: [...IDENTITY], opacity: 1, z: number(row.z, "z", 0),
      stackOrder: rank.get(id), ...(parent ? { parent } : {}),
      localItem: decodeTransform(storedVariant(row, "transform")),
      item: parent ? multiply(parent.transform, decodeTransform(storedVariant(row, "transform")))
        : decodeTransform(storedVariant(row, "transform")),
      group: { color, stored: groupRows.get(id) },
      stored: { item: baseRows.get(id)!, imageItem: groupRows.get(id)!, source: groupRows.get(id)! } });
  }
  for (const row of items) {
    const id = integer(row.id, "items.id");
    const parent = parentOf(row);
    if (parent === null) continue;
    const source = row.image === null ? undefined : images.get(integer(row.image, "image"));
    if (!source || source.source_type !== 1 || !(source.data instanceof Uint8Array)) {
      warnings.add("外部リンク画像または画像データのない項目は表示していません"); continue;
    }
    const mime = imageMime(source.data);
    if (mime !== "image/gif" && (number(row.playback_state, "playback_state", 0) !== 0 ||
        number(row.playback_frame, "playback_frame", 0) !== 0)) {
      warnings.add("動画と保存された再生フレームは未対応のため表示していません"); continue;
    }
    // Both the default 0 and the real 2.1.3 fixture's 1 are accepted.
    // Other bits have no verified rendering semantics in the current corpus.
    if (![0, 1].includes(number(row.flags, "flags", 0))) {
      warnings.add("未対応の画像フラグを持つ項目は表示していません"); continue;
    }
    if (!mime) {
      warnings.add("PNG、JPEG、GIF、WebP、BMP、SVG、HEIC以外の画像は表示していません"); continue;
    }
    const width = integer(source.width, "width"), height = integer(source.height, "height");
    check(width > 0 && height > 0 && width * height <= 40_000_000,
      `画像 ${id} が40メガピクセルの上限を超えるか、寸法が不正です`);
    const opacity = number(row.opacity, "opacity", 1);
    check(opacity >= 0 && opacity <= 1, `画像 ${id} の不透明度が不正です`);
    ordered.push({
      order: decodeOrder(storedVariant(row, "sort_order")),
      image: {
        id, data: source.data, mime, width, height, opacity, stackOrder: rank.get(id)!,
        z: number(row.z, "z", 0), item: parent
          ? multiply(parent.transform, decodeTransform(storedVariant(row, "transform")))
          : decodeTransform(storedVariant(row, "transform")),
        localItem: decodeTransform(storedVariant(row, "transform")),
        ...(parent ? { parent } : {}),
        image: decodeTransform(storedVariant(row, "image_transform")),
        clip: decodeClip(storedVariant(row, "image_bounds")),
      },
    });
    if (mime === "image/gif" || mime === "image/webp")
      warnings.add("GIFとWebPは先頭フレームを静止表示し、元の画像データを保持します");
  }
  ordered.sort((a, b) => compareImageStack(a.image, b.image, rank.get(a.image.id)!, rank.get(b.image.id)!));
  board.images = ordered.map(value => value.image);
  if (board.images.length) {
    const where = `WHERE id IN (${board.images.map(image => image.id).join(",")})`;
    const itemRows = storedRows(db, "items", where);
    const imageItemRows = storedRows(db, "items_images", where);
    for (const image of board.images) {
      const imageItem = imageItemRows.get(image.id)!;
      image.stored = { item: itemRows.get(image.id)!, imageItem,
        source: sourceRows.get(integer(imageItem.values.image, "image"))! };
    }
  }
  const displayedIds = new Set(board.images.map(image => image.id));
  for (const parent of parents.values()) {
    if (!parent) continue;
    parent.hiddenMaxZ = (children.get(parent.id) ?? [])
      .filter(row => !displayedIds.has(integer(row.id, "items.id")))
      .reduce((max, row) => Math.max(max, number(row.z, "items.z", 0)), -Infinity);
  }
  board.maxHiddenRootZ = rootZ.filter(row => !displayedIds.has(integer(row.id, "items.id")))
    .reduce((max, row) => Math.max(max, number(row.z, "items.z", 0)), -Infinity);
  const supportedIds = new Set([...board.images, ...groupItems].map(item => item.id));
  board.maxHiddenRootZ = rootZ.filter(row => !supportedIds.has(integer(row.id, "items.id")))
    .reduce((max, row) => Math.max(max, number(row.z, "items.z", 0)), -Infinity);
  for (const parent of parents.values()) if (parent) parent.hiddenMaxZ = (children.get(parent.id) ?? [])
    .filter(row => !supportedIds.has(integer(row.id, "items.id")))
    .reduce((max, row) => Math.max(max, number(row.z, "items.z", 0)), -Infinity);
  const unsafeGroups = new Set<number>();
  const markAncestors = (id: number) => {
    const seen = new Set<number>();
    while (id !== -1 && !seen.has(id)) {
      seen.add(id);
      unsafeGroups.add(id);
      id = integer(hierarchy.get(id)?.parent ?? -1, "parent");
    }
  };
  for (const row of hierarchyRows) if (!supportedIds.has(integer(row.id, "id")))
    markAncestors(integer(row.parent ?? -1, "parent"));
  for (const row of rows(db, "SELECT comment FROM items WHERE comment IS NOT NULL"))
    if (typeof row.comment === "number") markAncestors(integer(row.comment, "comment"));
  for (const group of groupItems) {
    if (unsafeGroups.has(group.id))
      group.group!.unsupported = "未対応の子要素または参照があるグループは編集できません";
    if (group.group!.unsupported) warnings.add(group.group!.unsupported);
  }
  updateHierarchy([...board.images, ...groupItems]);
  for (const item of [...board.images, ...groupItems]) item.localItemWorld = [...item.item];
  board.groups = groupItems;
  const knownTables = new Set(["images", "items", "items_images", "items_groups", "items_notes", "items_drawings", "metadata"]);
  const preservedItems = new Set(rows(db, "SELECT id FROM items_notes UNION SELECT id FROM items_drawings")
    .map(row => integer(row.id, "未表示項目ID")));
  board.hiddenItems = hierarchyRows.filter(row => !supportedIds.has(integer(row.id, "id")))
    .map(row => ({ id: integer(row.id, "id"), parent: integer(row.parent ?? -1, "parent"),
      z: number(row.z, "items.z", 0) }));
  if (board.hiddenItems.some(item => !preservedItems.has(item.id)) ||
      rows(db, "SELECT name FROM sqlite_master WHERE type='table'").some(row => !knownTables.has(String(row.name))) ||
      rows(db, "SELECT id FROM items WHERE comment IS NOT NULL LIMIT 1").length)
    board.structureIssue = "未対応の項目、参照、テーブルがあるためグループ作成、解除、一括削除は利用できません";
  for (const [table, label] of [
    ["items_notes", "ノート"], ["items_drawings", "描画ストローク"],
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
