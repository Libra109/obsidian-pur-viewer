import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Database } from "sql.js";
import { extractDatabase, parsePur, sqlite } from "../src/parser";
import { writePurCopy, wrapDatabase } from "../src/writer";
import { copyPath, saveVerifiedCopy } from "../src/save-copy";
import type { Matrix } from "../src/board";
import { BoardEditor } from "../src/editor";
import { flipItem, imageCenter, rotateMatrixAboutPoint } from "../src/handles";
import { decodeClip, decodeOrder, decodeTransform } from "../src/codecs";
import { Reader } from "../src/binary";
import { animatedWebp, bmpFixture, gifFixture } from "./raster-fixtures";
import { svgFixture } from "./svg-fixtures";
import SparkMD5 from "spark-md5";

const original = new Uint8Array(readFileSync(new URL(
  "../../crates/purcore/tests/fixtures/S1_redbar-new.pur", import.meta.url)));

function snapshot(db: Database, editedId: number): unknown {
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values;
  return tables.map(([name]) => {
    const table = String(name).replace(/"/g, '""');
    const columns = db.exec(`PRAGMA table_info("${table}")`)[0].values.map(row => String(row[1]));
    const expressions = columns.map(column => {
      const quoted = `"${column.replace(/"/g, '""')}"`;
      if (name === "items" && column === "transform")
        return `CASE WHEN id=${editedId} THEN 'edited' ELSE hex(CAST(${quoted} AS BLOB)) END`;
      return `typeof(${quoted}) || ':' || hex(CAST(${quoted} AS BLOB))`;
    });
    return [name, db.exec(`SELECT ${expressions.join(",")} FROM "${table}" ORDER BY rowid`)[0]?.values ?? []];
  });
}

test("2.1 copy preserves every unedited SQL cell, unknown tables, TEXT bytes and container header", async () => {
  const SQL = await sqlite();
  const db = new SQL.Database(extractDatabase(original));
  try {
    db.run(`CREATE TABLE custom_future (id INTEGER PRIMARY KEY, payload BLOB, extra TEXT);
      INSERT INTO custom_future VALUES(1,x'000102ff','preserve');
      CREATE INDEX custom_future_index ON custom_future(extra);
      CREATE VIEW custom_future_view AS SELECT payload FROM custom_future;
      INSERT INTO items(id,parent,name) VALUES(900,-1,'unknown');
      INSERT INTO items_notes(id) VALUES(900);
      INSERT INTO items(id,parent,name) VALUES(901,-1,'group');
      INSERT INTO items_groups(id) VALUES(901);`);
    const source = wrapDatabase(original, db.export());
    const before = source.slice();
    const board = await parsePur(source);
    assert.ok(board.warnings.some(warning => warning.includes("ノート")));
    assert.ok(board.groups?.some(group => group.id === 901));
    const placement = { id: board.images[0].id, item: [...board.images[0].item] as Matrix };
    placement.item[0] *= 1.5;
    placement.item[4] += 12.5;
    placement.item[5] -= 20;
    const expected = snapshot(db, placement.id);
    const schema = db.exec("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name");
    const output = await writePurCopy(source, [placement]);
    assert.deepEqual(source, before);
    assert.deepEqual(output.slice(0, 14), source.slice(0, 14));
    assert.deepEqual(output.slice(22, 40), source.slice(22, 40));
    const chunk = 108 + new DataView(source.buffer).getUint32(104);
    assert.deepEqual(output.slice(104, chunk), source.slice(104, chunk));
    const reopened = await parsePur(output);
    assert.deepEqual(reopened.images[0].item, placement.item);
    assert.deepEqual(reopened.warnings, board.warnings);
    const savedDb = new SQL.Database(extractDatabase(output));
    try {
      assert.deepEqual(snapshot(savedDb, placement.id), expected);
      assert.deepEqual(savedDb.exec("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"), schema);
      assert.equal(savedDb.exec(`SELECT typeof(transform) FROM items WHERE id=${placement.id}`)[0].values[0][0], "text");
    } finally { savedDb.close(); }
  } finally { db.close(); }
});

test("writer refuses legacy, unsupported IDs, nonfinite transforms and triggers", async () => {
  const legacy = new Uint8Array(readFileSync(new URL(
    "../../crates/purcore/tests/fixtures/legacy/S1_redbar.pur", import.meta.url)));
  await assert.rejects(writePurCopy(legacy, []), /未対応.*1\.10/);
  const board = await parsePur(original);
  await assert.rejects(writePurCopy(original, [{ id: -200, item: [1, 0, 0, 1, 0, 0] }]), /未対応/);
  await assert.rejects(writePurCopy(original, [{ id: board.images[0].id, item: [NaN, 0, 0, 1, 0, 0] }]), /不正/);
  const SQL = await sqlite();
  const db = new SQL.Database(extractDatabase(original));
  try {
    db.run("CREATE TRIGGER unsafe AFTER UPDATE ON items BEGIN DELETE FROM items_notes; END;");
    await assert.rejects(writePurCopy(wrapDatabase(original, db.export()), []), /トリガー/);
  } finally { db.close(); }
});

test("front stacking updates only the selected z and survives save and reopen above unsupported root items", async () => {
  const SQL = await sqlite();
  const db = new SQL.Database(extractDatabase(original));
  try {
    const id = (await parsePur(original)).images[0].id;
    db.run(`INSERT INTO items (id,parent,transform,opacity,z,sort_order)
      SELECT id+1,parent,transform,opacity,z,sort_order FROM items;
      INSERT INTO items_images (id,image,image_transform,image_bounds,flags,playback_state,playback_frame)
      SELECT id+1,image,image_transform,image_bounds,flags,playback_state,playback_frame FROM items_images;
      INSERT INTO items(id,parent,name,z) VALUES(900,-1,'hidden note',100);
      INSERT INTO items_notes(id) VALUES(900);
      INSERT INTO items(id,parent,name,z) VALUES(901,-1,'hidden group',200);
      INSERT INTO items_groups(id) VALUES(901);
      INSERT INTO items(id,parent,name,z) VALUES(902,901,'group child',1000);`);
    const source = wrapDatabase(original, db.export());
    const board = await parsePur(source);
    assert.equal(board.maxRootZ, 200);
    const editor = new BoardEditor(board.images, () => {}, board.maxRootZ);
    editor.bringToFront(id);
    assert.equal(editor.images[editor.images.length - 1].z, 201);
    const output = await writePurCopy(source, editor.snapshot());
    const reopened = await parsePur(output);
    assert.equal(reopened.images[reopened.images.length - 1].id, id);
    assert.equal(reopened.images[reopened.images.length - 1].z, 201);
    assert.deepEqual(reopened.images.find(image => image.id === id)!.item, board.images.find(image => image.id === id)!.item);
    const saved = new SQL.Database(extractDatabase(output));
    try {
      assert.deepEqual(saved.exec("SELECT id,z FROM items WHERE id>=900 ORDER BY id"), db.exec("SELECT id,z FROM items WHERE id>=900 ORDER BY id"));
      // Revert only the intentional edit before comparing all cells and storage types.
      saved.run("UPDATE items SET z=? WHERE id=?", [db.exec(`SELECT z FROM items WHERE id=${id}`)[0].values[0][0], id]);
      assert.deepEqual(snapshot(saved, -100000), snapshot(db, -100000));
    } finally { saved.close(); }
    await assert.rejects(writePurCopy(source, [{ id, item: board.images[0].item, z: Infinity }]), /重なり順/);
  } finally { db.close(); }
});

test("rotation and reflection transforms persist in a real PureRef fixture and reopen unchanged", async () => {
  const source = original.slice();
  const board = await parsePur(source);
  const originalItem = [...board.images[0].item] as Matrix;
  const editor = new BoardEditor(board.images);
  const image = board.images[0];
  editor.transformItem(image.id, rotateMatrixAboutPoint(image.item, imageCenter(image), Math.PI / 2));
  editor.transformItem(image.id, flipItem(image, "horizontal"));
  editor.transformItem(image.id, flipItem(image, "vertical"));
  const expected = editor.snapshot();
  const output = await writePurCopy(source, expected);
  assert.deepEqual(source, original, "the source fixture remains byte-for-byte unchanged");
  const reopened = await parsePur(output);
  assert.deepEqual(reopened.images[0].item, expected[0].item);
  assert.notDeepEqual(reopened.images[0].item, originalItem);
  const expectedCenter = imageCenter({ ...image, item: expected[0].item });
  const actualCenter = imageCenter(reopened.images[0]);
  assert.ok(Math.hypot(expectedCenter.x - actualCenter.x, expectedCenter.y - actualCenter.y) < 1e-10);
  editor.acceptSaved(expected);
  assert.equal(editor.dirty, false);
  editor.undo();
  assert.equal(editor.dirty, true);
  editor.redo();
  assert.equal(editor.dirty, false);
});

test("save-as validates names, refuses conflicts and external edits, and verifies persisted bytes", async () => {
  assert.equal(copyPath("boards/source.pur", "copy.pur"), "boards/copy.pur");
  for (const name of ["source.pur", "../copy.pur", "copy.txt", "CON.pur", " copy.pur"])
    assert.throws(() => copyPath("boards/source.pur", name));
  let source = original.slice(), stored: Uint8Array | undefined;
  let conflict = false, current = true, fail = false, corrupt = false;
  let writes = 0;
  const output = await writePurCopy(original, []);
  const store = {
    source: async () => source,
    exists: async () => conflict,
    create: async (_path: string, bytes: Uint8Array) => {
      writes++;
      if (fail) throw new Error("disk full");
      stored = bytes.slice();
    },
    read: async () => corrupt ? new Uint8Array() : stored!,
  };
  await saveVerifiedCopy(store, original, "copy.pur", output, () => current);
  assert.deepEqual(stored, output);
  conflict = true;
  await assert.rejects(saveVerifiedCopy(store, original, "copy.pur", output, () => current), /既存/);
  assert.equal(writes, 1);
  conflict = false;
  source = new Uint8Array();
  await assert.rejects(saveVerifiedCopy(store, original, "copy.pur", output, () => current), /外部更新/);
  source = original.slice();
  current = false;
  await assert.rejects(saveVerifiedCopy(store, original, "copy.pur", output, () => current), /編集状態/);
  current = true;
  fail = true;
  await assert.rejects(saveVerifiedCopy(store, original, "copy.pur", output, () => current), /disk full.*残っている/);
  fail = false;
  const raced = new Uint8Array([9, 8, 7]);
  const createConflict = {
    ...store,
    create: async () => { stored = raced; throw new Error("destination already exists"); },
  };
  await assert.rejects(saveVerifiedCopy(createConflict, original, "race.pur", output, () => current),
    /already exists.*残っている/);
  assert.deepEqual(stored, raced, "a create-time conflict must not alter or delete the other writer's output");
  const partialFailure = {
    ...store,
    create: async () => { stored = output.slice(0, 10); throw new Error("partial write"); },
  };
  await assert.rejects(saveVerifiedCopy(partialFailure, original, "partial.pur", output, () => current),
    /partial write.*残っている/);
  assert.deepEqual(stored, output.slice(0, 10), "a partial file must be reported, not silently deleted");
  corrupt = true;
  await assert.rejects(saveVerifiedCopy(store, original, "copy.pur", output, () => current), /再読込結果.*残っている/);
  corrupt = false;
  const updatedDuringWrite = {
    ...store,
    create: async (path: string, bytes: Uint8Array) => {
      await store.create(path, bytes);
      source = new Uint8Array();
    },
  };
  await assert.rejects(saveVerifiedCopy(updatedDuringWrite, original, "other.pur", output, () => current), /外部更新.*残っている/);
  source = original.slice();
  const changedDuringWrite = {
    ...store,
    create: async (path: string, bytes: Uint8Array) => {
      await store.create(path, bytes);
      current = false;
    },
  };
  await assert.rejects(saveVerifiedCopy(changedDuringWrite, original, "other.pur", output, () => current), /編集状態.*残っている/);
  assert.deepEqual(original, new Uint8Array(readFileSync(new URL(
    "../../crates/purcore/tests/fixtures/S1_redbar-new.pur", import.meta.url))));
});

test("added images use the real 2.1 schema, TEXT variants, checksum and collision-free IDs", async () => {
  const SQL = await sqlite();
  const db = new SQL.Database(extractDatabase(original));
  try {
    db.run(`INSERT INTO items(id,parent,z,name) VALUES(900,-1,100,'hidden');
      INSERT INTO items_notes(id,text) VALUES(900,'keep');`);
    const source = wrapDatabase(original, db.export());
    const board = await parsePur(source);
    const editor = new BoardEditor(board.images, () => {}, board.maxHiddenRootZ,
      board.frontmostRootId, board.maxItemId);
    const added = editor.add({
      ...board.images[0], item: [1, 0, 0, 1, 200, 300], image: [1, 0, 0, 1, -32, -24],
    });
    assert.equal(added.id, 901);
    assert.equal(added.z, 101);
    const output = await writePurCopy(source, editor.snapshot(), editor.deletedIds);
    const reopened = await parsePur(output);
    assert.equal(reopened.images.length, 2);
    assert.equal(reopened.images[reopened.images.length - 1].id, added.id);
    const saved = new SQL.Database(extractDatabase(output));
    try {
      assert.deepEqual(saved.exec("SELECT id,text FROM items_notes"), db.exec("SELECT id,text FROM items_notes"));
      assert.equal(saved.exec("PRAGMA integrity_check")[0].values[0][0], "ok");
      assert.deepEqual(saved.exec("PRAGMA foreign_key_check"), []);
      assert.deepEqual(saved.exec(`SELECT width,height,checksum,format,source_type,source,origin
        FROM images WHERE id=1`)[0].values[0],
      [64, 48, "3f97a27e8cbfd743b3d6e3a675290a0b", "PNG", 1, null, null]);
      const textVariant = (table: string, column: string) => {
        const row = saved.exec(`SELECT typeof(${column}), CAST(${column} AS BLOB)
          FROM ${table} WHERE id=${added.id}`)[0].values[0];
        assert.equal(row[0], "text");
        return new TextDecoder("utf-8", { fatal: true }).decode(row[1] as Uint8Array);
      };
      assert.deepEqual(decodeTransform(textVariant("items", "transform")), added.item);
      assert.deepEqual(decodeTransform(textVariant("items_images", "image_transform")), added.image);
      assert.deepEqual(decodeClip(textVariant("items_images", "image_bounds")), added.clip);
      assert.deepEqual(decodeOrder(textVariant("items", "sort_order")), { numerator: 902n, denominator: 1n });
      assert.deepEqual(saved.exec(`SELECT parent,opacity,locked,comment FROM items WHERE id=901`)[0].values[0],
        [-1, 1, 0, null]);
      assert.deepEqual(saved.exec(`SELECT image,flags,playback_state,playback_frame,playback_speed
        FROM items_images WHERE id=901`)[0].values[0], [1, 1, 0, 0, 1]);
    } finally { saved.close(); }
    editor.acceptSaved(editor.snapshot());
    editor.undo();
    const withoutAdded = await writePurCopy(output, editor.snapshot(), editor.deletedIds);
    assert.equal((await parsePur(withoutAdded)).images.length, 1);
    editor.acceptSaved(editor.snapshot());
    editor.redo();
    const resurrected = await writePurCopy(withoutAdded, editor.snapshot(), editor.deletedIds);
    const restoredImages = (await parsePur(resurrected)).images;
    assert.deepEqual(restoredImages[restoredImages.length - 1].item, added.item);
    assert.deepEqual(restoredImages[restoredImages.length - 1].data, added.data);
  } finally { db.close(); }
});

test("deletion removes only supported item rows and releases data only after the last reference", async () => {
  const SQL = await sqlite();
  const db = new SQL.Database(extractDatabase(original));
  try {
    db.run(`INSERT INTO items(id,parent,transform,opacity,z,sort_order)
      SELECT 1,parent,transform,opacity,z,sort_order FROM items;
      INSERT INTO items_images(id,image,image_transform,image_bounds,flags,playback_state,playback_frame)
      SELECT 1,image,image_transform,image_bounds,flags,playback_state,playback_frame FROM items_images;
      INSERT INTO items(id,parent,name) VALUES(900,-1,'note');
      INSERT INTO items_notes(id,text) VALUES(900,'keep');`);
    const source = wrapDatabase(original, db.export());
    const board = await parsePur(source), editor = new BoardEditor(board.images);
    editor.select(0); editor.removeSelected();
    const output = await writePurCopy(source, editor.snapshot(), editor.deletedIds);
    const saved = new SQL.Database(extractDatabase(output));
    try {
      assert.equal(saved.exec("SELECT COUNT(*) FROM images")[0].values[0][0], 1);
      assert.deepEqual(saved.exec("SELECT id FROM items ORDER BY id")[0].values, [[1], [900]]);
      assert.deepEqual(saved.exec("SELECT id,text FROM items_notes"), db.exec("SELECT id,text FROM items_notes"));
    } finally { saved.close(); }
    editor.acceptSaved(editor.snapshot());
    editor.select(1); editor.removeSelected();
    const empty = await writePurCopy(output, editor.snapshot(), editor.deletedIds);
    assert.deepEqual((await parsePur(empty)).images, []);
    const emptyDb = new SQL.Database(extractDatabase(empty));
    try {
      assert.equal(emptyDb.exec("SELECT COUNT(*) FROM images")[0].values[0][0], 0);
      assert.deepEqual(emptyDb.exec("SELECT id FROM items")[0].values, [[900]]);
    } finally { emptyDb.close(); }
    editor.acceptSaved(editor.snapshot()); editor.undo();
    const restored = await writePurCopy(empty, editor.snapshot(), editor.deletedIds);
    assert.equal((await parsePur(restored)).images[0].id, 1);
    await assert.rejects(writePurCopy(source, [], [900]), /未対応/);
    await assert.rejects(writePurCopy(source, [], [0, 0]), /重複/);
    await assert.rejects(writePurCopy(source, editor.snapshot(), [1]), /重複/);
    db.run("CREATE TABLE future_refs(image INTEGER); INSERT INTO future_refs VALUES(0)");
    const unknown = wrapDatabase(original, db.export());
    const preserved = await writePurCopy(unknown, [], [0, 1]);
    const unknownDb = new SQL.Database(extractDatabase(preserved));
    try {
      assert.equal(unknownDb.exec("SELECT COUNT(*) FROM images")[0].values[0][0], 1);
      assert.deepEqual(unknownDb.exec("SELECT image FROM future_refs")[0].values, [[0]]);
    } finally { unknownDb.close(); }
    db.run("INSERT INTO items(id,parent,name) VALUES(901,0,'child')");
    await assert.rejects(writePurCopy(wrapDatabase(original, db.export()), [], [0]), /子要素/);
  } finally { db.close(); }
});

test("Undo after a saved deletion restores exact sort keys, flags, names and unknown item columns", async () => {
  const SQL = await sqlite();
  const db = new SQL.Database(extractDatabase(original));
  try {
    db.run(`ALTER TABLE items ADD COLUMN future_payload TEXT;
      UPDATE items SET locked=1,name='preserved name',future_payload=CAST(x'0001c3bf' AS TEXT);
      UPDATE items_images SET flags=0,playback_speed=0.5;
      INSERT INTO items(id,parent,transform,opacity,z,sort_order)
      SELECT 1,parent,transform,opacity,z,sort_order FROM items;
      INSERT INTO items_images(id,image,image_transform,image_bounds,flags,playback_state,playback_frame)
      SELECT 1,image,image_transform,image_bounds,flags,playback_state,playback_frame FROM items_images;`);
    const key = db.exec("SELECT CAST(sort_order AS BLOB) FROM items WHERE id=0")[0].values[0][0] as Uint8Array;
    const reader = new Reader(Uint8Array.from(new TextDecoder().decode(key), c => c.charCodeAt(0)));
    reader.pos = 5; reader.take(reader.u32()); reader.i32(); reader.u64();
    const raw = reader.bytes.slice();
    new DataView(raw.buffer).setUint32(reader.pos, 2);
    db.run("UPDATE items SET sort_order=CAST(? AS TEXT) WHERE id=0",
      [new TextEncoder().encode(Array.from(raw, c => String.fromCharCode(c)).join(""))]);
    const source = wrapDatabase(original, db.export());
    const board = await parsePur(source);
    assert.deepEqual(board.images.map(image => image.id), [1, 0]);
    const editor = new BoardEditor(board.images);
    editor.select(0); editor.removeSelected();
    const deleted = await writePurCopy(source, editor.snapshot(), editor.deletedIds);
    editor.acceptSaved(editor.snapshot());
    editor.undo();
    const output = await writePurCopy(deleted, editor.snapshot(), editor.deletedIds);
    assert.deepEqual((await parsePur(output)).images.map(image => image.id), [1, 0]);
    const saved = new SQL.Database(extractDatabase(output));
    try {
      assert.deepEqual(saved.exec(`SELECT name,locked,typeof(future_payload),hex(CAST(future_payload AS BLOB)),
        typeof(sort_order),hex(CAST(sort_order AS BLOB)) FROM items WHERE id=0`),
      db.exec(`SELECT name,locked,typeof(future_payload),hex(CAST(future_payload AS BLOB)),
        typeof(sort_order),hex(CAST(sort_order AS BLOB)) FROM items WHERE id=0`));
      assert.deepEqual(saved.exec("SELECT flags,playback_speed FROM items_images WHERE id=0"),
        db.exec("SELECT flags,playback_speed FROM items_images WHERE id=0"));
    } finally { saved.close(); }
  } finally { db.close(); }
});

test("new GIF WebP BMP and SVG rows embed original bytes, format and checksum through save, delete and Undo", async () => {
  for (const [mime, data] of [
    ["image/gif", gifFixture(true)], ["image/webp", animatedWebp([])], ["image/bmp", bmpFixture(true, true)],
    ["image/svg+xml", svgFixture],
  ] as const) {
    const board = await parsePur(original);
    const editor = new BoardEditor(board.images);
    const image = editor.add({ ...board.images[0], data, mime, width: 3, height: 2 });
    const output = await writePurCopy(original, editor.snapshot());
    const reopened = await parsePur(output);
    const added = reopened.images.find(value => value.id === image.id)!;
    assert.deepEqual(added.data, data);
    assert.equal(added.mime, mime);
    const SQL = await sqlite(), saved = new SQL.Database(extractDatabase(output));
    const hash = new SparkMD5.ArrayBuffer();
    hash.append(Uint8Array.from(data).buffer);
    try {
      assert.deepEqual(saved.exec(`SELECT format,checksum,typeof(data),source_type FROM images
        WHERE id=(SELECT image FROM items_images WHERE id=${image.id})`)[0].values[0],
      [mime === "image/svg+xml" ? "SVG" : mime.slice(6).toUpperCase(), hash.end(), "blob", 1]);
      assert.deepEqual(saved.exec(`SELECT flags,playback_state,playback_frame,playback_speed
        FROM items_images WHERE id=${image.id}`)[0].values[0],
      [1, mime === "image/gif" ? 3 : 0, 0, 1]);
    } finally { saved.close(); }
    editor.acceptSaved(editor.snapshot());
    editor.removeSelected();
    const deleted = await writePurCopy(output, editor.snapshot(), editor.deletedIds);
    editor.acceptSaved(editor.snapshot());
    editor.undo();
    const restored = await parsePur(await writePurCopy(deleted, editor.snapshot()));
    assert.deepEqual(restored.images.find(value => value.id === image.id)!.data, data);
    assert.equal(restored.images.find(value => value.id === image.id)!.mime, mime);
  }
});
