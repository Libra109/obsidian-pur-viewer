import assert from "node:assert/strict";
import { test } from "node:test";
import { BackupRecord, BackupStore, PurBackups } from "../src/backups";
import { overwriteVerified } from "../src/overwrite";
import { sameBytes } from "../src/save-copy";

function harness() {
  const files = new Map<string, Uint8Array>();
  let records: BackupRecord[] = [];
  let failPersist = false, failRemove = false;
  const store: BackupStore = {
    exists: async path => files.has(path),
    read: async path => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`missing: ${path}`);
      return bytes.slice();
    },
    create: async (path, bytes) => {
      assert.equal(files.has(path), false, "never replace an existing file");
      files.set(path, bytes.slice());
    },
    remove: async (path, expected) => {
      if (failRemove) throw new Error(`delete failed: ${path}`);
      assert.ok(sameBytes(files.get(path)!, expected));
      files.delete(path);
    },
  };
  const persist = async (value: BackupRecord[]) => {
    if (failPersist) throw new Error("metadata disk full");
    records = structuredClone(value);
  };
  let backups = new PurBackups(undefined, persist);
  return {
    files, store, get backups() { return backups; }, get records() { return records; },
    restart: () => { backups = new PurBackups(records, persist); },
    persistFails: (value: boolean) => { failPersist = value; },
    removeFails: (value: boolean) => { failRemove = value; },
  };
}

test("first and consecutive saves retain only the immediately preceding bytes, including after restart", async () => {
  const h = harness();
  const path = "boards/source.pur";
  let live = new Uint8Array([0]);
  for (let i = 1; i <= 5; i++) {
    const source = live.slice();
    const output = new Uint8Array([i]);
    const backup = await overwriteVerified({
      read: async () => live,
      backup: bytes => h.backups.prepare(h.store, path, bytes, () => true),
      write: async bytes => {
        assert.deepEqual(h.files.get(h.records[h.records.length - 1].path), source);
        live = bytes.slice();
      },
    }, source, output, () => true);
    await h.backups.prune(h.store, backup);
    assert.equal(h.files.size, 1);
    assert.equal(h.records.length, 1);
    assert.deepEqual(h.files.get(backup), source);
    assert.deepEqual(live, output);
    h.restart();
  }
});

test("failed/partial source writes keep previous and current recovery copies; retry reuses and rotates them", async () => {
  const h = harness();
  const old = await h.backups.prepare(h.store, "a.pur", new Uint8Array([0]), () => true);
  let live = new Uint8Array([1]);
  const source = live.slice(), output = new Uint8Array([2]);
  await assert.rejects(overwriteVerified({
    read: async () => live,
    backup: bytes => h.backups.prepare(h.store, "a.pur", bytes, () => true),
    write: async () => { live = new Uint8Array(); throw new Error("partial write"); },
  }, source, output, () => true), /partial write.*復旧用コピー/);
  assert.equal(h.files.size, 2);
  assert.deepEqual(h.files.get(old), new Uint8Array([0]));
  assert.ok([...h.files.values()].some(bytes => sameBytes(bytes, source)));
  h.restart();
  const backup = await h.backups.prepare(h.store, "a.pur", source, () => true);
  assert.equal(h.files.size, 2, "retry must not create an extra backup");
  live = output.slice();
  await h.backups.prune(h.store, backup);
  assert.equal(h.files.size, 1);
  assert.deepEqual(h.files.get(backup), source);
});

test("source conflicts and view changes never write the source or prune recovery", async () => {
  const h = harness();
  const source = new Uint8Array([1]), output = new Uint8Array([2]);
  const old = await h.backups.prepare(h.store, "a.pur", new Uint8Array([0]), () => true);
  let live = new Uint8Array([9]), current = true, writes = 0;
  const store = {
    read: async () => live,
    backup: async (bytes: Uint8Array) => {
      const path = await h.backups.prepare(h.store, "a.pur", bytes, () => current);
      live = new Uint8Array([9]);
      return path;
    },
    write: async () => { writes++; },
  };
  await assert.rejects(overwriteVerified(store, source, output, () => current), /外部更新/);
  assert.equal(h.files.size, 1);
  live = source;
  await assert.rejects(overwriteVerified(store, source, output, () => current), /外部更新/);
  assert.equal(writes, 0);
  assert.ok(h.files.has(old));
  current = false;
  await assert.rejects(h.backups.prepare(h.store, "b.pur", source, () => current), /変更/);
  assert.equal(h.files.size, 2);
});

test("backup collision, partial creation and metadata failures preserve existing files and refuse source write", async () => {
  const h = harness();
  const source = new Uint8Array([1, 2, 3]);
  const old = await h.backups.prepare(h.store, "a.pur", new Uint8Array([0]), () => true);
  await assert.rejects(h.backups.prepare({
    ...h.store, exists: async () => true,
    create: async () => { assert.fail("collision must not create"); },
  }, "b.pur", source, () => true), /競合/);
  await assert.rejects(h.backups.prepare({
    ...h.store, create: async (path, bytes) => {
      h.files.set(path, bytes.subarray(0, 1));
      throw new Error("partial backup");
    },
  }, "b.pur", source, () => true), /partial backup.*不完全/);
  assert.deepEqual(h.files.get(old), new Uint8Array([0]));
  assert.equal(h.records.length, 1);
  h.persistFails(true);
  await assert.rejects(h.backups.prepare(h.store, "b.pur", source, () => true), /metadata disk full.*管理未登録/);
  assert.equal(h.records.length, 1);
  h.persistFails(false);
  const backup = await h.backups.prepare(h.store, "a.pur", source, () => true);
  await h.backups.prune(h.store, backup);
  assert.equal(h.files.size, 3, "unregistered partial copies must not be deleted");
});

test("cleanup refuses modified copies, reports deletion/metadata failures and can retry safely", async () => {
  const h = harness();
  const first = await h.backups.prepare(h.store, "a.pur", new Uint8Array([0]), () => true);
  const second = await h.backups.prepare(h.store, "a.pur", new Uint8Array([1]), () => true);
  h.files.set(second, new Uint8Array([9]));
  await assert.rejects(h.backups.prune(h.store, second), /直前.*変更/);
  assert.ok(h.files.has(first));
  h.files.set(second, new Uint8Array([1]));
  h.files.set(first, new Uint8Array([9]));
  await assert.rejects(h.backups.prune(h.store, second), /外部変更.*削除しません/);
  assert.equal(h.files.size, 2);
  h.files.set(first, new Uint8Array([0]));
  h.removeFails(true);
  await assert.rejects(h.backups.prune(h.store, second), /delete failed/);
  assert.equal(h.files.size, 2);
  h.removeFails(false);
  h.persistFails(true);
  await assert.rejects(h.backups.prune(h.store, second), /metadata disk full/);
  assert.equal(h.files.size, 1, "new recovery must survive metadata failure after deleting old copy");
  h.persistFails(false);
  await h.backups.prune(h.store, second);
  assert.equal(h.records.length, 1);
  assert.deepEqual(h.files.get(second), new Uint8Array([1]));
});

test("rename retains ownership without moving backups, while unknown old UUID copies remain untouched", async () => {
  const h = harness();
  const legacy = "folder/a.pur.lazyref-00000000-0000-4000-8000-000000000000.bak";
  h.files.set(legacy, new Uint8Array([9]));
  h.files.set("other.pur.lazyref-managed-00000000-0000-4000-8000-000000000000.bak", new Uint8Array([8]));
  await h.backups.prepare(h.store, "folder/a.pur", new Uint8Array([0]), () => true);
  await h.backups.rename("folder/a.pur", "renamed.pur");
  h.restart();
  const latest = await h.backups.prepare(h.store, "renamed.pur", new Uint8Array([1]), () => true);
  await h.backups.prune(h.store, latest);
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].source, "renamed.pur");
  assert.equal(h.files.size, 3);
  assert.deepEqual(h.files.get(legacy), new Uint8Array([9]));
  await h.backups.prepare(h.store, "occupied.pur", new Uint8Array([2]), () => true);
  await assert.rejects(h.backups.rename("renamed.pur", "occupied.pur"), /別のバックアップ/);
  await assert.rejects(h.backups.prune(h.store, latest), /競合.*削除しません/);
  h.restart();
  await assert.rejects(h.backups.prepare(h.store, "occupied.pur", new Uint8Array([3]), () => true), /改名時/);
  assert.equal(h.files.size, 4);
});

test("rename metadata failure blocks saves at the destination without deleting recovery", async () => {
  const h = harness();
  const backup = await h.backups.prepare(h.store, "a.pur", new Uint8Array([0]), () => true);
  h.persistFails(true);
  await assert.rejects(h.backups.rename("a.pur", "b.pur"), /metadata disk full/);
  h.persistFails(false);
  await assert.rejects(h.backups.prepare(h.store, "b.pur", new Uint8Array([1]), () => true), /改名時/);
  assert.equal(h.files.size, 1);
  assert.deepEqual(h.files.get(backup), new Uint8Array([0]));
});

test("temporarily renaming away the pur extension retains valid persistent ownership", async () => {
  const h = harness();
  await h.backups.prepare(h.store, "a.pur", new Uint8Array([0]), () => true);
  await h.backups.rename("a.pur", "a.txt");
  h.restart();
  await h.backups.rename("a.txt", "a.pur");
  const latest = await h.backups.prepare(h.store, "a.pur", new Uint8Array([1]), () => true);
  await h.backups.prune(h.store, latest);
  assert.equal(h.files.size, 1);
  assert.equal(h.records[0].source, "a.pur");
});

test("folder rename keeps each source's generation separate and never adopts another source's backup", async () => {
  const h = harness();
  await h.backups.prepare(h.store, "old/a.pur", new Uint8Array([0]), () => true);
  const other = await h.backups.prepare(h.store, "old/b.pur", new Uint8Array([9]), () => true);
  for (const [path, bytes] of [...h.files]) {
    h.files.delete(path);
    h.files.set(path.replace(/^old\//, "new/"), bytes);
  }
  await h.backups.rename("old", "new");
  h.restart();
  const latest = await h.backups.prepare(h.store, "new/a.pur", new Uint8Array([1]), () => true);
  await h.backups.prune(h.store, latest);
  assert.equal(h.files.size, 2);
  assert.deepEqual(h.files.get(other.replace(/^old\//, "new/")), new Uint8Array([9]));
  assert.deepEqual(h.records.map(record => record.source).sort(), ["new/a.pur", "new/b.pur"]);
});

test("managed metadata validation cannot adopt arbitrary paths or old copies", () => {
  for (const path of ["notes.md", "../a.pur.lazyref-managed-00000000-0000-4000-8000-000000000000.bak",
    "a.pur.lazyref-00000000-0000-4000-8000-000000000000.bak"]) {
    assert.throws(() => new PurBackups([{ source: "a.pur", path, sha256: "0".repeat(64) }], async () => {}), /管理情報/);
  }
});
