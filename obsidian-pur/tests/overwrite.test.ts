import assert from "node:assert/strict";
import { test } from "node:test";
import { overwriteVerified } from "../src/overwrite";
import { gridLines } from "../src/grid";
import { Camera } from "../src/camera";

test("overwrite backs up and verifies output, refusing stale files and retaining recovery on partial writes", async () => {
  const source = new Uint8Array([1, 2, 3]), output = new Uint8Array([4, 5, 6]);
  let live: Uint8Array = source.slice(), recovery: Uint8Array | undefined;
  let current = true, writes = 0;
  const store = {
    read: async () => live,
    backup: async (bytes: Uint8Array) => { recovery = bytes.slice(); return "source.pur.uuid.bak"; },
    write: async (bytes: Uint8Array) => { writes++; live = bytes.slice(); },
  };
  assert.equal(await overwriteVerified(store, source, output, () => current), "source.pur.uuid.bak");
  assert.deepEqual(live, output);
  assert.deepEqual(recovery, source);
  await assert.rejects(overwriteVerified(store, source, output, () => current), /外部更新/);
  assert.equal(writes, 1);
  live = source.slice();
  current = false;
  await assert.rejects(overwriteVerified(store, source, output, () => current), /削除、改名/);
  current = true;
  await assert.rejects(overwriteVerified({
    ...store, backup: async () => { throw new Error("backup disk full"); },
  }, source, output, () => current), /backup disk full/);
  assert.equal(writes, 1);
  await assert.rejects(overwriteVerified({
    ...store, backup: async bytes => { await store.backup(bytes); live = new Uint8Array([9]); return "recovery.bak"; },
  }, source, output, () => current), /外部更新.*recovery.bak/);
  assert.equal(writes, 1);
  live = source.slice();
  await assert.rejects(overwriteVerified({
    ...store, write: async () => { live = output.slice(0, 1); throw new Error("partial write"); },
  }, source, output, () => current), /partial write.*復旧用コピー/);
  assert.deepEqual(recovery, source);
  live = source.slice();
  await assert.rejects(overwriteVerified({
    ...store, write: async () => { live = new Uint8Array([8]); },
  }, source, output, () => current), /再読込結果.*復旧用コピー/);
  live = source.slice();
  await assert.rejects(overwriteVerified({
    ...store, write: async bytes => { live = bytes; current = false; },
  }, source, output, () => current), /ビューが変更.*復旧用コピー/);
});

test("grid follows board coordinates and remains bounded at extreme zoom and translation", () => {
  const camera = new Camera();
  const initial = gridLines(camera, 640, 480);
  assert.ok(Math.abs(initial.x[1] - 50) < 1e-10);
  camera.x = 35; camera.y = -10;
  const moved = gridLines(camera, 640, 480);
  assert.ok(Math.abs(moved.x[0] - 35) < 1e-10);
  assert.ok(Math.abs(moved.y[0] - 40) < 1e-10);
  camera.scale = 2;
  const zoomed = gridLines(camera, 640, 480);
  assert.ok(Math.abs(zoomed.x[1] - zoomed.x[0] - 50) < 1e-10);
  for (let exponent = -20; exponent <= 6; exponent += 0.125) {
    camera.scale = 2 ** exponent;
    camera.x = 17; camera.y = -31;
    const lines = gridLines(camera, 640, 480);
    const step = lines.x[1] - lines.x[0];
    assert.ok(step >= 48 - 1e-9 && step < 96 + 1e-9, `screen spacing ${step} at scale ${camera.scale}`);
    const worldStep = step / camera.scale;
    assert.ok(Math.abs(Math.log2(worldStep / 100) - Math.round(Math.log2(worldStep / 100))) < 1e-9);
    for (const x of lines.x) {
      const multiple = (x - camera.x) / camera.scale / worldStep;
      assert.ok(Math.abs(multiple - Math.round(multiple)) < 1e-8, "lines must remain anchored in board space");
    }
    camera.x += 3;
    const panned = gridLines(camera, 640, 480);
    assert.ok(lines.x.every(x => panned.x.some(next => Math.abs(next - x - 3) < 1e-8) || x + 3 > 640));
  }
  for (const scale of [0.000001, 64, Number.MIN_VALUE, Number.MAX_VALUE]) {
    camera.scale = scale;
    camera.x = 1e300; camera.y = -1e300;
    const lines = gridLines(camera, 1e6, 1e6);
    assert.ok(lines.x.length <= 256 && lines.y.length <= 256);
    assert.ok([...lines.x, ...lines.y].every(Number.isFinite));
  }
  camera.scale = NaN;
  assert.deepEqual(gridLines(camera, 640, 480), { x: [], y: [] });
});
