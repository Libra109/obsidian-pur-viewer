import { BoardImage, boardBounds, Matrix, multiply, transform } from "../src/board";
import { extractDatabase, parsePur, sqlite } from "../src/parser";
import { BoardRenderer, decodeImages, drawBoard } from "../src/renderer";
import { Camera } from "../src/camera";
import { formatLoadMetrics, loadMetrics } from "../src/metrics";
import { BoardEditor } from "../src/editor";
import { wrapDatabase, writePurCopy } from "../src/writer";
import { drawGrid, gridLines } from "../src/grid";
import {
  flipItem, imageCenter, imageHandles, resizeCursor, resizeFromHandle, rotateMatrixAboutPoint, rotationHandles,
} from "../src/handles";
import { BackupRecord, BackupStore, PurBackups } from "../src/backups";
import { overwriteVerified } from "../src/overwrite";
import { sameBytes } from "../src/save-copy";
import { IdleAutosave } from "../src/autosave";
import { decodeRaster, importImage } from "../src/image-import";
import { animatedWebp, bmpFixture, firstFrame, gifFixture } from "./raster-fixtures";
import SparkMD5 from "spark-md5";
import { svgDataUrl, svgDimensions, validateSvg } from "../src/svg";
import { svgFixture } from "./svg-fixtures";
import { disposeHeicWorker, heicPixels, setHeicFallbackHandler } from "../src/heic";
import { codecPixels } from "../src/heic-codec";
import createHeif from "libheif-js/libheif/libheif.js";

async function run(): Promise<void> {
  const results: string[] = [];
  const assert = (condition: boolean, message: string): void => {
    if (!condition) throw new Error(message);
    results.push(message);
  };
  {
    let saves = 0;
    const autosave = new IdleAutosave(() => saves++, 1);
    const image: BoardImage = {
      id: 900, width: 1, height: 1, item: [1, 0, 0, 1, 0, 0],
      image: [1, 0, 0, 1, 0, 0], data: new Uint8Array(), mime: "image/png", opacity: 1, z: 0,
    };
    const editor = new BoardEditor([image], () => autosave.changed(true));
    editor.setItem(image.id, [1, 0, 0, 1, 1, 0]);
    await new Promise<void>(resolve => window.setTimeout(resolve, 20));
    autosave.dispose();
    assert(saves === 1, "実ブラウザー既定タイマーで編集通知から自動保存を予約");
  }
  const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  {
    const bytes = new Uint8Array(await (await fetch("/fixture/heic")).arrayBuffer());
    const source = new Uint8Array(await (await fetch("/fixture/v2")).arrayBuffer());
    const signal = new AbortController().signal;
    const nativeWorker = window.Worker;
    let createdWorkers = 0, terminatedWorkers = 0;
    let cancelAfterReady: AbortController | undefined;
    const fallbacks: string[] = [];
    window.Worker = class extends nativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        createdWorkers++;
        this.addEventListener("message", event => {
          if (event.data.kind === "ready" && cancelAfterReady) {
            const controller = cancelAfterReady;
            cancelAfterReady = undefined;
            setTimeout(() => controller.abort(), 10);
          }
        });
      }
      terminate(): void { terminatedWorkers++; super.terminate(); }
    };
    setHeicFallbackHandler(message => fallbacks.push(message));
    const rgba = await heicPixels(bytes, signal);
    assert(rgba.width === 1280 && rgba.height === 854, "実HEICコレクションの主画像のみを展開");
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(rgba.data))))
      .map(v => v.toString(16).padStart(2, "0")).join("");
    assert(hash === "7f8f77c3e33f64338ebea81ce0102de5a0cf132061bef3176cad0373d7bada3b",
      "HEIC WASM Workerの画素が固定期待値と一致");
    assert(createdWorkers === 1 && terminatedWorkers === 1 && fallbacks.length === 0,
      "WASM Workerを実際に起動し処理終了後に破棄");
    const legacy = await codecPixels(bytes, signal, createHeif());
    assert(sameBytes(new Uint8Array(rgba.data), new Uint8Array(legacy.data)),
      "WASM Workerと従来JSデコーダーの全画素が一致");
    const original = bytes.slice();
    const parallel = await Promise.all([heicPixels(bytes, signal), heicPixels(bytes, signal)]);
    assert(parallel.every(image => sameBytes(new Uint8Array(image.data), new Uint8Array(rgba.data))),
      "同時HEIC要求を単一Worker内で直列処理し応答を対応付け");
    const aborted = new AbortController();
    cancelAfterReady = aborted;
    const canceled = heicPixels(bytes, aborted.signal).then(() => false, error => error.name === "AbortError");
    const survivor = heicPixels(bytes, signal);
    assert(await canceled && (await survivor).width === 1280,
      "HEIC中断はWorkerを破棄し他要求は新Workerで完了");
    const closing = heicPixels(bytes, signal).then(() => false, error => error.name === "AbortError");
    disposeHeicWorker();
    assert(await closing && createdWorkers === terminatedWorkers,
      "終了時に保留HEICを中断し全Workerを破棄");
    assert(sameBytes(bytes, original), "Worker入力の元バッファーは転送で失われず全バイト保持");
    const imported = await importImage(bytes, { x: 0, y: 0 }, 0, signal);
    try {
      const board = await parsePur(source);
      const editor = new BoardEditor(board.images);
      const added = editor.add(imported.content);
      const output = await writePurCopy(source, editor.snapshot());
      const image = (await parsePur(output)).images.find(i => i.id === added.id)!;
      assert(image.mime === "image/heic" && sameBytes(image.data, bytes), "HEIC保存後の元バイトと形式が一致");
      const decoded = await decodeImages([image], signal);
      try {
        const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 854;
        const context = canvas.getContext("2d")!;
        context.drawImage(decoded[0].bitmap, 0, 0);
        const saved = context.getImageData(0, 0, 1280, 854).data;
        assert(saved.every((v, i) => Math.abs(v - rgba.data[i]) <= 1), "HEIC保存再解析後の描画画素が一致");
        canvas.width = 0; canvas.height = 0;
      } finally { decoded[0].bitmap.close(); }
      editor.acceptSaved(editor.snapshot()); editor.removeSelected();
      const deleted = await writePurCopy(output, editor.snapshot(), editor.deletedIds);
      editor.acceptSaved(editor.snapshot()); editor.undo();
      const restored = await parsePur(await writePurCopy(deleted, editor.snapshot()));
      assert(sameBytes(restored.images.find(i => i.id === added.id)!.data, bytes), "HEIC削除保存後Undoも全バイトを保持");
    } finally { imported.bitmap.close(); }
    let rejected = false;
    try { await importImage(bytes.subarray(0, 28), { x: 0, y: 0 }, 0, signal); } catch { rejected = true; }
    assert(rejected, "破損HEICを空画像に置き換えず拒否");
    assert(fallbacks.length === 0, "破損HEICは従来方式へ切り替えずエラー");
    const limits = await heicPixels(bytes, signal, { maxPixels: 1 }).then(() => false,
      error => error.message.includes("80メガピクセル"));
    const mismatch = await heicPixels(bytes, signal, { width: 1, height: 1 }).then(() => false,
      error => error.message.includes("保存寸法"));
    assert(limits && mismatch, "WASM Workerは集計予算と保存寸法を展開前に検証");
    assert(createdWorkers === terminatedWorkers, "成功と破損と制限エラーでもWorkerを残さない");
    window.Worker = nativeWorker;
    setHeicFallbackHandler();
    for (const [id, policy] of [
      ["worker-blocked", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'none'"],
      ["wasm-blocked", "script-src 'self' 'unsafe-inline'; worker-src blob:"],
    ]) {
      const frame = document.createElement("iframe");
      frame.hidden = true;
      document.body.appendChild(frame);
      try {
        const result = await new Promise<{ ok: boolean; notices: number; hash: string; error?: string }>(
          (resolve, reject) => {
            const receive = (event: MessageEvent) => {
              if (event.source !== frame.contentWindow || event.data.id !== id) return;
              clearTimeout(timeout);
              window.removeEventListener("message", receive);
              resolve(event.data);
            };
            const timeout = setTimeout(() => {
              window.removeEventListener("message", receive);
              reject(new Error(`${id}: fallback test timed out`));
            }, 20000);
            window.addEventListener("message", receive);
            frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${policy}">
              <script src="/heic-api.js"></script><script>
              (async()=>{let notices=0;Heic.setHeicFallbackHandler(()=>notices++);
              const b=new Uint8Array(await(await fetch('/fixture/heic')).arrayBuffer());
              const p=await Heic.heicPixels(b,new AbortController().signal);
              const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',p.data)),
                v=>v.toString(16).padStart(2,'0')).join('');
              parent.postMessage({id:'${id}',ok:true,notices,hash},'*');
              })().catch(e=>parent.postMessage({id:'${id}',ok:false,error:e.message},'*'));
              </script>`;
          });
        assert(result.ok && result.notices === 1 &&
          result.hash === "7f8f77c3e33f64338ebea81ce0102de5a0cf132061bef3176cad0373d7bada3b",
        `${id}: 実CSP制限下で通知して従来方式へ切り替え画素を保持 (${result.error ?? "ok"})`);
      } finally { frame.remove(); }
    }
  }
  {
    const source = new Uint8Array(await (await fetch("/fixture/v2")).arrayBuffer());
    const bytes = svgDataUrl(`data:image/svg+xml;base64,${btoa(new TextDecoder().decode(svgFixture))}`);
    assert(sameBytes(bytes, svgFixture), "SVGデータURLの全バイトを保持");
    const imported = await importImage(bytes, { x: 0, y: 0 }, 0, new AbortController().signal);
    const canvas = document.createElement("canvas");
    canvas.width = 3; canvas.height = 2;
    const ctx = canvas.getContext("2d")!;
    const pixels = (bitmap: ImageBitmap) => {
      ctx.clearRect(0, 0, 3, 2); ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, 3, 2).data.slice();
    };
    try {
      const expected = pixels(imported.bitmap);
      assert(expected[0] === 255 && expected[1] === 0 && expected[3] === 255 && expected[11] === 0,
        "SVGのパス、内部グラデーション、透過を描画");
      const board = await parsePur(source);
      const editor = new BoardEditor(board.images);
      const image = editor.add(imported.content);
      const output = await writePurCopy(source, editor.snapshot());
      const reopened = await parsePur(output);
      const added = reopened.images.find(i => i.id === image.id)!;
      assert(added.mime === "image/svg+xml" && sameBytes(added.data, svgFixture),
        "SVG保存後の元バイトと形式が一致");
      const decoded = await decodeImages([added], new AbortController().signal);
      try { assert(pixels(decoded[0].bitmap).every((v, i) => v === expected[i]), "既存PUR内SVGの再描画が一致"); }
      finally { decoded[0].bitmap.close(); }
      editor.acceptSaved(editor.snapshot());
      const moved = [...image.item] as Matrix; moved[4] += 10;
      editor.transformItem(image.id, moved);
      const preserved = await parsePur(await writePurCopy(output, editor.snapshot()));
      assert(sameBytes(preserved.images.find(i => i.id === image.id)!.data, svgFixture),
        "SVG配置変更後も元バイトを保持");
      editor.undo(); editor.removeSelected();
      const deleted = await writePurCopy(output, editor.snapshot(), editor.deletedIds);
      editor.acceptSaved(editor.snapshot()); editor.undo();
      const restored = await parsePur(await writePurCopy(deleted, editor.snapshot()));
      assert(sameBytes(restored.images.find(i => i.id === image.id)!.data, svgFixture),
        "SVG削除保存後Undoも元バイトを保持");
    } finally { imported.bitmap.close(); }
    const wrap = (body: string, attrs = "") => new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2" ${attrs}>${body}</svg>`);
    for (const bytes of [
      wrap('<script>alert(1)</script>'), wrap('<foreignObject/>'),
      wrap('<image href="https://example.invalid/a.png"/>'),
      wrap('<path fill="url(https://example.invalid/a)"/>'),
      wrap('<style>@import "https://example.invalid/a";</style>'),
      wrap('<path style="fill:red"/>'), wrap('<animate attributeName="width"/>'),
      wrap('<use id="a" href="#a"/>'), wrap('<path/>', 'onload="alert(1)"'),
      wrap('<path/>', 'xml:base="https://example.invalid/"'),
      new TextEncoder().encode('<!DOCTYPE svg><svg width="3" height="2"/>'),
      wrap('<g>'), wrap('<use href="#missing"/>'),
    ]) {
      let rejected = false;
      try { validateSvg(bytes); } catch { rejected = true; }
      assert(rejected, "SVGの能動コンテンツ、外部参照、再帰、壊れたXMLを拒否");
    }
    const viewBox = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 49 49"><circle cx="24" cy="24" r="20" fill="orange"/></svg>');
    assert(svgDimensions(viewBox).width === 49, "SVGのviewBox寸法を採用");
    const bitmap = await decodeRaster(viewBox, "image/svg+xml", new AbortController().signal);
    try { assert(bitmap.width === 49 && bitmap.height === 49, "viewBoxのみのSVGを指定寸法で描画"); }
    finally { bitmap.close(); }
  }
  {
    const source = new Uint8Array(await (await fetch("/fixture/v2")).arrayBuffer());
    const canvas = document.createElement("canvas");
    canvas.width = 3; canvas.height = 2;
    const context = canvas.getContext("2d")!;
    const pixels = new Uint8ClampedArray(firstFrame.flat());
    pixels[4 * 4 + 3] = 128;
    context.putImageData(new ImageData(pixels, 3, 2), 0, 0);
    const webp = () => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
      if (blob?.type === "image/webp") resolve(blob);
      else reject(new Error("テスト端末はWebPの符号化に対応していません"));
    }, "image/webp", 1));
    const firstWebp = new Uint8Array(await (await webp()).arrayBuffer());
    context.fillStyle = "#0000ff"; context.fillRect(0, 0, 3, 2);
    const secondWebp = new Uint8Array(await (await webp()).arrayBuffer());
    const fixtures = [
      { name: "static GIF", mime: "image/gif", bytes: gifFixture() },
      { name: "animated GIF", mime: "image/gif", bytes: gifFixture(true) },
      { name: "static WebP", mime: "image/webp", bytes: firstWebp },
      { name: "animated WebP", mime: "image/webp", bytes: animatedWebp([firstWebp, secondWebp]) },
      { name: "bottom-up BMP", mime: "image/bmp", bytes: bmpFixture() },
      { name: "top-down BMP", mime: "image/bmp", bytes: bmpFixture(true) },
      { name: "alpha BMP", mime: "image/bmp", bytes: bmpFixture(false, true) },
    ];
    const readPixels = (bitmap: ImageBitmap) => {
      context.clearRect(0, 0, 3, 2); context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, 3, 2).data;
    };
    const firstWebpBitmap = await decodeRaster(firstWebp, "image/webp", new AbortController().signal);
    const webpPixels = readPixels(firstWebpBitmap).slice();
    firstWebpBitmap.close();
    for (const fixture of fixtures) {
      const expected = fixture.mime === "image/webp" ? webpPixels : Uint8ClampedArray.from(
        firstFrame.flatMap((pixel, i) => fixture.mime === "image/bmp" && fixture.name !== "alpha BMP" &&
          i === 0 ? [0, 0, 0, 255] : fixture.name === "alpha BMP" && i === 4 ? [0, 0, 255, 128] : pixel));
      const imported = await importImage(fixture.bytes, { x: 5, y: 7 }, 0, new AbortController().signal);
      try {
        assert(imported.content.mime === fixture.mime && imported.content.width === 3 &&
          imported.content.height === 2 && sameBytes(imported.content.data, fixture.bytes),
          `${fixture.name}: 元形式と全バイトを保持して先頭フレームだけ展開`);
        assert(readPixels(imported.bitmap).every((value, i) => Math.abs(value - expected[i]) <= 1),
          `${fixture.name}: 先頭フレームの色、上下方向、透過を保持`);
        const board = await parsePur(source);
        const editor = new BoardEditor(board.images);
        editor.add(imported.content);
        const output = await writePurCopy(source, editor.snapshot());
        const restored = await parsePur(output);
        const added = restored.images[restored.images.length - 1];
        assert(added.mime === fixture.mime && sameBytes(added.data, fixture.bytes),
          `${fixture.name}: 保存と再解析後の形式と全バイトが完全一致`);
        const decoded = await decodeImages([added], new AbortController().signal);
        try {
          assert(readPixels(decoded[0].bitmap).every((value, i) => Math.abs(value - expected[i]) <= 1),
            `${fixture.name}: 元形式での保存と再解析後も先頭フレームと透過が一致`);
        } finally { decoded[0].bitmap.close(); }
        editor.undo(); assert(editor.images.length === 1 && !editor.dirty, `${fixture.name}: 追加Undo`);
        editor.redo(); assert(editor.images.length === 2 && editor.dirty, `${fixture.name}: 追加Redo`);
        const redone = await parsePur(await writePurCopy(source, editor.snapshot()));
        assert(sameBytes(redone.images[redone.images.length - 1].data, fixture.bytes),
          `${fixture.name}: Undo/Redo後の保存も全バイトが完全一致`);
        const SQL = await sqlite();
        const db = new SQL.Database(extractDatabase(source));
        try {
          const checksum = new SparkMD5.ArrayBuffer();
          checksum.append(Uint8Array.from(fixture.bytes).buffer);
          db.run("UPDATE images SET width=3,height=2,data=?,format=?,checksum=?",
            [fixture.bytes, fixture.mime.slice(6).toUpperCase(), checksum.end()]);
          if (fixture.mime === "image/gif")
            db.run("UPDATE items_images SET playback_state=2,playback_frame=999");
          const existingSource = wrapDatabase(source, db.export());
          const existing = await parsePur(existingSource);
          const existingDecoded = await decodeImages(existing.images, new AbortController().signal);
          try {
            assert(readPixels(existingDecoded[0].bitmap).every((value, i) => Math.abs(value - expected[i]) <= 1),
              `${fixture.name}: 既存PURの先頭フレームも静止表示`);
          } finally { existingDecoded[0].bitmap.close(); }
          const existingEditor = new BoardEditor(existing.images);
          const moved = [...existing.images[0].item] as Matrix;
          moved[4] += 10;
          existingEditor.transformItem(existing.images[0].id, moved);
          const preserved = await writePurCopy(existingSource, existingEditor.snapshot());
          const saved = new SQL.Database(extractDatabase(preserved));
          try {
            assert(JSON.stringify(saved.exec("SELECT typeof(data),hex(data),format,checksum FROM images")) ===
              JSON.stringify(db.exec("SELECT typeof(data),hex(data),format,checksum FROM images")),
            `${fixture.name}: 既存PURの配置変更後も画像データと形式とチェックサムを無変換で保持`);
            assert(JSON.stringify(saved.exec("SELECT flags,playback_state,playback_frame,playback_speed FROM items_images")) ===
              JSON.stringify(db.exec("SELECT flags,playback_state,playback_frame,playback_speed FROM items_images")),
            `${fixture.name}: 既存PURの再生属性を保持`);
          } finally { saved.close(); }
        } finally { db.close(); }
      } finally { imported.bitmap.close(); }
    }
  }
  {
    const source = new Uint8Array(await (await fetch("/fixture/v2")).arrayBuffer());
    const board = await parsePur(source);
    const decoded = await decodeImages(board.images, new AbortController().signal);
    const editor = new BoardEditor(board.images);
    const canvas = document.createElement("canvas");
    canvas.style.width = "200px"; canvas.style.height = "150px";
    document.body.append(canvas);
    const live = new BoardRenderer(canvas, decoded, boardBounds(board.images), editor);
    live.setEditMode(true);
    live.zoom(8);
    const sample = () => {
      const world = { x: 500, y: 375 };
      const x = (world.x * live.camera.scale + live.camera.x) * canvas.width / canvas.clientWidth;
      const y = (world.y * live.camera.scale + live.camera.y) * canvas.height / canvas.clientHeight;
      return canvas.getContext("2d")!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    };
    await nextFrame();
    const originalPixel = Array.from(sample());
    const imageCanvas = document.createElement("canvas");
    imageCanvas.width = 64; imageCanvas.height = 48;
    const imageContext = imageCanvas.getContext("2d")!;
    imageContext.fillStyle = "#00ff00";
    imageContext.fillRect(0, 0, 64, 48);
    try {
      for (const mime of ["image/png", "image/jpeg"]) {
        const blob = await new Promise<Blob>((resolve, reject) => imageCanvas.toBlob(value => {
          if (value) resolve(value); else reject(new Error("画像の符号化に失敗しました"));
        }, mime));
        const imported = await importImage(new Uint8Array(await blob.arrayBuffer()),
          { x: 500, y: 375 }, live.retainedPixels, new AbortController().signal);
        live.addImage(imported.content, imported.bitmap);
        assert(sample()[1] > 200 && sample()[0] < 30, `${mime}: 新規画像を実Canvasの最前面に描画`);
        const snapshot = editor.snapshot();
        const addedId = editor.selectedId!;
        const output = await writePurCopy(source, snapshot, editor.deletedIds);
        const reopened = await parsePur(output);
        const added = reopened.images.find(image => image.id === addedId)!;
        assert(sameBytes(added.data, new Uint8Array(await blob.arrayBuffer())),
          `${mime}: 保存と再解析後の全バイトが完全一致`);
        assert(added.mime === mime && added.width === 64 && added.height === 48,
          `${mime}: 実ブラウザーで符号化した画像を2.1へ追加保存して再解析`);
        const reopenedImages = await decodeImages(reopened.images, new AbortController().signal);
        assert(reopenedImages.length === snapshot.length, `${mime}: 保存した追加画像を再展開`);
        for (const { bitmap } of reopenedImages) bitmap.close();
        live.removeSelected();
        assert(editor.images.length === 1 && sample().every((value, i) => value === originalPixel[i]),
          `${mime}: 削除画像を描画対象から外す`);
        const deleted = await writePurCopy(output, editor.snapshot(), [addedId]);
        assert((await parsePur(deleted)).images.length === 1, `${mime}: 保存済みの追加画像を削除して再解析`);
        live.undo();
        await nextFrame();
        assert(sample()[1] > 200 && sample()[0] < 30, `${mime}: Undoで画像と描画を復元`);
        live.discardEdits();
        await nextFrame();
        assert(editor.images.length === 1 && !editor.dirty &&
          sample().every((value, i) => value === originalPixel[i]),
          `${mime}: 変更破棄で元の画像だけに戻す`);
      }
    } finally { live.dispose(); canvas.remove(); }
  }
  const host = document.createElement("div");
  host.className = "workspace-leaf-content";
  const pane = document.createElement("div");
  pane.className = "view-content lazyref-pur";
  pane.style.width = "280px";
  pane.style.height = "180px";
  host.append(pane);
  document.body.append(host);
  const toolbar = document.createElement("div");
  toolbar.className = "lazyref-pur-toolbar";
  pane.append(toolbar);
  for (const text of ["全体表示", "縮小", "拡大", "編集を開始", "元に戻す", "やり直す",
    "変更を破棄", "別名 .pur 保存", "ビューを閉じる"]) {
    const button = document.createElement("button");
    button.textContent = text;
    toolbar.append(button);
  }
  for (const text of ["ビルド 0.11.0 / 通常保存は現在のファイルへ上書き", "編集モード"]) {
    const span = document.createElement("span");
    span.textContent = text;
    toolbar.append(span);
  }
  const status = document.createElement("div");
  status.className = "lazyref-pur-status";
  status.textContent = "形式 2.1\nファイル: 1 KiB\n表示画像: 1件\n総画素数:3072px\nメモリー概算\n読み込み時間: 13ms";
  pane.append(status);
  const smallCanvas = document.createElement("canvas");
  smallCanvas.className = "lazyref-pur-canvas";
  pane.append(smallCanvas);
  const smallBoard = await parsePur(new Uint8Array(await (await fetch("/fixture/v2")).arrayBuffer()));
  const smallImages = await decodeImages(smallBoard.images, new AbortController().signal);
  const renderStates: string[] = [];
  const renderErrors: unknown[] = [];
  const originalRequestFrame = window.requestAnimationFrame;
  let initialFrameRequests = 0;
  let smallRenderer: BoardRenderer;
  window.requestAnimationFrame = () => { initialFrameRequests++; return 1; };
  try {
    smallRenderer = new BoardRenderer(smallCanvas, smallImages, boardBounds(smallBoard.images),
      new BoardEditor(smallBoard.images), state => renderStates.push(state), error => renderErrors.push(error));
  } finally { window.requestAnimationFrame = originalRequestFrame; }
  try {
    assert(initialFrameRequests === 0 && renderStates.some(state => state.startsWith("frame drawn")),
      "初回描画はrequestAnimationFrameが実行されない場合も同期完了");
    await nextFrame();
    assert(smallCanvas.clientHeight > 0 && toolbar.scrollHeight > toolbar.clientHeight,
      "編集ツールバーが折り返す280x180ペインでもCanvasの高さを確保");
    assert(renderStates.some(state => state.startsWith("frame drawn")),
      "レンダラー生成ではなく実際のフレーム描画完了を通知");
    const ctx = smallCanvas.getContext("2d")!;
    const pixel = ctx.getImageData(Math.floor(smallCanvas.width / 2), Math.floor(smallCanvas.height / 2), 1, 1).data;
    assert(pixel[3] > 0, "小さなペインでも実fixtureの画像をCanvasへ描画");
    const debugHeight = smallCanvas.clientHeight;
    toolbar.hidden = true;
    status.hidden = true;
    await nextFrame();
    await nextFrame();
    assert(getComputedStyle(toolbar).display === "none" && getComputedStyle(status).display === "none" &&
      smallCanvas.clientHeight > debugHeight, "通常表示はツールバーと計測を隠して描画領域を拡張");
    toolbar.hidden = false;
    status.hidden = false;
    await nextFrame();
    await nextFrame();
    assert(getComputedStyle(toolbar).display !== "none", "デバッグ表示へ戻すとツールバーを再表示");
    pane.style.display = "none";
    await nextFrame();
    await nextFrame();
    assert(renderStates.some(state => state.includes("canvas 0 x 0")),
      "非表示ペインのレイアウト待機を通知");
    pane.style.removeProperty("display");
    await nextFrame();
    await nextFrame();
    await nextFrame();
    assert(renderStates[renderStates.length - 1].startsWith("frame drawn"),
      "非表示から表示へ戻ったペインで描画を再開");
    const originalDraw = ctx.drawImage;
    ctx.drawImage = () => { throw new Error("synthetic canvas failure"); };
    try {
      smallRenderer.zoom(1.1);
      await nextFrame();
      assert(renderErrors.some(error => error instanceof Error && error.message === "synthetic canvas failure"),
        "requestAnimationFrame内の描画例外をエラー通知へ渡す");
    } finally { ctx.drawImage = originalDraw; }
  } finally {
    smallRenderer.dispose();
    assert(renderStates[renderStates.length - 1] === "renderer disposed",
      "レンダラー破棄を診断に記録");
    host.remove();
  }
  const canvas = document.querySelector("canvas")!;
  const context = canvas.getContext("2d")!;
  {
    const seed = smallBoard.images[0];
    const first = { ...seed, clip: undefined, id: 100, item: [1, 0, 0, 1, 0, 0] as typeof seed.item,
      image: [1, 0, 0, 1, 0, 0] as typeof seed.image, z: 0 };
    const second = { ...seed, clip: undefined, id: 101, item: [1, 0, 0, 1, 32, 0] as typeof seed.item,
      image: [1, 0, 0, 1, 0, 0] as typeof seed.image, z: 0 };
    const bitmap = async (color: string) => {
      const source = document.createElement("canvas");
      source.width = 64; source.height = 48;
      const ctx = source.getContext("2d")!;
      ctx.fillStyle = color; ctx.fillRect(0, 0, 64, 48);
      return createImageBitmap(source);
    };
    let enabled = true;
    const interactionDiagnostics: string[] = [];
    const gestureAutosave = new IdleAutosave(() => {}, 60_000);
    const editor = new BoardEditor([first, second], () => gestureAutosave.changed(true));
    const renderer = new BoardRenderer(canvas, [
      { image: first, bitmap: await bitmap("#ff0000") },
      { image: second, bitmap: await bitmap("#0000ff") },
    ], boardBounds([first, second]), editor, () => {}, error => { throw error; }, () => enabled,
    message => interactionDiagnostics.push(message));
    const capture = canvas.setPointerCapture;
    canvas.setPointerCapture = () => {};
    const send = (type: string, id: number, x: number, y: number, button = 0, pointerType = "touch",
      modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}) => {
      const rect = canvas.getBoundingClientRect();
      const p = { x: rect.left + x * renderer.camera.scale + renderer.camera.x,
        y: rect.top + y * renderer.camera.scale + renderer.camera.y };
      canvas.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType,
        clientX: p.x, clientY: p.y, button, cancelable: true, ...modifiers }));
    };
    const pixelAtLocal = (x: number, y: number) => {
      const world = transform(multiply(first.item, first.image), { x, y });
      const px = Math.round((world.x * renderer.camera.scale + renderer.camera.x) *
        canvas.width / canvas.clientWidth);
      const py = Math.round((world.y * renderer.camera.scale + renderer.camera.y) *
        canvas.height / canvas.clientHeight);
      return context.getImageData(Math.max(0, Math.min(canvas.width - 1, px)),
        Math.max(0, Math.min(canvas.height - 1, py)), 1, 1).data;
    };
    const tap = (x: number, y: number, button = 0) => {
      send("pointerdown", 1, x, y, button); send("pointerup", 1, x, y, button);
    };
    const overlapPixel = () => context.getImageData(
      Math.round((48 * renderer.camera.scale + renderer.camera.x) * canvas.width / canvas.clientWidth),
      Math.round((24 * renderer.camera.scale + renderer.camera.y) * canvas.height / canvas.clientHeight), 1, 1).data;
    try {
      renderer.setEditMode(true);
      assert(overlapPixel()[2] === 255, "重なり合う画像は元の並びで青が前面");
      tap(16, 24);
      await nextFrame();
      assert(first.z > second.z && editor.dirty && overlapPixel()[0] === 255,
        "編集モードのタップで赤を前面化し描画順とdirtyへ反映");
      tap(48, 24);
      assert(editor.selectedId === first.id, "前面化後の重なり部分のヒットテストは最前面の赤を選択");
      renderer.undo();
      await nextFrame();
      assert(!editor.canUndo && !editor.dirty && overlapPixel()[2] === 255,
        "既に最前面のタップは履歴を増やさずUndoで元の順序へ復元");
      renderer.redo();
      await nextFrame();
      assert(overlapPixel()[0] === 255 && editor.dirty, "前面化をRedoして描画順を復元");
      editor.discard();
      enabled = false;
      tap(16, 24);
      assert(!editor.dirty && first.z === 0, "前面化オフでは選択のみで重なり順を変えない");
      enabled = true;
      renderer.setEditMode(false);
      tap(16, 24);
      assert(!editor.dirty, "閲覧モードのタップでは前面化しない");
      renderer.setEditMode(true);
      tap(16, 24, 2);
      tap(-10, -10);
      assert(!editor.dirty, "右クリックと空白タップでは前面化しない");
      send("pointerdown", 1, 16, 24);
      send("pointerdown", 2, 80, 24);
      send("pointerup", 2, 80, 24);
      send("pointerup", 1, 16, 24);
      assert(!editor.dirty && !editor.canUndo, "2指カメラ操作は選択による前面化を記録しない");
      tap(48, 24);
      editor.select(first.id);
      const h = imageHandles(first)[4];
      send("pointerdown", 1, h.x, h.y);
      send("pointerup", 1, h.x, h.y);
      assert(!editor.dirty, "拡縮ハンドルを押すだけでは前面化しない");
      send("pointerdown", 1, 16, 24);
      send("pointermove", 1, 18, 24);
      send("pointerup", 1, 18, 24);
      assert(first.z > second.z && first.item[4] > 0, "ドラッグ開始で一度だけ前面化して画像を移動");
      renderer.undo();
      assert(first.item[4] === 0 && first.z > second.z && editor.dirty,
        "最初のUndoは移動だけを取り消し前面化を維持");
      renderer.undo();
      assert(!editor.dirty && !editor.canUndo, "次のUndoで前面化を一度だけ取り消す");
      editor.select();
      const modifiedTap = (x: number, modifiers: { ctrlKey?: boolean; metaKey?: boolean }) => {
        send("pointerdown", 1, x, 24, 0, "mouse", modifiers);
        send("pointerup", 1, x, 24, 0, "mouse", modifiers);
      };
      modifiedTap(16, { ctrlKey: true });
      modifiedTap(80, { metaKey: true });
      await nextFrame();
      assert(editor.selectedImages.length === 2 && !editor.dirty && !editor.canUndo,
        "Ctrl/Cmdクリックは前面化せず複数選択を描画");
      send("pointermove", 91, 0, 0, 0, "mouse");
      assert(canvas.style.cursor === "nwse-resize" && !renderer.canTransformSelected && renderer.canAlignSelected,
        "複数選択は共通拡縮ハンドルと整列を有効化");
      const groupedBefore = editor.snapshot();
      send("pointerdown", 1, 16, 24);
      send("pointermove", 1, 19, 29);
      send("pointerup", 1, 19, 29);
      assert(editor.selectedImages.length === 2 &&
        Math.abs(first.item[4] - 3) < 1e-8 && Math.abs(second.item[4] - 35) < 1e-8 &&
        Math.abs(first.item[5] - second.item[5]) < 1e-8,
      "選択済み画像のドラッグは集合と相対配置を維持");
      renderer.undo();
      assert(JSON.stringify(editor.snapshot()) === JSON.stringify(groupedBefore) && !editor.canUndo,
        "複数画像の移動は1回のUndoで全体を復元");
      renderer.redo();
      assert(Math.abs(first.item[4] - 3) < 1e-8, "複数移動を一括Redo");
      renderer.undo();
      send("pointerdown", 1, 16, 24);
      send("pointerdown", 2, 80, 24);
      send("pointermove", 2, 85, 29);
      send("pointerup", 2, 85, 29);
      send("pointerup", 1, 16, 24);
      assert(editor.selectedImages.length === 2 &&
        JSON.stringify(editor.snapshot()) === JSON.stringify(groupedBefore),
      "2本指カメラ移動は選択集合と画像配置を維持");
      renderer.alignSelected("right");
      assert(first.item[4] === second.item[4] && editor.dirty,
        "実Canvasの整列操作は画像を平行移動");
      renderer.undo();
      assert(JSON.stringify(editor.snapshot()) === JSON.stringify(groupedBefore),
        "整列を一括Undo");
      send("pointerdown", 1, -10, -10, 0, "mouse", { shiftKey: true });
      send("pointermove", 1, 1, 1, 0, "mouse", { shiftKey: true });
      send("pointerup", 1, 1, 1, 0, "mouse", { shiftKey: true });
      assert(editor.selectedId === first.id && !editor.dirty, "Shift空白ドラッグは部分交差画像で選択を置換");
      send("pointerdown", 1, 110, 60, 0, "mouse", { shiftKey: true });
      send("pointermove", 1, -10, -10, 0, "mouse", { shiftKey: true });
      send("pointerup", 1, -10, -10, 0, "mouse", { shiftKey: true });
      assert(editor.selectedImages.length === 2, "逆方向の範囲選択も集合を選択");
      const common = { width: 96, height: 48, item: [1, 0, 0, 1, 0, 0] as typeof first.item,
        image: [1, 0, 0, 1, 0, 0] as typeof first.item };
      for (let index = 0; index < 8; index++) {
        const handles = imageHandles(common), start = handles[index], anchor = handles[(index + 4) % 8];
        const end = { x: start.x + (start.x - anchor.x) / 2, y: start.y + (start.y - anchor.y) / 2 };
        send("pointerdown", 1, start.x, start.y, 0, "mouse");
        send("pointermove", 1, end.x, end.y, 0, "mouse");
        const pixel = pixelAtLocal(16, 24);
        assert(pixel[0] === 255 && pixel[3] === 255, `集合拡縮ハンドル${index + 1}は移動中に画像を再描画`);
        send("pointerup", 1, end.x, end.y, 0, "mouse");
        const actualAnchor = imageHandles({ ...common,
          item: resizeFromHandle(common.item, anchor,
            { x: start.x - anchor.x, y: start.y - anchor.y }, start, end) })[(index + 4) % 8];
        assert(Math.hypot(actualAnchor.x - anchor.x, actualAnchor.y - anchor.y) < 1e-8 &&
          Math.abs(first.item[0] - 1.5) < 1e-8 && Math.abs(second.item[0] - 1.5) < 1e-8,
        `共通ハンドル${index + 1}の等比拡縮は対向点を固定`);
        renderer.undo();
        assert(JSON.stringify(editor.snapshot()) === JSON.stringify(groupedBefore) && !editor.canUndo,
          `集合拡縮ハンドル${index + 1}を1回でUndo`);
      }
      const groupCenter = imageCenter(common), groupStart = rotationHandles(common, 20 / renderer.camera.scale)[0];
      const angle = Math.PI / 4;
      const groupEnd = { x: groupCenter.x + Math.cos(angle) * (groupStart.x - groupCenter.x) -
        Math.sin(angle) * (groupStart.y - groupCenter.y),
      y: groupCenter.y + Math.sin(angle) * (groupStart.x - groupCenter.x) +
        Math.cos(angle) * (groupStart.y - groupCenter.y) };
      send("pointerdown", 1, groupStart.x, groupStart.y, 0, "mouse");
      send("pointermove", 1, groupEnd.x, groupEnd.y, 0, "mouse");
      const groupPixel = pixelAtLocal(16, 24);
      assert(groupPixel[0] === 255 && groupPixel[3] === 255, "集合回転中も実画素を即時描画");
      send("pointerup", 1, groupEnd.x, groupEnd.y, 0, "mouse");
      const rotatedCommon = { ...common, item: rotateMatrixAboutPoint(common.item, groupCenter, angle) };
      const rotatedHandle = imageHandles(rotatedCommon)[1];
      send("pointermove", 91, rotatedHandle.x, rotatedHandle.y, 0, "mouse");
      assert(canvas.style.cursor === resizeCursor(rotatedCommon, 1), "集合回転後のカーソルは回転した共通枠に一致");
      const rotatedState = editor.snapshot();
      const rotatedAnchor = imageHandles(rotatedCommon)[5];
      const rotatedEnd = { x: rotatedHandle.x + (rotatedHandle.x - rotatedAnchor.x) / 2,
        y: rotatedHandle.y + (rotatedHandle.y - rotatedAnchor.y) / 2 };
      send("pointerdown", 1, rotatedHandle.x, rotatedHandle.y, 0, "mouse");
      send("pointermove", 1, rotatedEnd.x, rotatedEnd.y, 0, "mouse");
      send("pointerup", 1, rotatedEnd.x, rotatedEnd.y, 0, "mouse");
      assert(Math.abs(first.item[0] - Math.cos(angle) * 1.5) < 1e-8,
        "回転した共通ハンドルのヒット領域で集合を追加拡縮");
      renderer.undo();
      assert(JSON.stringify(editor.snapshot()) === JSON.stringify(rotatedState), "追加拡縮Undoは集合回転を維持");
      renderer.undo();
      assert(JSON.stringify(editor.snapshot()) === JSON.stringify(groupedBefore) && !editor.canUndo,
        "集合回転も1回のUndoで元の全配置へ復元");
      modifiedTap(16, { ctrlKey: true });
      assert(editor.selectedId === second.id && !renderer.canAlignSelected,
        "再Ctrlクリックはその画像だけ解除し1枚選択へ戻る");
      tap(-10, -10);
      assert(editor.selectedImages.length === 0, "空白クリックは選択集合を解除");
      renderer.fit();
      editor.select(first.id);
      const resizeHover = imageHandles(first)[0];
      send("pointermove", 91, resizeHover.x, resizeHover.y, 0, "mouse");
      assert(canvas.style.cursor === "nwse-resize", "拡縮ハンドル上で画像の向きに沿うカーソルを表示");
      const rotationHover = rotationHandles(first, 20 / renderer.camera.scale)[0];
      send("pointermove", 91, rotationHover.x, rotationHover.y, 0, "mouse");
      assert(canvas.style.cursor.includes("data:image/svg+xml"),
        "描画しない回転操作域では回転カーソルを表示");
      const beforeRotate = editor.snapshot()[0].item;
      const center = imageCenter(first);
      const start = rotationHandles(first, 20 / renderer.camera.scale)[0];
      const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
      const endAngle = startAngle + Math.PI / 2;
      const radius = Math.hypot(start.x - center.x, start.y - center.y);
      const middleAngle = startAngle + Math.PI / 4;
      const middle = { x: center.x + Math.cos(middleAngle) * radius,
        y: center.y + Math.sin(middleAngle) * radius };
      const end = { x: center.x + Math.cos(endAngle) * radius, y: center.y + Math.sin(endAngle) * radius };
      send("pointerdown", 1, start.x, start.y);
      send("pointermove", 1, middle.x, middle.y);
      const middleRotationPixel = pixelAtLocal(16, 32);
      assert(middleRotationPixel[0] === 255 && middleRotationPixel[3] === 255,
        "最初の回転pointermove直後に画像ピクセルが描画済み");
      send("pointermove", 1, end.x, end.y);
      const rotatedPixel = pixelAtLocal(16, 32);
      assert(rotatedPixel[0] === 255 && rotatedPixel[3] === 255,
        "2回目の回転pointermove直後に画像ピクセルが更新済み");
      send("pointerup", 1, end.x, end.y);
      assert(editor.dirty && editor.canUndo, "corner-adjacent rotation gesture commits one dirty edit");
      assert(interactionDiagnostics.some(message =>
        message.includes("rotate gesture ended; pointerMoves=2; drawCalls=2; renderedFrames=2")),
      "回転診断は受信pointermoveと描画フレーム数を記録");
      const expectedRotation = rotateMatrixAboutPoint(beforeRotate, center, Math.PI / 2);
      assert(first.item.every((value, index) => Math.abs(value - expectedRotation[index]) < 1e-8),
        "single-finger corner rotation preserves the image center and applies the pointer angle");
      renderer.undo();
      assert(!editor.dirty && first.item.every((value, index) => value === beforeRotate[index]),
        "Undo restores the image before free rotation");
      const resizeHandles = imageHandles(first);
      const resizeStart = resizeHandles[4];
      const resizeAnchor = resizeHandles[0];
      const resizeEnd = {
        x: resizeStart.x + (resizeStart.x - resizeAnchor.x) * 0.1,
        y: resizeStart.y + (resizeStart.y - resizeAnchor.y) * 0.1,
      };
      const resizeNext = {
        x: resizeStart.x + (resizeStart.x - resizeAnchor.x) * 0.2,
        y: resizeStart.y + (resizeStart.y - resizeAnchor.y) * 0.2,
      };
      send("pointerdown", 2, resizeStart.x, resizeStart.y);
      send("pointermove", 2, resizeEnd.x, resizeEnd.y);
      const firstResizePixel = pixelAtLocal(16, 32);
      assert(firstResizePixel[0] === 255 && firstResizePixel[3] === 255,
        "最初の拡縮pointermove直後に画像ピクセルが描画済み");
      send("pointermove", 2, resizeNext.x, resizeNext.y);
      const secondResizePixel = pixelAtLocal(16, 32);
      assert(secondResizePixel[0] === 255 && secondResizePixel[3] === 255,
        "2回目の拡縮pointermove直後に画像ピクセルが更新済み");
      send("pointerup", 2, resizeNext.x, resizeNext.y);
      assert(interactionDiagnostics.some(message =>
        message.includes("resize gesture ended; pointerMoves=2; drawCalls=2; renderedFrames=2")),
      "拡縮診断は受信pointermoveと描画フレーム数を記録");
      renderer.undo();
      assert(first.item.every((value, index) => value === beforeRotate[index]),
        "Undo restores the image before live resizing");
      renderer.redo();
      editor.discard();
      const beforeFlip = [...first.item] as typeof first.item;
      const expectedHorizontal = flipItem(first, "horizontal");
      renderer.flipSelected("horizontal");
      assert(first.item.every((value, index) => Math.abs(value - expectedHorizontal[index]) < 1e-8) &&
        editor.dirty && editor.canUndo, "horizontal flip updates the selected item as one edit");
      renderer.undo();
      assert(first.item.every((value, index) => value === beforeFlip[index]),
        "Undo restores the pre-flip transform");
      const expectedVertical = flipItem(first, "vertical");
      renderer.flipSelected("vertical");
      assert(editor.dirty && first.item.every((value, index) => Math.abs(value - expectedVertical[index]) < 1e-8),
        "vertical flip updates the selected item");
      editor.discard();
    } finally { canvas.setPointerCapture = capture; renderer.dispose(); gestureAutosave.dispose(); }
  }
  const metricsElement = document.querySelector("#metrics")!;
  {
    let bytes = new Uint8Array(await (await fetch("/fixture/v2")).arrayBuffer());
    const files = new Map<string, Uint8Array>();
    let records: BackupRecord[] = [];
    const backups = new PurBackups(undefined, async value => { records = value; });
    const store: BackupStore = {
      exists: async path => files.has(path),
      read: async path => files.get(path)!.slice(),
      create: async (path, data) => {
        assert(!files.has(path), "ブラウザーの管理コピー作成は既存ファイルを上書きしない");
        files.set(path, data.slice());
      },
      remove: async (path, expected) => {
        if (!sameBytes(files.get(path)!, expected)) throw new Error("backup conflict");
        files.delete(path);
      },
    };
    for (let i = 1; i <= 2; i++) {
      const previous = bytes.slice();
      const board = await parsePur(previous);
      board.images[0].item[4] += i;
      const output = await writePurCopy(previous, board.images.map(image => ({ id: image.id, item: image.item, z: image.z })));
      const backup = await overwriteVerified({
        read: async () => bytes,
        backup: data => backups.prepare(store, "browser.pur", data, () => true),
        write: async data => { bytes = data.slice(); },
      }, previous, output, () => true);
      await backups.prune(store, backup);
      assert(files.size === 1 && records.length === 1 && sameBytes(files.get(backup)!, previous),
        `ブラウザーの保存${i}回目はSHA-256で管理し直前の実fixtureを1世代保持`);
      assert(sameBytes(bytes, output) && (await parsePur(bytes)).images[0].item[4] === board.images[0].item[4],
        `ブラウザーの保存${i}回目の出力を再解析して編集配置を確認`);
    }
  }
  let live: BoardRenderer | undefined;
  for (const name of ["v2"]) {
    live?.dispose();
    const bytes = new Uint8Array(await (await fetch(`/fixture/${name}`)).arrayBuffer());
    const before = bytes.slice();
    const board = await parsePur(bytes);
    const images = await decodeImages(board.images, new AbortController().signal);
    assert(images.length === 1 && board.warnings.length === 0, `${name}: 実fixtureの解析と画像デコード`);
    const metrics = formatLoadMetrics(loadMetrics(bytes.byteLength, images, 12.5));
    metricsElement.textContent = `形式 ${board.version}\n${metrics}`;
    assert(metrics.includes(`(${bytes.byteLength.toLocaleString("ja-JP")} B)`) &&
      metrics.includes("表示画像: 1 件") && metrics.includes("総画素数: 3,072 px") &&
      metrics.includes("展開画像メモリー概算: 12.0 KiB") &&
      metrics.includes("実測値ではありません") && metrics.includes("読み込み時間: 13 ms"),
    `${name}: ファイルサイズ、画像数、総画素数、概算、時間の表示`);
    assert(metricsElement.textContent.includes("読み込み時間:") &&
      metricsElement.textContent.includes("実測値ではありません"),
    `${name}: 読み込み計測を画面へ表示`);
    canvas.width = 1048; canvas.height = 798;
    const camera = new Camera();
    camera.fit(boardBounds(board.images), 1048, 798);
    drawBoard(context, images, camera);
    const source = document.createElement("canvas");
    source.width = 64; source.height = 48;
    const src = source.getContext("2d")!;
    src.drawImage(images[0].bitmap, 0, 0);
    const expected = src.getImageData(32, 24, 1, 1).data;
    const actual = context.getImageData(524, 399, 1, 1).data;
    assert(expected[3] > 0 && [...expected].every((v, i) => v === actual[i]),
      `${name}: 解析からCanvas描画までの中央ピクセル一致`);
    assert(context.getImageData(0, 0, 1, 1).data[3] === 0, `${name}: ボード外の透明ピクセル`);
    const gridCanvas = document.createElement("canvas");
    gridCanvas.width = 1048; gridCanvas.height = 798;
    const gridContext = gridCanvas.getContext("2d")!;
    drawGrid(gridContext, camera, 1048, 798);
    const lineX = gridLines(camera, 1048, 798).x[1];
    assert(gridContext.getImageData(Math.floor(lineX), 1, 1, 1).data[3] > 0,
      `${name}: ボード座標のグリッドを透明背景へ描画`);
    drawBoard(gridContext, images, camera);
    assert(gridContext.getImageData(524, 399, 1, 1).data.every((value, i) => value === expected[i]),
      `${name}: グリッドを背面に描き画像ピクセルを保持`);
    const editor = new BoardEditor(board.images);
    live = new BoardRenderer(canvas, images, boardBounds(board.images), editor);
    const scale = live.camera.scale;
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, clientX: 200, clientY: 200, cancelable: true }));
    assert(live.camera.scale > scale, `${name}: ホイール拡大`);
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "0" }));
    assert(Math.abs(live.camera.scale - scale) < 1e-10, `${name}: 全体表示キー`);
    // Synthetic events do not establish browser pointer capture; stub only that API.
    const capture = canvas.setPointerCapture;
    canvas.setPointerCapture = () => {};
    const pointer = (type: string, id: number, x: number, y: number) =>
      canvas.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch",
        clientX: x, clientY: y, button: 0, cancelable: true }));
    const x = live.camera.x;
    pointer("pointerdown", 1, 100, 100);
    pointer("pointermove", 1, 140, 120);
    assert(live.camera.x === x + 40, `${name}: 合成タッチによる1本指パン`);
    pointer("pointerdown", 2, 240, 120);
    pointer("pointermove", 2, 340, 120);
    assert(Math.abs(live.camera.scale - scale * 2) < 1e-10, `${name}: 合成タッチによる2本指ピンチ`);
    pointer("pointercancel", 2, 340, 120);
    pointer("pointermove", 1, 150, 120);
    pointer("pointerup", 1, 150, 120);
    assert(bytes.every((v, i) => v === before[i]), `${name}: 元のpurバイト列を変更しない`);
    live.setEditMode(true);
    live.fit();
    const rect = canvas.getBoundingClientRect();
    const client = (worldX: number, worldY: number) => ({
      x: rect.left + worldX * live!.camera.scale + live!.camera.x,
      y: rect.top + worldY * live!.camera.scale + live!.camera.y,
    });
    const worldCenter = client(500, 375);
    const original = [...board.images[0].item];
    const arcs: number[][] = [];
    const originalArc = context.arc;
    context.arc = function (...args: Parameters<CanvasRenderingContext2D["arc"]>) {
      arcs.push([args[0], args[1], args[2]]);
      originalArc.apply(this, args);
    };
    pointer("pointerdown", 30, worldCenter.x, worldCenter.y);
    pointer("pointerup", 30, worldCenter.x, worldCenter.y);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    context.arc = originalArc;
    assert(editor.selectedId === board.images[0].id,
      `${name}: タップで対応画像を選択`);
    assert(arcs.length === 8 && arcs.every(arc => arc[2] === 3),
      `${name}: 拡縮用の丸ハンドルだけを8個描画`);
    const topEdge = client(550, 0);
    const ratio = canvas.width / canvas.clientWidth;
    const canvasRect = canvas.getBoundingClientRect();
    const pixelX = Math.round((topEdge.x - canvasRect.left) * ratio);
    const pixelY = Math.round((topEdge.y - canvasRect.top) * canvas.height / canvas.clientHeight);
    const selectionPixels = context.getImageData(pixelX - 2, pixelY - 2, 5, 5).data;
    assert(Array.from({ length: 25 }, (_, i) => selectionPixels[i * 4 + 2] -
      selectionPixels[i * 4]).some(delta => delta > 20), `${name}: 選択枠をCanvasへ描画`);
    pointer("pointerdown", 3, worldCenter.x, worldCenter.y);
    pointer("pointermove", 3, worldCenter.x + 12, worldCenter.y + 8);
    pointer("pointerup", 3, worldCenter.x + 12, worldCenter.y + 8);
    assert(editor.dirty && board.images[0].item[4] !== original[4],
      `${name}: 編集モードで選択画像だけを移動して未保存状態にする ` +
      `(dirty=${editor.dirty}, selected=${editor.selectedId}, before=${original}, after=${board.images[0].item})`);
    assert(editor.canUndo, `${name}: 画像移動をUndo履歴へ記録`);
    const moved = [...board.images[0].item];
    live.undo();
    assert(!editor.dirty && board.images[0].item[4] === original[4], `${name}: 移動を元に戻してdirtyを解除`);
    assert(!editor.canUndo && editor.canRedo, `${name}: 終了したジェスチャーをUndo時に重複登録しない`);
    live.redo();
    assert(editor.dirty && board.images[0].item[4] === moved[4], `${name}: 移動をやり直してdirtyを復元`);
    const centerWorldPoint = transform(multiply(board.images[0].item, board.images[0].image),
      { x: 32, y: 24 });
    const handleWorldPoint = transform(multiply(board.images[0].item, board.images[0].image),
      { x: 64, y: 48 });
    const center = client(centerWorldPoint.x, centerWorldPoint.y);
    const handle = client(handleWorldPoint.x, handleWorldPoint.y);
    pointer("pointerdown", 4, handle.x, handle.y);
    pointer("pointermove", 4, handle.x + 12, handle.y + 12);
    pointer("pointerup", 4, handle.x + 12, handle.y + 12);
    assert(board.images[0].item[0] !== moved[0], `${name}: 選択枠の角をドラッグして画像を拡縮`);
    const resized = [...board.images[0].item];
    for (let index = 0; index < 8; index++) {
      const beforeHandleEdit = editor.snapshot()[0];
      const handles = imageHandles(board.images[0]);
      const h = handles[index], anchor = handles[(index + 4) % 8];
      const screen = client(h.x, h.y);
      pointer("pointerdown", 50 + index, screen.x, screen.y);
      pointer("pointermove", 50 + index,
        screen.x + (h.x - anchor.x) * live.camera.scale * 0.1,
        screen.y + (h.y - anchor.y) * live.camera.scale * 0.1);
      pointer("pointerup", 50 + index, screen.x, screen.y);
      const changed = imageHandles(board.images[0])[(index + 4) % 8];
      assert(Math.abs(board.images[0].item[0] / beforeHandleEdit.item[0] - 1.1) < 1e-8 &&
        Math.hypot(changed.x - anchor.x, changed.y - anchor.y) < 1e-7,
      `${name}: 丸ハンドル${index + 1}は対向点を固定して等比拡縮`);
      const output = await writePurCopy(bytes, editor.snapshot());
      const reopened = await parsePur(output);
      assert(reopened.images[0].item.every((value, i) => value === board.images[0].item[i]),
        `v2: ハンドル${index + 1}の拡縮を保存して再解析`);
      live.undo();
      assert(board.images[0].item.every((value, i) => value === resized[i]),
        `${name}: ハンドル${index + 1}の操作をUndo`);
    }
    const touchHandles = imageHandles(board.images[0]);
    const touchHandle = client(touchHandles[4].x, touchHandles[4].y);
    const rotationHandleWorld = rotationHandles(board.images[0], 20 / live.camera.scale)[2];
    const rotationHandle = client(rotationHandleWorld.x, rotationHandleWorld.y);
    const rotationDx = rotationHandle.x - touchHandle.x;
    const rotationDy = rotationHandle.y - touchHandle.y;
    const rotationLength = Math.hypot(rotationDx, rotationDy);
    const touchStart = { x: touchHandle.x - rotationDy / rotationLength * 19.5,
      y: touchHandle.y + rotationDx / rotationLength * 19.5 };
    const touchAnchor = touchHandles[0];
    pointer("pointerdown", 70, touchStart.x, touchStart.y);
    assert(board.images[0].item.every((value, i) => value === resized[i]),
      `${name}: 丸の外のタッチ判定でも押した瞬間に配置を変えない`);
    pointer("pointermove", 70,
      touchStart.x + (touchHandles[4].x - touchAnchor.x) * live.camera.scale * 0.1,
      touchStart.y + (touchHandles[4].y - touchAnchor.y) * live.camera.scale * 0.1);
    pointer("pointerup", 70, touchStart.x, touchStart.y);
    assert(Math.abs(board.images[0].item[0] / resized[0] - 1.1) < 1e-8,
      `${name}: 見た目より広いタッチ判定から等比拡縮`);
    live.undo();
    {
      const saved = await writePurCopy(bytes, board.images.map(image => ({ id: image.id, item: image.item })));
      const savedBoard = await parsePur(saved);
      assert(savedBoard.images[0].item.every((value, i) => value === board.images[0].item[i]),
        "v2: 編集した配置を別名保存用データへ書き込み再解析");
      const savedImages = await decodeImages(savedBoard.images, new AbortController().signal);
      try {
        assert(savedImages.length === images.length && editor.dirty && editor.canUndo &&
          bytes.every((value, i) => value === before[i]),
        "v2: 保存データの画像を展開でき、元ファイルと編集中の履歴を維持");
        const savedCanvas = document.createElement("canvas");
        savedCanvas.width = 1048; savedCanvas.height = 798;
        const savedCamera = new Camera();
        savedCamera.fit(boardBounds(savedBoard.images), 1048, 798);
        const savedContext = savedCanvas.getContext("2d")!;
        drawBoard(savedContext, savedImages, savedCamera);
        const savedPixel = savedContext.getImageData(524, 399, 1, 1).data;
        assert(savedPixel.every((value, i) => value === expected[i]),
          "v2: 別名保存データの再解析からCanvas描画までの中央ピクセル一致");
      } finally { for (const { bitmap } of savedImages) bitmap.close(); }
    }
    assert(editor.canUndo, `${name}: 拡縮操作をUndo履歴へ記録`);
    live.undo();
    assert(board.images[0].item.every((value, i) => value === moved[i]), `${name}: 拡縮だけをUndo`);
    editor.discard();
    assert(!editor.dirty && board.images[0].item.every((value, i) => value === original[i]),
      `${name}: 変更破棄で元の画像配置へ復元`);
    const blank = { x: rect.left + 8, y: rect.top + 8 };
    const cameraX = live.camera.x;
    pointer("pointerdown", 5, blank.x, blank.y);
    pointer("pointermove", 5, blank.x + 20, blank.y);
    pointer("pointerup", 5, blank.x + 20, blank.y);
    assert(live.camera.x !== cameraX && !editor.dirty, `${name}: 編集モードの空白ドラッグはボードだけをパン`);
    const beforePinch = [...board.images[0].item];
    const beforeScale = live.camera.scale;
    pointer("pointerdown", 6, center.x - 40, center.y);
    pointer("pointerdown", 7, center.x + 40, center.y);
    pointer("pointermove", 7, center.x + 80, center.y);
    pointer("pointerup", 7, center.x + 80, center.y);
    pointer("pointerup", 6, center.x - 40, center.y);
    canvas.setPointerCapture = capture;
    assert(live.camera.scale > beforeScale && board.images[0].item.every((value, i) => value === beforePinch[i]),
      `${name}: 編集モード中の2本指ピンチは画像ではなくボードをズーム`);
    live.dispose();
    const disposedScale = live.camera.scale;
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, cancelable: true }));
    assert(live.camera.scale === disposedScale, "ビュー破棄後のイベント解除");
    live = new BoardRenderer(canvas, await decodeImages(board.images, new AbortController().signal),
      boardBounds(board.images), editor);
  }
  const renderer = live!;
  document.querySelector("#fit")!.addEventListener("click", () => renderer.fit());
  document.querySelector("#in")!.addEventListener("click", () => renderer.zoom(1.25));
  document.querySelector("#out")!.addEventListener("click", () => renderer.zoom(0.8));
  renderer.fit();
  document.querySelector("#result")!.textContent = `PASS (${results.length})\n${results.join("\n")}`;
  document.documentElement.dataset.result = "pass";
}

void run().catch(error => {
  console.error(error);
  document.querySelector("#result")!.textContent =
    `FAIL: ${String(error)}`;
  document.documentElement.dataset.result = "fail";
});
