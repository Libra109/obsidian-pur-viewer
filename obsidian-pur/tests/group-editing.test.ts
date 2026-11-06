import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardEditor } from "../src/editor";
import { BoardImage, Matrix, multiply, invert, parentId, transformedBounds } from "../src/board";
import { parsePur, extractDatabase, sqlite } from "../src/parser";
import { writePurCopy, wrapDatabase } from "../src/writer";
import { groupFixture } from "./group-fixture";
import { imageCenter, rotateMatrixAboutPoint } from "../src/handles";

function close(actual: Matrix, expected: Matrix): void {
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-8 * Math.max(1, Math.abs(value), Math.abs(expected[i])),
    `${value} != ${expected[i]}`));
}
async function load(bytes: Uint8Array) {
  const board = await parsePur(bytes);
  const editor = new BoardEditor(board.images, () => {}, board.maxHiddenRootZ, board.frontmostRootId,
    board.maxItemId, board.groups, board.structureIssue, board.hiddenItems);
  return { board, editor };
}
function sameImages(actual: BoardImage[], expected: BoardImage[]): void {
  for (const before of expected.filter(image => !image.group)) {
    const after = actual.find(image => image.id === before.id)!;
    close(after.item, before.item);
    assert.deepEqual(after.data, before.data);
    assert.deepEqual(after.image, before.image);
    assert.deepEqual(after.clip, before.clip);
  }
}

test("group hierarchy navigation, transforms and background color keep child-local bytes and Undo batches", async () => {
  const source = await groupFixture(), { editor } = await load(source);
  assert.deepEqual(editor.scopeItems.map(item => item.id), [100, 3, 101]);
  editor.select(100);
  const initial = editor.snapshot();
  const group = editor.selected!;
  const center = imageCenter(group), rotated = rotateMatrixAboutPoint(group.item, center, 0.6);
  editor.transformItem(group.id, rotated);
  assert.equal(editor.dirty, true);
  const after = editor.snapshot(), delta = multiply(rotated, invert(initial.find(state => state.id === 100)!.item)!);
  for (const image of editor.images.filter(image => image.parent?.ancestors.some(parent => parent.id === 100)))
    close(image.item, multiply(delta, initial.find(state => state.id === image.id)!.item));
  editor.undo(); assert.deepEqual(editor.snapshot(), initial);
  editor.redo(); assert.deepEqual(editor.snapshot(), after);
  const output = await writePurCopy(source, after);
  const SQL = await sqlite(), a = new SQL.Database(extractDatabase(source)), b = new SQL.Database(extractDatabase(output));
  try {
    assert.deepEqual(b.exec("SELECT id,hex(CAST(transform AS BLOB)) FROM items WHERE id<>100 ORDER BY id"),
      a.exec("SELECT id,hex(CAST(transform AS BLOB)) FROM items WHERE id<>100 ORDER BY id"),
    "group transform changes only the group transform, not child-local cells");
    assert.deepEqual(b.exec("SELECT * FROM images"), a.exec("SELECT * FROM images"));
  } finally { a.close(); b.close(); }
  editor.acceptSaved(after);
  assert.equal(editor.dirty, false);
  editor.setGroupColor("#7fd23131");
  assert.equal(editor.dirty, true);
  let saved = await parsePur(await writePurCopy(output, editor.snapshot()));
  assert.equal(saved.groups!.find(item => item.id === 100)!.group!.color, "#7fd23131");
  editor.undo(); assert.equal(editor.selected!.group!.color, null);
  editor.redo();
  editor.setGroupColor(null);
  saved = await parsePur(await writePurCopy(output, editor.snapshot()));
  assert.equal(saved.groups!.find(item => item.id === 100)!.group!.color, null);
  editor.enterGroup(100);
  assert.deepEqual(editor.scopeItems.map(item => item.id), [0, 110, 1]);
  editor.enterGroup(110);
  assert.deepEqual(editor.scopeItems.map(item => item.id), [2]);
  editor.leaveGroup(); assert.equal(editor.editingParent, 100); assert.equal(editor.selectedId, 110);
  editor.leaveGroup(); assert.equal(editor.editingParent, -1); assert.equal(editor.selectedId, 100);
});

test("group creation, nesting, ungroup, saved deletion Undo and discard preserve world geometry and source data", async () => {
  let source = await groupFixture();
  const { editor } = await load(source);
  editor.enterGroup(100);
  editor.selectIds([0, 110, 1]);
  const before = editor.snapshot();
  editor.groupSelected();
  const id = editor.selectedId!;
  assert.ok(editor.selected!.group);
  assert.equal(parentId(editor.selected!), 100);
  sameImages(editor.images, before.map(state => state.content));
  const created = editor.snapshot();
  editor.undo(); assert.deepEqual(editor.snapshot(), before);
  editor.redo(); assert.deepEqual(editor.snapshot(), created);
  source = await writePurCopy(source, created, editor.deletedIds);
  editor.acceptSaved(created);
  const loaded = await parsePur(source);
  assert.equal(loaded.images.find(image => image.id === 0)!.parent!.id, id);
  assert.equal(loaded.groups!.find(image => image.id === id)!.parent!.id, 100);
  editor.select(id);
  editor.ungroupSelected();
  assert.equal(editor.images.some(image => image.id === id), false);
  sameImages(editor.images, created.map(state => state.content));
  const ungrouped = editor.snapshot();
  source = await writePurCopy(source, ungrouped, editor.deletedIds);
  editor.acceptSaved(ungrouped);
  assert.equal((await parsePur(source)).groups!.some(image => image.id === id), false);
  editor.undo();
  assert.equal(editor.dirty, true);
  source = await writePurCopy(source, editor.snapshot(), editor.deletedIds);
  assert.equal((await parsePur(source)).groups!.find(image => image.id === id)!.parent!.id, 100);
  editor.acceptSaved(editor.snapshot());
  editor.select(id); editor.removeSelected();
  const deleted = editor.snapshot();
  source = await writePurCopy(source, deleted, editor.deletedIds);
  editor.acceptSaved(deleted);
  assert.equal((await parsePur(source)).images.some(image => [0, 1].includes(image.id)), false);
  editor.undo();
  source = await writePurCopy(source, editor.snapshot(), editor.deletedIds);
  sameImages((await parsePur(source)).images, before.map(state => state.content));
  editor.discard();
  assert.deepEqual(editor.snapshot(), deleted);
  assert.equal(editor.dirty, false);
});

test("group bounds include a local ten-unit border and nested backgrounds follow subtree stacking", async () => {
  const { editor } = await load(await groupFixture());
  const group = editor.images.find(image => image.id === 110)!;
  const inverse = invert(group.item)!;
  const bounds = transformedBounds(editor.images.filter(image => parentId(image) === 110)
    .map(image => ({ ...image, item: multiply(inverse, image.item) })));
  assert.ok(Math.abs(group.width - bounds.width - 20) < 1e-8);
  assert.ok(Math.abs(group.image[4] - bounds.x + 10) < 1e-8);
  editor.bringToFront(100);
  assert.deepEqual(editor.images.filter(image => !image.group).map(image => image.id), [3, 0, 2, 1]);
  editor.undo();
  assert.deepEqual(editor.images.filter(image => !image.group).map(image => image.id), [0, 2, 1, 3]);
});

test("returning a group gesture to its start keeps exact local cells and adds no Undo", async () => {
  const source = await groupFixture(), { editor } = await load(source);
  const before = editor.snapshot(), group = editor.images.find(image => image.id === 100)!;
  const start = [...group.item] as Matrix, center = imageCenter(group);
  for (const angle of [0.2, 0.4, 0.8, 0.5]) editor.setItem(group.id, rotateMatrixAboutPoint(start, center, angle));
  editor.setItem(group.id, start);
  editor.commit(group.id, start);
  assert.deepEqual(editor.snapshot(), before);
  assert.equal(editor.canUndo, false);
  assert.equal(editor.dirty, false);
  const SQL = await sqlite(), a = new SQL.Database(extractDatabase(source)),
    b = new SQL.Database(extractDatabase(await writePurCopy(source, editor.snapshot())));
  try { assert.deepEqual(b.exec("SELECT * FROM items ORDER BY id"), a.exec("SELECT * FROM items ORDER BY id")); }
  finally { a.close(); b.close(); }
});

test("unknown children and references block destructive group operations without changing scene", async () => {
  const source = await groupFixture(), SQL = await sqlite(), db = new SQL.Database(extractDatabase(source));
  let bytes: Uint8Array;
  try {
    db.run("INSERT INTO items(id,parent,z) VALUES(200,100,2); INSERT INTO items_notes(id,text) VALUES(200,'preserve')");
    bytes = wrapDatabase(source, db.export());
  } finally { db.close(); }
  const { editor } = await load(bytes), baseline = editor.snapshot();
  editor.select(100);
  assert.throws(() => editor.removeSelected(), /未対応/);
  assert.throws(() => editor.transformItem(100, [1, 0, 0, 1, 0, 0]), /未対応/);
  assert.throws(() => editor.ungroupSelected(), /未対応/);
  assert.deepEqual(editor.snapshot(), baseline);
  const output = await writePurCopy(bytes, editor.snapshot());
  const a = new SQL.Database(extractDatabase(bytes)), b = new SQL.Database(extractDatabase(output));
  try {
    assert.deepEqual(b.exec("SELECT * FROM items_notes"), a.exec("SELECT * FROM items_notes"));
    assert.deepEqual(b.exec("SELECT * FROM items ORDER BY id"), a.exec("SELECT * FROM items ORDER BY id"));
  } finally { a.close(); b.close(); }
});

test("non-contiguous grouping uses the frontmost selected position and preserves selected mutual order", async () => {
  const source = await groupFixture(), { editor } = await load(source);
  editor.enterGroup(100);
  editor.selectIds([0, 1]);
  const before = editor.snapshot();
  editor.groupSelected();
  const id = editor.selectedId!;
  assert.deepEqual(editor.images.filter(image => !image.group).map(image => image.id), [2, 0, 1, 3]);
  const output = await writePurCopy(source, editor.snapshot(), editor.deletedIds);
  const reopened = await parsePur(output);
  assert.deepEqual(reopened.images.map(image => image.id), [2, 0, 1, 3]);
  assert.equal(reopened.images.find(image => image.id === 0)!.parent!.id, id);
  sameImages(reopened.images, before.map(state => state.content));
  editor.undo(); assert.deepEqual(editor.snapshot(), before);
});

test("unrelated notes and drawings remain exact through grouping, ungrouping, saved Undo and deletion", async () => {
  const fixture = await groupFixture(), SQL = await sqlite(), db = new SQL.Database(extractDatabase(fixture));
  let source: Uint8Array;
  try {
    db.run(`INSERT INTO items(id,parent,z,name) VALUES(200,-1,15,'note'),(201,-1,25,'drawing');
      INSERT INTO items_notes(id,text) VALUES(200,'preserve');
      INSERT INTO items_drawings(id) VALUES(201)`);
    source = wrapDatabase(fixture, db.export());
  } finally { db.close(); }
  const { board, editor } = await load(source);
  assert.equal(board.structureIssue, undefined);
  assert.deepEqual(board.hiddenItems, [{ id: 200, parent: -1, z: 15 }, { id: 201, parent: -1, z: 25 }]);
  const original = new SQL.Database(extractDatabase(source));
  const unchanged = (bytes: Uint8Array) => {
    const saved = new SQL.Database(extractDatabase(bytes));
    try {
      for (const query of ["SELECT * FROM items WHERE id IN (101,200,201) ORDER BY id",
        "SELECT * FROM items_notes", "SELECT * FROM items_drawings", "SELECT * FROM images"]) {
        assert.deepEqual(saved.exec(query), original.exec(query), query);
      }
    } finally { saved.close(); }
  };
  try {
    editor.selectIds([100, 3]);
    const initial = editor.snapshot();
    editor.groupSelected();
    const group = editor.selectedId!;
    assert.equal(editor.selected!.z, 20, "group inherits top selected slot, not a renumbered sibling z");
    const created = editor.snapshot();
    source = await writePurCopy(source, created, editor.deletedIds); unchanged(source);
    editor.acceptSaved(created);
    sameImages((await parsePur(source)).images, initial.map(state => state.content));
    editor.undo();
    source = await writePurCopy(source, editor.snapshot(), editor.deletedIds); unchanged(source);
    editor.acceptSaved(editor.snapshot());
    editor.redo();
    source = await writePurCopy(source, editor.snapshot(), editor.deletedIds); unchanged(source);
    editor.acceptSaved(editor.snapshot());
    editor.select(group); editor.ungroupSelected();
    assert.deepEqual(editor.scopeItems.map(item => item.id), [100, 3, 101]);
    assert.ok(editor.images.find(item => item.id === 100)!.z > 15);
    assert.ok(editor.images.find(item => item.id === 3)!.z < 25);
    source = await writePurCopy(source, editor.snapshot(), editor.deletedIds); unchanged(source);
    editor.acceptSaved(editor.snapshot());
    editor.undo();
    source = await writePurCopy(source, editor.snapshot(), editor.deletedIds); unchanged(source);
    editor.acceptSaved(editor.snapshot());
    editor.select(group); editor.removeSelected();
    source = await writePurCopy(source, editor.snapshot(), editor.deletedIds);
    const saved = new SQL.Database(extractDatabase(source));
    try {
      for (const query of ["SELECT * FROM items WHERE id IN (101,200,201) ORDER BY id",
        "SELECT * FROM items_notes", "SELECT * FROM items_drawings"])
        assert.deepEqual(saved.exec(query), original.exec(query));
    } finally { saved.close(); }
  } finally { original.close(); }
});

test("unknown tables, unsupported items and comment references still block grouping", async () => {
  for (const sql of ["CREATE TABLE future_reference(id INTEGER)",
    "INSERT INTO items(id,parent,z) VALUES(200,-1,2)",
    "UPDATE items SET comment=3 WHERE id=0"]) {
    const source = await groupFixture(), SQL = await sqlite(), db = new SQL.Database(extractDatabase(source));
    let bytes: Uint8Array;
    try { db.run(sql); bytes = wrapDatabase(source, db.export()); }
    finally { db.close(); }
    const { editor } = await load(bytes);
    editor.selectIds([100, 3]);
    const before = editor.snapshot();
    assert.throws(() => editor.groupSelected(), /未対応/);
    assert.deepEqual(editor.snapshot(), before);
  }
});

test("ungroup refuses an ambiguous equal-z sibling without changing the scene", async () => {
  const source = await groupFixture(), SQL = await sqlite(), db = new SQL.Database(extractDatabase(source));
  let bytes: Uint8Array;
  try {
    db.run("INSERT INTO items(id,parent,z) VALUES(200,-1,10); INSERT INTO items_notes(id,text) VALUES(200,'preserve')");
    bytes = wrapDatabase(source, db.export());
  } finally { db.close(); }
  const { editor } = await load(bytes);
  editor.select(100);
  const before = editor.snapshot();
  assert.throws(() => editor.ungroupSelected(), /重なり位置/);
  assert.deepEqual(editor.snapshot(), before);
});

test("ungroup saved Undo restores unknown group columns and original image cells", async () => {
  const SQL = await sqlite(), initial = await groupFixture(), db = new SQL.Database(extractDatabase(initial));
  let source: Uint8Array;
  try {
    db.run("ALTER TABLE items_groups ADD COLUMN future BLOB; UPDATE items_groups SET future=x'000102ff' WHERE id=100");
    source = wrapDatabase(initial, db.export());
  } finally { db.close(); }
  const { editor } = await load(source);
  editor.select(100); editor.ungroupSelected();
  const states = editor.snapshot(), deleted = await writePurCopy(source, states, editor.deletedIds);
  editor.acceptSaved(states); editor.undo();
  const restored = await writePurCopy(deleted, editor.snapshot(), editor.deletedIds);
  const a = new SQL.Database(extractDatabase(source)), b = new SQL.Database(extractDatabase(restored));
  try {
    assert.deepEqual(b.exec("SELECT * FROM items_groups ORDER BY id"), a.exec("SELECT * FROM items_groups ORDER BY id"));
    assert.deepEqual(b.exec("SELECT * FROM items ORDER BY id"), a.exec("SELECT * FROM items ORDER BY id"));
    assert.deepEqual(b.exec("SELECT * FROM items_images ORDER BY id"), a.exec("SELECT * FROM items_images ORDER BY id"));
    assert.deepEqual(b.exec("SELECT * FROM images ORDER BY id"), a.exec("SELECT * FROM images ORDER BY id"));
  } finally { a.close(); b.close(); }
});
