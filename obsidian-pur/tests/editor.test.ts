import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardImage } from "../src/board";
import { BoardEditor } from "../src/editor";

function image(id: number, x: number): BoardImage {
  return {
    id, data: new Uint8Array(), mime: "image/png", width: 64, height: 48,
    item: [1, 0, 0, 1, x, 0], image: [1, 0, 0, 1, 0, 0], opacity: 1, z: id,
  };
}

test("selection, committed moves, undo/redo and discard keep unrelated images unchanged", () => {
  const first = image(1, 0), second = image(2, 100);
  let updates = 0;
  const editor = new BoardEditor([first, second], () => updates++);
  editor.select(first.id);
  const before = [...first.item] as typeof first.item;
  const moved = [...before] as typeof first.item;
  moved[4] = 24;
  editor.setItem(first.id, moved);
  assert.equal(editor.dirty, true);
  assert.equal(editor.canUndo, false);
  editor.commit(first.id, before);
  assert.equal(editor.canUndo, true);
  assert.equal(editor.canRedo, false);
  assert.equal(second.item[4], 100);
  editor.undo();
  assert.equal(editor.dirty, false);
  assert.deepEqual(first.item, before);
  assert.equal(editor.canRedo, true);
  editor.redo();
  assert.equal(editor.dirty, true);
  assert.deepEqual(first.item, moved);
  editor.discard();
  assert.equal(editor.dirty, false);
  assert.equal(editor.canUndo, false);
  assert.equal(editor.canRedo, false);
  assert.deepEqual(first.item, before);
  assert.equal(editor.selectedId, first.id);
  assert.ok(updates >= 6);
});

test("no-op gestures do not create undo history and new edits clear redo", () => {
  const boardImage = image(1, 0);
  const editor = new BoardEditor([boardImage]);
  const initial = [...boardImage.item] as typeof boardImage.item;
  editor.commit(boardImage.id, initial);
  assert.equal(editor.canUndo, false);
  const moved = [...initial] as typeof boardImage.item;
  moved[4] = 5;
  editor.setItem(boardImage.id, moved);
  editor.commit(boardImage.id, initial);
  editor.undo();
  assert.equal(editor.canRedo, true);
  const movedAgain = [...initial] as typeof boardImage.item;
  movedAgain[5] = 12;
  editor.setItem(boardImage.id, movedAgain);
  editor.commit(boardImage.id, initial);
  assert.equal(editor.canRedo, false);
  editor.undo();
  assert.equal(boardImage.item[4], 0);
  assert.equal(boardImage.item[5], 0);
});

test("saving a snapshot updates the baseline without losing later edits or undo and redo", () => {
  const item = image(1, 0), editor = new BoardEditor([item]);
  const initial = [...item.item] as typeof item.item;
  editor.setItem(1, [1, 0, 0, 1, 10, 0]);
  editor.commit(1, initial);
  const saved = editor.snapshot();
  editor.setItem(1, [1, 0, 0, 1, 20, 0]);
  editor.commit(1, saved[0].item);
  editor.acceptSaved(saved);
  assert.equal(editor.dirty, true);
  assert.equal(editor.canUndo, true);
  editor.undo();
  assert.equal(editor.dirty, false);
  editor.undo();
  assert.equal(editor.dirty, true);
  editor.redo();
  assert.equal(editor.dirty, false);
  editor.redo();
  assert.equal(editor.dirty, true);
  editor.discard();
  assert.equal(item.item[4], 10);
  assert.equal(editor.dirty, false);
  assert.equal(editor.canUndo, false);
  const snapshot = editor.snapshot();
  snapshot[0].item[4] = 999;
  assert.equal(item.item[4], 10);
});

test("committed transforms keep rotation and flips in dirty, undo, redo and discard history", () => {
  const boardImage = image(1, 0), editor = new BoardEditor([boardImage]);
  const initial = [...boardImage.item] as typeof boardImage.item;
  const rotated = [0, 1, -1, 0, 56, -8] as typeof boardImage.item;
  editor.transformItem(boardImage.id, rotated);
  assert.equal(editor.dirty, true);
  assert.equal(editor.canUndo, true);
  editor.undo();
  assert.deepEqual(boardImage.item, initial);
  assert.equal(editor.dirty, false);
  editor.redo();
  assert.deepEqual(boardImage.item, rotated);
  const saved = editor.snapshot();
  editor.transformItem(boardImage.id, [-1, 0, 0, 1, 64, 0]);
  editor.acceptSaved(saved);
  assert.equal(editor.dirty, true, "an edit after a saved rotation remains dirty");
  editor.undo();
  assert.equal(editor.dirty, false, "Undo returns to the saved rotated snapshot");
  editor.redo();
  assert.equal(editor.dirty, true);
  editor.discard();
  assert.deepEqual(boardImage.item, rotated);
  assert.equal(editor.dirty, false);
  assert.equal(editor.canUndo, false);
});

test("bring to front preserves tie order and tracks stacking in history, dirty and saved snapshots", () => {
  const first = image(1, 0), second = image(2, 0);
  first.z = 0; second.z = 0;
  const editor = new BoardEditor([first, second], () => {}, 50);
  editor.bringToFront(1);
  assert.equal(first.z, 51, "promotion must also clear hidden root elements");
  assert.deepEqual(editor.images.map(image => image.id), [2, 1]);
  assert.equal(editor.dirty, true);
  const saved = editor.snapshot();
  editor.bringToFront(1);
  editor.undo();
  assert.equal(editor.canUndo, false, "selecting the frontmost image must not create redundant undo entries");
  assert.equal(editor.dirty, false);
  assert.deepEqual(editor.images.map(image => image.id), [1, 2]);
  editor.redo();
  editor.acceptSaved(saved);
  assert.equal(editor.dirty, false);
  editor.bringToFront(2);
  assert.equal(editor.dirty, true);
  const secondSnapshot = editor.snapshot();
  editor.bringToFront(1);
  editor.acceptSaved(secondSnapshot);
  assert.equal(editor.dirty, true, "stacking changes during saving must remain dirty");
  editor.undo();
  assert.equal(editor.dirty, false, "undoing only the concurrent promotion returns to the saved stacking snapshot");
  editor.redo();
  assert.equal(editor.dirty, true);
  editor.acceptSaved(saved);
  editor.discard();
  assert.deepEqual(editor.images.map(image => image.id), [2, 1]);
  assert.equal(first.z, 51);
  assert.equal(second.z, 0);
  const limited = new BoardEditor([image(3, 0)], () => {}, Number.MAX_VALUE);
  assert.throws(() => limited.bringToFront(3), /上限/);
  assert.equal(limited.dirty, false);
  const top = image(4, 0);
  const alreadyFront = new BoardEditor([top], () => {}, top.z, top.id);
  alreadyFront.bringToFront(top.id);
  assert.equal(alreadyFront.dirty, false, "a top image at the same z as hidden items must retain its exact sort-order precedence");
});
