import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createHash } from "node:crypto";
import type { Database } from "sql.js";
import { Reader } from "../src/binary";
import { boardBounds, imageMime, multiply, transform } from "../src/board";
import { compareOrder, decodeClip, decodeOrder, decodeTransform } from "../src/codecs";
import { extractDatabase, MAX_FILE_BYTES, parsePur, sqlite } from "../src/parser";

const fixtures = new URL("../../crates/purcore/tests/fixtures/", import.meta.url);
export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(name, fixtures))));
}

async function database(): Promise<Database> {
  const SQL = await sqlite();
  return new SQL.Database(extractDatabase(fixture("S1_redbar-new.pur")));
}

function container(database: Uint8Array): Uint8Array {
  const original = fixture("S1_redbar-new.pur");
  const r = new Reader(original); r.pos = 104;
  const chunk = 108 + r.u32();
  const bytes = new Uint8Array(database.length + chunk);
  bytes.set(original.subarray(0, chunk));
  bytes.set(database.subarray(chunk), chunk);
  bytes.set(database.subarray(0, chunk), database.length);
  new DataView(bytes.buffer).setBigUint64(14, BigInt(database.length));
  const md5 = createHash("md5").update(bytes.subarray(104)).digest("hex");
  for (let i = 0; i < md5.length; i++) bytes[41 + i * 2] = md5.charCodeAt(i);
  return bytes;
}

function storedVariant(type: number, values: number[], name?: string): string {
  const headerLength = 5 + (name ? 4 + name.length + 1 : 0);
  const bytes = new Uint8Array(headerLength + values.length * 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, type);
  if (name) {
    view.setUint32(5, name.length + 1);
    bytes.set(new TextEncoder().encode(name), 9);
  }
  values.forEach((v, i) => view.setFloat64(headerLength + i * 8, v));
  return [...bytes].map(v => String.fromCharCode(v)).join("");
}

test("real PureRef 2.1.3 produces image geometry without mutation", async () => {
  const boards = [];
  for (const name of ["S1_redbar-new.pur"]) {
    const bytes = fixture(name), before = bytes.slice();
    const board = await parsePur(bytes);
    assert.deepEqual(bytes, before);
    assert.equal(board.images.length, 1);
    assert.deepEqual(board.warnings, []);
    const image = board.images[0];
    assert.equal(image.width, 64);
    assert.equal(image.height, 48);
    assert.equal(image.mime, "image/png");
    assert.equal(createHash("md5").update(image.data).digest("hex"), "3f97a27e8cbfd743b3d6e3a675290a0b");
    assert.deepEqual(multiply(image.item, image.image), [15.625, 0, 0, 15.625, 0, 0]);
    assert.deepEqual(boardBounds(board.images), { x: 0, y: 0, width: 1000, height: 750 });
    boards.push(board);
  }
  assert.equal(boards[0].version, "2.1");
  assert.deepEqual(boards[0].images[0].clip?.elements.map(e => [e.x, e.y]),
    [[-32, -24], [32, -24], [32, 24], [-32, 24], [-32, -24]]);
});

test("purcore's real blob corpus decodes with latin-1 TEXT storage", () => {
  const lines = readFileSync(fileURLToPath(new URL("blobs.tsv", fixtures)), "utf8").trim().split(/\r?\n/);
  let transforms = 0, paths = 0, orders = 0;
  for (const line of lines) {
    const [name, hex] = line.split("\t");
    const stored = [...Buffer.from(hex, "hex")].map(b => String.fromCharCode(b)).join("");
    if (name.endsWith("_transform")) {
      assert.equal(decodeTransform(stored).length, 6); transforms++;
    } else if (name.endsWith("_bounds")) {
      assert.ok(decodeClip(stored)?.elements.length); paths++;
    } else if (name.endsWith("_sort_order")) {
      const order = decodeOrder(stored);
      assert.ok(order.denominator > 0n); orders++;
    }
  }
  assert.ok(transforms >= 3 && paths >= 2 && orders >= 3);
});

test("malformed headers, lengths, checksums, unknown versions and oversized files fail explicitly", async () => {
  await assert.rejects(parsePur(new Uint8Array()), /途切れ/);
  await assert.rejects(parsePur(new Uint8Array(MAX_FILE_BYTES + 1)), /64 MiB/);
  for (const name of ["S1_redbar-new.pur"]) {
    const bytes = fixture(name);
    bytes[bytes.length - 1] ^= 1;
    await assert.rejects(parsePur(bytes), /チェックサム/);
    await assert.rejects(parsePur(bytes.subarray(0, 100)));
  }
  const unknown = fixture("S1_redbar-new.pur"); unknown[5] = 51;
  await assert.rejects(parsePur(unknown), /未対応/);
  const invalid = fixture("S1_redbar-new.pur");
  new DataView(invalid.buffer).setBigUint64(14, 0xffffffffffffffffn);
  await assert.rejects(parsePur(invalid), /64 bit/);
  await assert.rejects(parsePur(fixture("legacy/S1_redbar.pur")), /未対応.*1\.10.*2\.1のみ/);
});

test("unsupported database generation is rejected", async () => {
  const db = await database();
  try {
    db.run("PRAGMA user_version=999");
    await assert.rejects(parsePur(container(db.export())), /データベース世代/);
  } finally { db.close(); }
});

test("unsupported items warn visibly instead of pretending to render", async () => {
  for (const [sql, message] of [
    ["UPDATE items SET parent=9", /グループ内/],
    ["UPDATE images SET source_type=2", /外部リンク/],
    ["UPDATE items_images SET flags=128", /フラグ/],
    ["UPDATE items_images SET playback_state=1", /動画/],
    ["UPDATE items_images SET playback_frame=2", /フレーム/],
    ["UPDATE images SET data=x'00010203'", /PNG/],
  ] as const) {
    const db = await database();
    try {
      db.run(sql);
      const board = await parsePur(container(db.export()));
      assert.equal(board.images.length, 0);
      assert.match(board.warnings.join(), message);
    } finally { db.close(); }
  }
  const db = await database();
  try {
    db.run("INSERT INTO items_notes (id,text) VALUES (10,'not rendered'); INSERT INTO items_groups (id) VALUES (11); INSERT INTO items_drawings (id) VALUES (12);");
    const board = await parsePur(container(db.export()));
    assert.equal(board.images.length, 1);
    assert.equal(board.warnings.length, 3);
  } finally { db.close(); }
});

test("opacity and affine image placement are retained", async () => {
  const db = await database();
  try {
    db.run("UPDATE items SET opacity=0.25");
    const board = await parsePur(container(db.export()));
    assert.equal(board.images[0].opacity, 0.25);
    assert.deepEqual(transform(multiply(board.images[0].item, board.images[0].image), { x: 64, y: 48 }),
      { x: 1000, y: 750 });
  } finally { db.close(); }
});

test("rotated, reflected and sheared transforms compose without decomposition loss", async () => {
  const db = await database();
  try {
    // Synthetic QTransform in Qt wire order, exercising values not present in the real scene.
    const stored = storedVariant(80, [0, -2, 0, -3, 0.5, 0, 100, -40, 1]);
    // sql.js string binding also uses NUL termination. Bind UTF-8 bytes and cast to TEXT.
    db.run("UPDATE items SET transform=CAST(? AS TEXT)", [new TextEncoder().encode(stored)]);
    const board = await parsePur(container(db.export()));
    assert.deepEqual(board.images[0].item, [0, -2, -3, 0.5, 100, -40]);
    assert.deepEqual(transform(multiply(board.images[0].item, board.images[0].image), { x: 32, y: 24 }),
      { x: 100, y: -40 });
    const projective = storedVariant(80, [1, 0, 0.1, 0, 1, 0, 0, 0, 1]);
    assert.throws(() => decodeTransform(projective), /射影変換/);
  } finally { db.close(); }
});

test("z and exact rational sort keys determine draw order, not database row order", async () => {
  const db = await database();
  try {
    db.run(`INSERT INTO items (id,parent,transform,opacity,z,sort_order)
      SELECT id+1,parent,transform,opacity,z,sort_order FROM items;
      INSERT INTO items_images (id,image,image_transform,image_bounds,flags,playback_state,playback_frame)
      SELECT id+1,image,image_transform,image_bounds,flags,playback_state,playback_frame FROM items_images;`);
    const ids = db.exec("SELECT id FROM items ORDER BY id")[0].values.map(row => Number(row[0]));
    const key = db.exec("SELECT CAST(sort_order AS BLOB) FROM items LIMIT 1")[0].values[0][0];
    assert.ok(key instanceof Uint8Array);
    // Real fixture sort_order = 1/1; change just the low numerator limb to 2.
    const text = new TextDecoder().decode(key);
    const r = new Reader(Uint8Array.from(text, c => c.charCodeAt(0)));
    r.pos = 5;
    r.take(r.u32()); r.i32(); r.u64();
    const raw = r.bytes.slice();
    new DataView(raw.buffer).setUint32(r.pos, 2);
    const stored = [...raw].map(c => String.fromCharCode(c)).join("");
    db.run("UPDATE items SET sort_order=CAST(? AS TEXT) WHERE id=?", [new TextEncoder().encode(stored), ids[0]]);
    const ordered = await parsePur(container(db.export()));
    assert.deepEqual(ordered.images.map(image => image.id), [ids[1], ids[0]]);
    db.run("UPDATE items SET z=0 WHERE id=?", [ids[0]]);
    const byZ = await parsePur(container(db.export()));
    assert.deepEqual(byZ.images.map(image => image.id), ids);
  } finally { db.close(); }
});

test("recognizes raster MIME signatures and refuses SVG and external markup", () => {
  assert.equal(imageMime(new Uint8Array([255, 216, 255, 0])), "image/jpeg");
  assert.equal(imageMime(new TextEncoder().encode("GIF89a")), "image/gif");
  assert.equal(imageMime(new TextEncoder().encode("RIFF0000WEBP")), "image/webp");
  assert.equal(imageMime(new TextEncoder().encode("<svg onload='alert(1)'/>")), undefined);
});

test("rational order compares exactly beyond floating point precision", () => {
  assert.equal(compareOrder(
    { numerator: 9007199254740993n, denominator: 2n },
    { numerator: 9007199254740992n, denominator: 2n }), 1);
  assert.equal(compareOrder({ numerator: 1n, denominator: 2n }, { numerator: 2n, denominator: 4n }), 0);
});

test("oversized image and invalid transforms are not silently accepted", async () => {
  const db = await database();
  try {
    db.run("UPDATE images SET width=100000,height=100000");
    await assert.rejects(parsePur(container(db.export())), /40メガピクセル/);
  } finally { db.close(); }
  assert.throws(() => decodeTransform(new Uint8Array([0, 0, 0, 80, 0])), /途切れ/);
  assert.throws(() => decodeClip("not a variant"));
});
