import type { DecodedImage } from "./renderer";

export interface LoadMetrics {
  fileBytes: number;
  imageCount: number;
  totalPixels: number;
  estimatedImageBytes: number;
  elapsedMs: number;
}

export function loadMetrics(fileBytes: number, images: DecodedImage[], elapsedMs: number): LoadMetrics {
  const totalPixels = images.reduce((sum, { bitmap }) => sum + bitmap.width * bitmap.height, 0);
  return {
    fileBytes,
    imageCount: images.length,
    totalPixels,
    estimatedImageBytes: totalPixels * 4,
    elapsedMs: Math.max(0, elapsedMs),
  };
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatLoadMetrics(metrics: LoadMetrics): string {
  const elapsed = metrics.elapsedMs < 1000
    ? `${Math.round(metrics.elapsedMs)} ms`
    : `${(metrics.elapsedMs / 1000).toFixed(2)} 秒`;
  return [
    `ファイル: ${bytes(metrics.fileBytes)} (${metrics.fileBytes.toLocaleString("ja-JP")} B)`,
    `表示画像: ${metrics.imageCount.toLocaleString("ja-JP")} 件`,
    `総画素数: ${metrics.totalPixels.toLocaleString("ja-JP")} px`,
    `展開画像メモリー概算: ${bytes(metrics.estimatedImageBytes)} (RGBA 4 byte/px 換算、実測値ではありません)`,
    `読み込み時間: ${elapsed}`,
  ].join("\n");
}
