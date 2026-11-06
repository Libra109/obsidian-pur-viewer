import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { imageMime } from "../src/board";
import { heicDimensions, heicPixels } from "../src/heic";
import { imageDimensions, importImage } from "../src/image-import";
import { parsePur } from "../src/parser";
import { writePurCopy } from "../src/writer";
import { BoardEditor } from "../src/editor";

const fixture = new Uint8Array(readFileSync(new URL("./fixtures/example.heic", import.meta.url)));

test("real multi-image HEIC decodes only its primary still image without changing encoded bytes", async () => {
  const original = fixture.slice();
  assert.equal(imageMime(fixture), "image/heic");
  assert.deepEqual(imageDimensions(fixture), { width: 1280, height: 854, mime: "image/heic" });
  const decoded = await heicPixels(fixture, new AbortController().signal);
  assert.equal(decoded.data.length, 1280 * 854 * 4);
  assert.equal(createHash("sha256").update(decoded.data).digest("hex"),
    "7f8f77c3e33f64338ebea81ce0102de5a0cf132061bef3176cad0373d7bada3b");
  assert.deepEqual(fixture, original);
});

test("HEIC corruption, sequences, aggregate limits and cancellation fail explicitly", async () => {
  assert.throws(() => heicDimensions(fixture.slice(0, 28)), /HEIC.*解析/);
  const sequence = fixture.slice();
  sequence.set(new TextEncoder().encode("msf1"), 8);
  assert.equal(imageMime(sequence), "image/heic-sequence");
  assert.throws(() => heicDimensions(sequence), /シーケンス.*未対応/);
  const avif = fixture.slice();
  avif.set(new TextEncoder().encode("avif"), 8);
  avif.set(new TextEncoder().encode("avif"), 20);
  assert.equal(imageMime(avif), undefined);
  await assert.rejects(importImage(fixture, { x: 0, y: 0 }, 80_000_000,
    new AbortController().signal), /80メガピクセル/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(heicPixels(fixture, controller.signal), { name: "AbortError" });
  await assert.rejects(heicPixels(fixture.slice(0, 28), new AbortController().signal), /HEIC.*解析/);
  const oversized = Buffer.from(fixture);
  const tag = Buffer.from("ispe");
  for (let p = oversized.indexOf(tag); p >= 0; p = oversized.indexOf(tag, p + 4)) {
    oversized.writeUInt32BE(10000, p + 8); oversized.writeUInt32BE(4001, p + 12);
  }
  assert.throws(() => heicDimensions(oversized), /40メガピクセル/);
  for (let p = oversized.indexOf(tag); p >= 0; p = oversized.indexOf(tag, p + 4))
    oversized.writeUInt32BE(4000, p + 12);
  assert.deepEqual(heicDimensions(oversized), { width: 10000, height: 4000 });
  const during = new AbortController();
  const pending = heicPixels(fixture, during.signal);
  during.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(heicDimensions(fixture), { width: 1280, height: 854 });
});

test("HEIC addition, placement saving and saved deletion Undo preserve all original bytes and format", async () => {
  const source = new Uint8Array(readFileSync(new URL(
    "../../crates/purcore/tests/fixtures/S1_redbar-new.pur", import.meta.url)));
  const board = await parsePur(source);
  const editor = new BoardEditor(board.images);
  const added = editor.add({ ...board.images[0], data: fixture, mime: "image/heic",
    ...heicDimensions(fixture) });
  const output = await writePurCopy(source, editor.snapshot());
  const image = (await parsePur(output)).images.find(image => image.id === added.id)!;
  assert.deepEqual(image.data, fixture);
  const format = image.stored!.source.values.format;
  assert.ok(format instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(format), "HEIC");
  editor.acceptSaved(editor.snapshot());
  const moved = [...added.item] as typeof added.item; moved[4] += 1;
  editor.transformItem(added.id, moved);
  const shifted = await writePurCopy(output, editor.snapshot());
  assert.deepEqual((await parsePur(shifted)).images.find(i => i.id === added.id)!.data, fixture);
  editor.acceptSaved(editor.snapshot()); editor.removeSelected();
  const deleted = await writePurCopy(shifted, editor.snapshot(), editor.deletedIds);
  editor.acceptSaved(editor.snapshot()); editor.undo();
  const restored = (await parsePur(await writePurCopy(deleted, editor.snapshot()))).images.find(i => i.id === added.id)!;
  assert.deepEqual(restored.data, fixture);
});
