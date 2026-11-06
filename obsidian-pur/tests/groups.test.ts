import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardImage, Matrix, multiply, invert, transformedBounds } from "../src/board";
import { BoardEditor } from "../src/editor";
import { flipItem, imageCenter, imageHandles, intersectsSelection, resizeFromHandle,
  rotateMatrixAboutPoint, selectionFrame } from "../src/handles";
import { extractDatabase, parsePur, sqlite } from "../src/parser";
import { drawBoard } from "../src/renderer";
import { Camera } from "../src/camera";
import { wrapDatabase, writePurCopy } from "../src/writer";
import { groupFixture, nestedMatrix, parentMatrix, transformText } from "./group-fixture";
import { decodeTransform } from "../src/codecs";

function closeMatrix(actual: Matrix, expected: Matrix): void {
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <
    1e-8 * Math.max(1, Math.abs(expected[index])), `${value} != ${expected[index]}`));
}

test("nested groups compose parent transforms without flattening, preserve clipping, and sort whole subtrees", async () => {
  const source = await groupFixture(), board = await parsePur(source);
  assert.deepEqual(board.images.map(image => image.id), [0, 2, 1, 3],
    "child z=1000 never lifts it above the root at z=20");
  const first = board.images[0], nested = board.images[1];
  assert.equal(first.parent?.id, 100);
  assert.equal(nested.parent?.id, 110);
  closeMatrix(first.item, multiply(parentMatrix, [15.625, 0, 0, 15.625, 500, 375]));
  closeMatrix(nested.parent!.transform, multiply(parentMatrix, nestedMatrix));
  closeMatrix(nested.item, multiply(multiply(parentMatrix, nestedMatrix), [15.625, 0, 0, 15.625, 500, 375]));
  assert.equal(first.clip?.elements.length, 5);
  assert.equal(nested.clip?.elements.length, 5, "image-local clipping is retained");
  const center = imageCenter(nested);
  assert.equal(intersectsSelection(nested, { x: center.x - 1, y: center.y - 1 },
    { x: center.x + 1, y: center.y + 1 }), true);
  const operations: unknown[][] = [];
  const context = new Proxy({}, {
    get: (_, name) => (...args: unknown[]) => operations.push([name, ...args]),
    set: (_, name, value) => { operations.push([name, value]); return true; },
  }) as CanvasRenderingContext2D;
  drawBoard(context, [{ image: nested, bitmap: {} as ImageBitmap }], new Camera());
  assert.deepEqual(operations.filter(operation => operation[0] === "transform"),
    [["transform", ...nested.item], ["transform", ...nested.image]]);
  assert.ok(operations.findIndex(operation => operation[0] === "clip") <
    operations.findLastIndex(operation => operation[0] === "transform"));
  const output = await writePurCopy(source, new BoardEditor(board.images).snapshot());
  const SQL = await sqlite(), before = new SQL.Database(extractDatabase(source)),
    after = new SQL.Database(extractDatabase(output));
  try {
    for (const table of ["items", "items_images", "images", "items_groups"])
      assert.deepEqual(after.exec(`SELECT * FROM ${table} ORDER BY id`), before.exec(`SELECT * FROM ${table} ORDER BY id`),
        "no-op save preserves exact original local rows");
  } finally { before.close(); after.close(); }
});

test("front promotion stays within the parent and additions remain root-level above all root groups", async () => {
  const board = await parsePur(await groupFixture());
  const seed = board.images[0];
  const editor = new BoardEditor(board.images, () => {}, board.maxHiddenRootZ, board.frontmostRootId, board.maxItemId, board.groups);
  editor.bringToFront(0);
  assert.deepEqual(editor.images.filter(image => !image.group).map(image => image.id), [2, 1, 0, 3]);
  assert.equal(editor.images.find(image => image.id === 0)!.z, 1001);
  editor.bringToFront(0);
  editor.undo();
  assert.equal(editor.canUndo, false);
  assert.deepEqual(editor.images.filter(image => !image.group).map(image => image.id), [0, 2, 1, 3]);
  editor.bringToFront(2);
  assert.equal(editor.canUndo, false, "only child in nested group is already frontmost");
  editor.bringToFront(3);
  assert.equal(editor.images.find(image => image.id === 3)!.z, 31,
    "root promotion ignores child z=1000 but clears hidden group z=30");
  const added = editor.add(seed);
  assert.equal(added.parent, undefined);
  assert.equal(added.stored, undefined);
  assert.equal(added.z, 32);
  assert.equal(editor.images[editor.images.length - 1], added);
  const clones = [0, 1].map(id => ({ ...seed, parent: undefined, id, z: 1 }));
  const clonedEditor = new BoardEditor(clones);
  clonedEditor.bringToFront(0);
  clonedEditor.undo();
  assert.deepEqual(clonedEditor.images.map(image => image.id), [0, 1],
    "copied sibling metadata still falls back to original tie order");
});

test("equal-z root images and group subtrees keep sibling order after resort and Undo", async () => {
  const source = await groupFixture(), SQL = await sqlite(), db = new SQL.Database(extractDatabase(source));
  let bytes: Uint8Array;
  try {
    db.run("UPDATE items SET z=1 WHERE id=100");
    db.run("UPDATE items SET z=10,sort_order=NULL WHERE id IN (3,101)");
    db.run(`INSERT INTO items(id,parent,z,opacity,locked,transform)
      SELECT 4,101,1,opacity,locked,transform FROM items WHERE id=0`);
    db.run(`INSERT INTO items_images(id,image,image_transform,image_bounds,flags)
      SELECT 4,image,image_transform,image_bounds,flags FROM items_images WHERE id=0`);
    bytes = wrapDatabase(source, db.export());
  } finally { db.close(); }
  const board = await parsePur(bytes);
  assert.deepEqual(board.images.map(image => image.id), [0, 2, 1, 3, 4]);
  const editor = new BoardEditor(board.images);
  editor.bringToFront(0);
  editor.undo();
  assert.deepEqual(editor.images.map(image => image.id), [0, 2, 1, 3, 4]);
  assert.deepEqual((await parsePur(await writePurCopy(bytes, editor.snapshot()))).images.map(image => image.id),
    [0, 2, 1, 3, 4]);
});

test("grouped edits save local transforms, keep all parent rows and restore saved deletion membership", async () => {
  const source = await groupFixture(), board = await parsePur(source);
  const editor = new BoardEditor(board.images, () => {}, board.maxHiddenRootZ, board.frontmostRootId, board.maxItemId);
  editor.selectIds([0, 2, 3]);
  const baseline = editor.snapshot();
  const frame = selectionFrame(editor.selectedImages)!;
  const handles = imageHandles(frame), start = handles[4], anchor = handles[0];
  const vector = { x: start.x - anchor.x, y: start.y - anchor.y };
  editor.setItems(baseline.filter(state => editor.isSelected(state.id)).map(state => ({ id: state.id,
    item: resizeFromHandle(state.item, anchor, vector, start, { x: start.x + vector.x / 2, y: start.y + vector.y / 2 }) })));
  editor.commitItems(baseline);
  const scaled = editor.snapshot();
  editor.undo(); assert.deepEqual(editor.snapshot(), baseline);
  editor.redo(); assert.deepEqual(editor.snapshot(), scaled);
  const center = imageCenter(selectionFrame(editor.selectedImages)!);
  editor.setItems(editor.selectedImages.map(image => ({ id: image.id,
    item: rotateMatrixAboutPoint(image.item, center, 0.7) })));
  editor.commitItems(scaled);
  editor.select(2);
  editor.transformItem(2, flipItem(editor.selected!, "horizontal"));
  editor.transformItem(2, flipItem(editor.selected!, "vertical"));
  editor.selectIds([0, 2, 3]);
  for (const alignment of ["left", "right", "top", "bottom", "horizontal-center", "vertical-center"] as const) {
    const before = editor.snapshot();
    editor.alignSelected(alignment);
    editor.undo();
    assert.deepEqual(editor.snapshot(), before);
    editor.redo();
    const saved = editor.snapshot(), output = await writePurCopy(source, saved);
    const reopened = await parsePur(output);
    for (const expected of saved) {
      const actual = reopened.images.find(image => image.id === expected.id)!;
      closeMatrix(actual.item, expected.item);
      assert.deepEqual(actual.data, expected.content.data);
      assert.deepEqual(actual.image, expected.content.image);
      assert.deepEqual(actual.clip, expected.content.clip);
      assert.equal(actual.parent?.id, expected.content.parent?.id);
    }
  }
  editor.bringToFront(0);
  const saved = editor.snapshot(), output = await writePurCopy(source, saved);
  const SQL = await sqlite(), original = new SQL.Database(extractDatabase(source)),
    db = new SQL.Database(extractDatabase(output));
  try {
    for (const table of ["items_groups", "items_images", "images"])
      assert.deepEqual(db.exec(`SELECT * FROM ${table} ORDER BY id`), original.exec(`SELECT * FROM ${table} ORDER BY id`));
    assert.deepEqual(db.exec("SELECT * FROM items WHERE id>=100 ORDER BY id"),
      original.exec("SELECT * FROM items WHERE id>=100 ORDER BY id"), "parent and group rows never change");
    for (const state of saved) {
      assert.deepEqual(db.exec(`SELECT parent,sort_order,locked,opacity,comment,name FROM items WHERE id=${state.id}`),
        original.exec(`SELECT parent,sort_order,locked,opacity,comment,name FROM items WHERE id=${state.id}`));
      const raw = db.exec(`SELECT CAST(transform AS BLOB) FROM items WHERE id=${state.id}`)[0].values[0][0];
      assert.ok(raw instanceof Uint8Array);
      const local = decodeTransform(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      closeMatrix(local, state.content.parent ? multiply(invert(state.content.parent.transform)!, state.item) : state.item);
    }
  } finally { db.close(); original.close(); }
  editor.acceptSaved(saved);
  editor.selectIds([0, 2]);
  editor.removeSelected();
  const deleted = await writePurCopy(output, editor.snapshot(), editor.deletedIds);
  assert.deepEqual((await parsePur(deleted)).images.map(image => image.id), [1, 3]);
  editor.acceptSaved(editor.snapshot());
  editor.undo();
  assert.equal(editor.dirty, true);
  const restored = await parsePur(await writePurCopy(deleted, editor.snapshot(), editor.deletedIds));
  assert.equal(restored.images.find(image => image.id === 0)!.parent!.id, 100);
  assert.equal(restored.images.find(image => image.id === 2)!.parent!.id, 110);
  for (const expected of saved) closeMatrix(restored.images.find(image => image.id === expected.id)!.item, expected.item);
});

test("malformed and unsupported group ancestry fails or warns instead of flattening images", async () => {
  const source = await groupFixture(), SQL = await sqlite();
  for (const [change, error] of [
    ["UPDATE items SET parent=110 WHERE id=100", /循環/],
    ["UPDATE items SET transform=CAST(? AS TEXT) WHERE id=100", /逆変換/],
  ] as const) {
    const db = new SQL.Database(extractDatabase(source));
    try {
      db.run(change, change.includes("?") ? [transformText([0, 0, 0, 0, 0, 0])] : []);
      await assert.rejects(parsePur(wrapDatabase(source, db.export())), error);
    } finally { db.close(); }
  }
  for (const change of ["UPDATE items SET parent=999 WHERE id=0", "UPDATE items SET opacity=0.5 WHERE id=100",
    "UPDATE items SET locked=1 WHERE id=100", "UPDATE items_groups SET lock_mode=3 WHERE id=100"]) {
    const db = new SQL.Database(extractDatabase(source));
    try {
      db.run(change);
      const board = await parsePur(wrapDatabase(source, db.export()));
      assert.ok(board.warnings.some(warning => /グループ/.test(warning)));
      assert.equal(board.images.some(image => image.id === 0), false);
    } finally { db.close(); }
  }
});
