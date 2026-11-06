import SparkMD5 from "spark-md5";
import type { Database, SqlValue } from "sql.js";
import { check } from "./binary";
import { BoardImage, Clip, imageMime, Matrix, StoredRow } from "./board";
import { imageDimensions } from "./image-import";
import { decodeTransform } from "./codecs";
import { extractDatabase, MAX_FILE_BYTES, parsePur, sqlite } from "./parser";

export interface Placement { id: number; item: Matrix; z?: number; content?: BoardImage }

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
  return storedText(bytes);
}

function storedText(bytes: Uint8Array): Uint8Array {
  return new TextEncoder().encode(Array.from(bytes, b => String.fromCharCode(b)).join(""));
}

function namedVariant(name: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(10 + name.length + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1024);
  view.setUint32(5, name.length + 1);
  bytes.set(new TextEncoder().encode(name), 9);
  bytes.set(payload, 10 + name.length);
  return storedText(bytes);
}

function storedOrder(id: number): Uint8Array {
  const value = BigInt(id) + 1n;
  const limbs = value <= 0xffffffffn ? 1 : 2;
  const payload = new Uint8Array(28 + limbs * 4);
  const view = new DataView(payload.buffer);
  view.setInt32(0, 1); view.setBigUint64(4, BigInt(limbs));
  view.setUint32(12, Number(value & 0xffffffffn));
  if (limbs === 2) view.setUint32(16, Number(value >> 32n));
  const denominator = 12 + limbs * 4;
  view.setInt32(denominator, 1);
  view.setBigUint64(denominator + 4, 1n); view.setUint32(denominator + 12, 1);
  return namedVariant("BigRational", payload);
}

function storedClip(clip?: Clip): Uint8Array {
  const elements = clip?.elements ?? [];
  const payload = new Uint8Array(4 + elements.length * 20 + (elements.length ? 8 : 0));
  const view = new DataView(payload.buffer);
  view.setUint32(0, elements.length);
  elements.forEach((element, index) => {
    const pos = 4 + index * 20;
    view.setInt32(pos, element.type); view.setFloat64(pos + 4, element.x); view.setFloat64(pos + 12, element.y);
  });
  if (elements.length) view.setInt32(payload.length - 4, clip?.fillRule === "nonzero" ? 1 : 0);
  return namedVariant("QPainterPath", payload);
}

function insertStoredRow(db: Database, table: string, row: StoredRow,
  overrides: Record<string, SqlValue>, textOverrides: string[] = []): void {
  const values = { ...row.values, ...overrides };
  const columns = Object.keys(values);
  const text = new Set([...row.textColumns, ...textOverrides]);
  const quoted = columns.map(column => `"${column.replace(/"/g, '""')}"`);
  db.run(`INSERT INTO "${table}" (${quoted.join(",")}) VALUES (${
    columns.map(column => text.has(column) ? "CAST(? AS TEXT)" : "?").join(",")})`,
  columns.map(column => values[column]));
}

export async function writePurCopy(original: Uint8Array, placements: Placement[],
  deletedIds: number[] = []): Promise<Uint8Array> {
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
    const knownTables = new Set(["images", "items", "items_images", "items_groups", "items_notes",
      "items_drawings", "metadata"]);
    const unknownTables = db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0].values
      .some(([name]) => !knownTables.has(String(name)));
    const deleted = new Set<number>();
    for (const id of deletedIds) {
      check(supported.has(id) && !deleted.has(id) && !placements.some(placement => placement.id === id),
        "未対応または重複した画像項目は削除できません");
      deleted.add(id);
      check(!db.exec(`SELECT id FROM items WHERE parent=${id} OR comment=${id}
        UNION ALL SELECT id FROM items_notes WHERE id=${id}
        UNION ALL SELECT id FROM items_groups WHERE id=${id}
        UNION ALL SELECT id FROM items_drawings WHERE id=${id}`).length,
      "関連する子要素や未対応要素を持つ画像は削除できません");
      const imageId = db.exec(`SELECT image FROM items_images WHERE id=${id}`)[0].values[0][0];
      db.run("DELETE FROM items_images WHERE id=?", [id]);
      db.run("DELETE FROM items WHERE id=?", [id]);
      check(db.getRowsModified() === 1, "画像項目を削除できませんでした");
      // Unknown tables may reference image data without declaring a foreign key.
      if (!unknownTables)
        db.run("DELETE FROM images WHERE id=? AND NOT EXISTS(SELECT 1 FROM items_images WHERE image=?)",
          [imageId, imageId]);
    }
    for (const placement of placements) {
      const before = supported.get(placement.id);
      check(Number.isSafeInteger(placement.id) && placement.id >= 0 && !ids.has(placement.id),
        "未対応または重複した画像項目は保存できません");
      ids.add(placement.id);
      if (!before) {
        const image = placement.content;
        check(image && image.id === placement.id && imageMime(image.data) === image.mime,
          "未対応の画像項目は保存できません");
        check(!db.exec(`SELECT id FROM items WHERE id=${placement.id}
          UNION ALL SELECT id FROM items_images WHERE id=${placement.id}
          UNION ALL SELECT id FROM items_groups WHERE id=${placement.id}
          UNION ALL SELECT id FROM items_notes WHERE id=${placement.id}
          UNION ALL SELECT id FROM items_drawings WHERE id=${placement.id}`).length,
        "追加画像のIDが既存の項目と衝突しています");
        check(Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height) &&
          image.width > 0 && image.height > 0 && image.width * image.height <= 40_000_000 &&
          Number.isFinite(image.opacity) && image.opacity >= 0 && image.opacity <= 1 &&
          placement.z !== undefined && Number.isFinite(placement.z), "追加画像の寸法または配置が不正です");
        const dimensions = imageDimensions(image.data);
        check(dimensions.width === image.width && dimensions.height === image.height, "追加画像の寸法が不正です");
        const imageId = Number(db.exec("SELECT COALESCE(MAX(id),-1) FROM images")[0].values[0][0]) + 1;
        check(Number.isSafeInteger(imageId) && imageId >= 0, "画像データIDが整数の上限に達しています");
        const hash = new SparkMD5.ArrayBuffer();
        hash.append(Uint8Array.from(image.data).buffer);
        if (image.stored) {
          insertStoredRow(db, "images", image.stored.source, {
            id: imageId, width: image.width, height: image.height, data: image.data,
          });
          const storedItem = image.stored.item;
          const rawTransform = storedItem.values.transform;
          const oldTransform = decodeTransform(storedItem.textColumns.includes("transform") &&
            rawTransform instanceof Uint8Array ? new TextDecoder("utf-8", { fatal: true }).decode(rawTransform)
            : rawTransform);
          const overrides: Record<string, SqlValue> = { id: placement.id };
          const changedTransform = !oldTransform.every((value, i) => value === placement.item[i]);
          if (changedTransform) overrides.transform = storedTransform(placement.item);
          if ((storedItem.values.z ?? 0) !== placement.z) overrides.z = placement.z;
          insertStoredRow(db, "items", storedItem, overrides, changedTransform ? ["transform"] : []);
          insertStoredRow(db, "items_images", image.stored.imageItem, {
            id: placement.id, image: imageId,
          });
          continue;
        }
        db.run(`INSERT INTO images(id,width,height,checksum,format,source,source_type,origin,data)
          VALUES(?,?,?,?,?,NULL,1,NULL,?)`, [imageId, image.width, image.height, hash.end(),
          image.mime === "image/svg+xml" ? "SVG" : image.mime.slice(6).toUpperCase(), image.data]);
        db.run(`INSERT INTO items(id,parent,transform,sort_order,z,opacity,locked,comment,name)
          VALUES(?,-1,CAST(? AS TEXT),CAST(? AS TEXT),?,?,0,NULL,NULL)`,
        [placement.id, storedTransform(placement.item), storedOrder(placement.id), placement.z, image.opacity]);
        db.run(`INSERT INTO items_images(id,image,image_transform,image_bounds,flags,playback_state,
          playback_frame,playback_speed) VALUES(?,?,CAST(? AS TEXT),CAST(? AS TEXT),1,?,0,1)`,
        [placement.id, imageId, storedTransform(image.image), storedClip(image.clip),
          image.mime === "image/gif" ? 3 : 0]);
        continue;
      }
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
    check(!db.exec("PRAGMA foreign_key_check").length, "保存DBの参照整合性検証に失敗しました");
    const output = wrapDatabase(original, db.export());
    const restored = await parsePur(output);
    for (const placement of placements) {
      const image = restored.images.find(image => image.id === placement.id);
      check(image && placement.item.every((value, i) => value === image.item[i]), "保存後の画像配置が一致しません");
      check(placement.z === undefined || image.z === placement.z, "保存後の重なり順が一致しません");
      if (!supported.has(placement.id)) {
        const content = placement.content!;
        check(image.width === content.width && image.height === content.height && image.mime === content.mime &&
          image.data.length === content.data.length && image.data.every((value, i) => value === content.data[i]) &&
          image.image.every((value, i) => value === content.image[i]) &&
          image.opacity === content.opacity && image.clip?.fillRule === content.clip?.fillRule &&
          image.clip?.elements.length === content.clip?.elements.length &&
          (image.clip?.elements.every((element, i) => {
            const expected = content.clip!.elements[i];
            return element.type === expected.type && element.x === expected.x && element.y === expected.y;
          }) ?? true),
        "保存後の追加画像が一致しません");
      }
    }
    check(deletedIds.every(id => !restored.images.some(image => image.id === id)), "保存後に削除画像が残っています");
    return output;
  } finally { db.close(); }
}
