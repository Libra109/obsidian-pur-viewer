import { BoardImage, boardBounds, multiply, transform } from "../src/board";
import { parsePur } from "../src/parser";
import { BoardRenderer, decodeImages, drawBoard } from "../src/renderer";
import { Camera } from "../src/camera";
import { formatLoadMetrics, loadMetrics } from "../src/metrics";
import { BoardEditor } from "../src/editor";
import { writePurCopy } from "../src/writer";
import { drawGrid, gridLines } from "../src/grid";
import {
  flipItem, imageCenter, imageHandles, rotateMatrixAboutPoint, rotationHandles,
} from "../src/handles";
import { BackupRecord, BackupStore, PurBackups } from "../src/backups";
import { overwriteVerified } from "../src/overwrite";
import { sameBytes } from "../src/save-copy";
import { IdleAutosave } from "../src/autosave";

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
  for (const text of ["ビルド 0.8.4 / 通常保存は現在のファイルへ上書き", "編集モード"]) {
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
    const send = (type: string, id: number, x: number, y: number, button = 0, pointerType = "touch") => {
      const rect = canvas.getBoundingClientRect();
      const p = { x: rect.left + x * renderer.camera.scale + renderer.camera.x,
        y: rect.top + y * renderer.camera.scale + renderer.camera.y };
      canvas.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType,
        clientX: p.x, clientY: p.y, button, cancelable: true }));
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
