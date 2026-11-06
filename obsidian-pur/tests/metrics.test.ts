import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLoadMetrics, loadMetrics } from "../src/metrics";

test("load metrics sum decoded instances, not unique source images", () => {
  const image = { width: 64, height: 48, close() {} } as ImageBitmap;
  const boardImage = {
    id: 1, data: new Uint8Array(), mime: "image/png", width: 64, height: 48,
    item: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    image: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    opacity: 1, z: 0,
  };
  const images = [{ image: boardImage, bitmap: image }, { image: boardImage, bitmap: image }];
  const metrics = loadMetrics(38671, images, 1234.5);
  assert.deepEqual(metrics, {
    fileBytes: 38671,
    imageCount: 2,
    totalPixels: 6144,
    estimatedImageBytes: 24576,
    elapsedMs: 1234.5,
  });
  const text = formatLoadMetrics(metrics);
  assert.match(text, /ファイル: 37\.8 KiB \(38,671 B\)/);
  assert.match(text, /表示画像: 2 件/);
  assert.match(text, /総画素数: 6,144 px/);
  assert.match(text, /展開画像メモリー概算: 24\.0 KiB \(RGBA 4 byte\/px 換算、実測値ではありません\)/);
  assert.match(text, /読み込み時間: 1\.23 秒/);
  assert.doesNotMatch(text, /プロセス|実測メモリー/);
});

test("zero images still report file size and elapsed time with zero estimate", () => {
  const text = formatLoadMetrics(loadMetrics(0, [], 0.4));
  assert.match(text, /ファイル: 0 B \(0 B\)/);
  assert.match(text, /表示画像: 0 件/);
  assert.match(text, /総画素数: 0 px/);
  assert.match(text, /展開画像メモリー概算: 0 B/);
  assert.match(text, /読み込み時間: 0 ms/);
});
