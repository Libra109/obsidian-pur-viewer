import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { browserOptions } from "../build.mjs";

const bundle = await build({
  ...browserOptions, entryPoints: ["tests/browser-harness.ts"], write: false, format: "iife",
});
const heicApi = await build({
  ...browserOptions, entryPoints: ["src/heic.ts"], write: false, format: "iife", globalName: "Heic",
});
const routes = new Map([
  ["/fixture/v2", await readFile(new URL("../../crates/purcore/tests/fixtures/S1_redbar-new.pur", import.meta.url))],
  ["/fixture/heic", await readFile(new URL("./fixtures/example.heic", import.meta.url))],
  ["/test.js", bundle.outputFiles[0].contents],
  ["/heic-api.js", heicApi.outputFiles[0].contents],
  ["/styles.css", await readFile(new URL("../styles.css", import.meta.url))],
]);
const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>PUR browser smoke test</title>
<link rel="stylesheet" href="/styles.css"><style>
body { margin: 0; color: #eee; background: #222; font: 14px sans-serif; }
.lazyref-pur { display:flex; flex-direction:column; height:100vh; }
#result { max-height: 28vh; overflow:auto; white-space:pre-line; padding: 8px; }
</style><div class="lazyref-pur"><div class="lazyref-pur-toolbar">
<button id="fit">全体表示</button><button id="out">縮小</button><button id="in">拡大</button>
<span>ブラウザー描画テスト（Obsidian実機ではありません）</span></div>
<div id="metrics" class="lazyref-pur-status"></div><div id="result">RUNNING</div>
<canvas class="lazyref-pur-canvas" tabindex="0"></canvas></div>
<script src="/test.js"></script></html>`;
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (path === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(html); return;
  }
  const content = routes.get(path);
  if (!content) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "Content-Type": path.endsWith(".js") ? "text/javascript" :
    path.endsWith(".css") ? "text/css" : "application/octet-stream" });
  response.end(content);
});
server.listen(0, "127.0.0.1", () => {
  console.log(`PUR_BROWSER_TEST_URL=http://127.0.0.1:${server.address().port}`);
});
