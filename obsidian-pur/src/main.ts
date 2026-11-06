import { App, ButtonComponent, FileView, FuzzySuggestModal, Menu, Modal, Notice, Plugin, PluginSettingTab, Scope, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { boardBounds, Point } from "./board";
import { BoardEditor } from "./editor";
import { MAX_FILE_BYTES, parsePur } from "./parser";
import { BoardRenderer, decodeImages } from "./renderer";
import { formatLoadMetrics, loadMetrics } from "./metrics";
import { copyPath, sameBytes, saveVerifiedCopy } from "./save-copy";
import { writePurCopy } from "./writer";
import { overwriteVerified } from "./overwrite";
import { BackupRecord, BackupStore, PurBackups } from "./backups";
import { IdleAutosave } from "./autosave";
import { importImage } from "./image-import";
import { svgDataUrl } from "./svg";
import { disposeHeicWorker, setHeicFallbackHandler } from "./heic";

const VIEW_TYPE = "lazyref-pur-view";
const BUILD_ID = "0.13.0";
const IMAGE_TYPES = ["image/heic", "image/heif", "image/svg+xml", "image/gif", "image/webp",
  "image/bmp", "image/x-ms-bmp", "image/jpeg", "image/png"];
const DEFAULT_AUTOSAVE_SECONDS = 3;
const MIN_AUTOSAVE_SECONDS = 1;
const MAX_AUTOSAVE_SECONDS = 60;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  if ("isContentEditable" in target && target.isContentEditable === true) return true;
  return "closest" in target && typeof target.closest === "function" &&
    Boolean(target.closest("input, textarea, select, [contenteditable=true]"));
}

function sameSnapshot(
  left: ReturnType<BoardEditor["snapshot"]>,
  right: ReturnType<BoardEditor["snapshot"]>,
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return item.id === other.id && item.z === other.z &&
      item.item.every((value, i) => value === other.item[i]);
  });
}

interface ViewerDiagnostics {
  pluginStage: string;
  launchStage: string;
  requestedFile: string;
  viewStage: string;
  viewFile: string;
  nextViewId: number;
  sequence: number;
  history: string[];
  views: Map<number, string>;
}

class ConfirmModal extends Modal {
  private resolveResult?: (value: boolean) => void;
  private settled = false;
  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirmLabel: string,
    private readonly cancelLabel: string,
  ) { super(app); }

  show(): Promise<boolean> {
    return new Promise(resolve => {
      this.resolveResult = resolve;
      this.open();
    });
  }
  onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.createEl("p", { text: this.message });
    const buttons = this.contentEl.createDiv({ cls: "lazyref-pur-modal-buttons" });
    new ButtonComponent(buttons).setButtonText(this.cancelLabel).onClick(() => this.finish(false));
    new ButtonComponent(buttons).setButtonText(this.confirmLabel).setWarning().onClick(() => this.finish(true));
  }
  onClose(): void { this.resolve(false); }
  private finish(value: boolean): void {
    this.resolve(value);
    this.close();
  }
  private resolve(value: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveResult?.(value);
  }
}

class CopyNameModal extends Modal {
  private resolveResult?: (value: string | undefined) => void;
  constructor(app: App, private readonly suggested: string) { super(app); }
  show(): Promise<string | undefined> {
    return new Promise(resolve => { this.resolveResult = resolve; this.open(); });
  }
  onOpen(): void {
    this.setTitle("編集内容を別名の .pur へ保存");
    this.contentEl.createEl("p", { text: "元ファイルと同じフォルダーへ新規作成します。既存ファイルは上書きしません。" });
    const input = this.contentEl.createEl("input", { type: "text", value: this.suggested });
    input.setAttribute("aria-label", "保存する .pur ファイル名");
    new ButtonComponent(this.contentEl).setButtonText("キャンセル").onClick(() => this.close());
    new ButtonComponent(this.contentEl).setButtonText("別名保存").onClick(() => {
      this.resolveResult?.(input.value);
      this.resolveResult = undefined;
      this.close();
    });
  }
  onClose(): void { this.resolveResult?.(undefined); this.resolveResult = undefined; }
}

class VaultImageModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly choose: (file: TFile) => void) {
    super(app);
    this.setPlaceholder("追加するPNG / JPEG / GIF / WebP / BMP画像を選択");
  }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter(file => /^(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i.test(file.extension));
  }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file); }
}

class PurView extends FileView {
  private readonly viewId: number;
  private loadId = 0;
  private activePath = "";
  private closed = false;
  private stage = "view constructed";
  private renderer?: BoardRenderer;
  private editor?: BoardEditor;
  private loading?: AbortController;
  private readonly autosave: IdleAutosave;
  private activeSaveCompletion?: Promise<void>;
  private finishSave?: () => void;
  private savingSnapshot?: ReturnType<BoardEditor["snapshot"]>;
  private status?: HTMLElement;
  private editStatus?: HTMLElement;
  private canvas?: HTMLCanvasElement;
  private editButton?: HTMLButtonElement;
  private undoButton?: HTMLButtonElement;
  private redoButton?: HTMLButtonElement;
  private discardButton?: HTMLButtonElement;
  private reloadButton?: HTMLButtonElement;
  private loadedFile?: TFile;
  private externalPrompt?: Promise<void>;
  private sourceBytes?: Uint8Array;
  private saveButton?: HTMLButtonElement;
  private saving = false;
  private savedCopy?: string;
  private toolbar?: HTMLElement;
  private alerts?: HTMLElement;
  private warnings: string[] = [];
  private failure = "";
  private externalChanged = false;
  private modifyPending = false;
  private backupPath?: string;
  private importQueue: Promise<void> = Promise.resolve();
  private imagePickerCleanup?: () => void;

  constructor(leaf: WorkspaceLeaf, private readonly diagnostics: ViewerDiagnostics, private readonly purPlugin: PurPlugin) {
    super(leaf);
    this.autosave = new IdleAutosave(() => {
      if (!this.closed && this.editor?.dirty)
        void this.savePurCurrent("autosave").catch(error => this.reportFailure("自動保存", error));
    }, purPlugin.autosaveDelaySeconds * 1000);
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "s", event => {
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      void this.savePurCurrent();
      return false;
    });
    this.viewId = ++diagnostics.nextViewId;
    this.trace("view constructed");
  }
  private trace(stage: string, loadId = this.loadId): void {
    const diagnostics = this.diagnostics;
    const entry = `V${this.viewId}/L${loadId} ${this.activePath || "(no file)"}: ${stage}`;
    diagnostics.history.push(`${++diagnostics.sequence} ${entry}`);
    if (diagnostics.history.length > 64) diagnostics.history.shift();
    if (loadId !== this.loadId) return;
    diagnostics.views.set(this.viewId, entry);
    const oldestViewId = diagnostics.views.keys().next().value;
    if (diagnostics.views.size > 12 && oldestViewId !== undefined) diagnostics.views.delete(oldestViewId);
    this.stage = stage;
    diagnostics.viewStage = entry;
  }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return `${this.editor?.dirty ? "* " : ""}${this.file?.basename ?? "PURボード"}`; }
  getIcon(): string { return "image"; }
  canAcceptExtension(extension: string): boolean { return extension.toLowerCase() === "pur"; }
  applyAutosaveInterval(seconds: number): void { this.autosave.setDelay(seconds * 1000); }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.trace("onOpen entered");
    try {
      this.initializeView();
    } catch (error) {
      this.reportFailure("ビュー初期化", error);
    }
  }

  private initializeView(): void {
    this.contentEl.empty();
    this.contentEl.addClass("lazyref-pur");
    const toolbar = this.contentEl.createDiv({ cls: "lazyref-pur-toolbar" });
    this.toolbar = toolbar;
    const fit = toolbar.createEl("button", { text: "全体表示" });
    const smaller = toolbar.createEl("button", { text: "縮小" });
    const larger = toolbar.createEl("button", { text: "拡大" });
    this.editButton = toolbar.createEl("button", { text: "編集を開始" });
    this.undoButton = toolbar.createEl("button", { text: "元に戻す", attr: { disabled: "" } });
    this.redoButton = toolbar.createEl("button", { text: "やり直す", attr: { disabled: "" } });
    this.discardButton = toolbar.createEl("button", {
      text: "変更を破棄", attr: { disabled: "" }, cls: "lazyref-pur-danger",
    });
    this.reloadButton = toolbar.createEl("button", {
      text: "外部更新を破棄して再読込", cls: "lazyref-pur-danger",
    });
    this.reloadButton.hidden = true;
    this.saveButton = toolbar.createEl("button", { text: "別名 .pur 保存", attr: { disabled: "" } });
    const overwrite = toolbar.createEl("button", { text: "保存" });
    this.registerDomEvent(overwrite, "click", () => void this.savePurCurrent());
    const close = toolbar.createEl("button", { text: "ビューを閉じる" });
    toolbar.createSpan({ text: `ビルド ${BUILD_ID} / 通常保存は現在のファイルへ上書き` });
    this.editStatus = toolbar.createSpan({ cls: "lazyref-pur-edit-status" });
    this.registerDomEvent(fit, "click", () => this.renderer?.fit());
    this.registerDomEvent(smaller, "click", () => this.renderer?.zoom(0.8));
    this.registerDomEvent(larger, "click", () => this.renderer?.zoom(1.25));
    this.registerDomEvent(this.editButton, "click", () => this.toggleEditMode());
    this.registerDomEvent(this.undoButton, "click", () => this.renderer?.undo());
    this.registerDomEvent(this.redoButton, "click", () => this.renderer?.redo());
    this.registerDomEvent(this.discardButton, "click", () => void this.confirmDiscard());
    this.registerDomEvent(this.reloadButton, "click", () => void this.confirmExternalReload());
    this.registerDomEvent(close, "click", () => void this.closeView());
    this.registerDomEvent(this.saveButton, "click", () => void this.savePurCopy());
    this.registerDomEvent(window, "beforeunload", event => {
      if (!this.editor?.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
    this.status = this.contentEl.createDiv({ cls: "lazyref-pur-status" });
    this.status.setAttribute("role", "status");
    this.alerts = this.contentEl.createDiv({ cls: "lazyref-pur-alerts" });
    this.alerts.setAttribute("role", "status");
    this.canvas = this.contentEl.createEl("canvas", { cls: "lazyref-pur-canvas" });
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label",
      "PUR画像ボード。閲覧時はドラッグで移動、ピンチまたはホイールで拡大縮小。編集時は画像をドラッグして移動し、角の枠をドラッグして拡縮。");
    this.registerDomEvent(this.contentEl, "paste", event => {
      if (!this.canAddImages || isEditableTarget(event.target)) return;
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter(item => item.kind === "file").map(item => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (!files.length) {
        const text = event.clipboardData?.getData?.("text/plain") ?? "";
        if (!/^\s*data:image\/svg\+xml[;,]/i.test(text)) return;
        event.preventDefault();
        this.queueImageRead(async () => svgDataUrl(text));
        return;
      }
      event.preventDefault();
      this.queueImageFiles(files);
    });
    this.registerDomEvent(this.canvas, "dragover", event => {
      if (!this.canAddImages || !event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    this.registerDomEvent(this.canvas, "drop", event => {
      if (!this.canAddImages || !event.dataTransfer?.files.length) return;
      event.preventDefault();
      event.stopPropagation();
      this.canvas?.focus();
      this.queueImageFiles(Array.from(event.dataTransfer.files), { x: event.clientX, y: event.clientY });
    });
    this.addAction("more-horizontal", "PUR操作（保存、元に戻す、全体表示）", event => this.showPurMenu(event));
    this.registerDomEvent(this.canvas, "contextmenu", event => {
      event.preventDefault();
      this.showPurMenu(event);
    });
    let hold: ReturnType<typeof setTimeout> | undefined;
    let origin: { x: number; y: number } | undefined;
    const cancelHold = () => { if (hold) clearTimeout(hold); hold = undefined; };
    this.registerDomEvent(this.canvas, "pointerdown", event => {
      cancelHold();
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      origin = { x: event.clientX, y: event.clientY };
      hold = setTimeout(() => {
        hold = undefined;
        this.renderer?.finishPendingEdit();
        this.showPurMenu(event);
      }, 650);
    });
    this.registerDomEvent(this.canvas, "pointermove", event => {
      if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) cancelHold();
    });
    this.registerDomEvent(this.canvas, "pointerup", cancelHold);
    this.registerDomEvent(this.canvas, "pointercancel", cancelHold);
    this.register(cancelHold);
    this.registerEvent(this.app.vault.on("modify", file => {
      if (file === this.loadedFile && file instanceof TFile) void this.handleExternalModify(file);
    }));
    this.registerEvent(this.app.vault.on("rename", file => {
      if (file !== this.loadedFile) return;
      this.externalChanged = true;
      this.failure = "元ファイルが改名されました。保存前に再読込してください。未保存の編集は現在のビューに保持しています。";
      this.updateEditorControls();
      new Notice(this.failure, 10000);
    }));
    this.registerEvent(this.app.vault.on("delete", file => {
      if (file !== this.loadedFile) return;
      this.externalChanged = true;
      this.failure = "元ファイルが削除されました。上書き保存できません。未保存の編集は現在のビューに保持しています。";
      this.updateEditorControls();
      new Notice(this.failure, 10000);
    }));
    this.trace("onOpen complete; waiting for file");
    this.status.setText(`ビュー初期化済み / ビルド ${BUILD_ID} / .purファイルの読込待ち`);
    this.updateEditorControls();
    this.applyPurDebug();
  }

  applyPurDebug(): void {
    if (this.toolbar) this.toolbar.hidden = !this.purPlugin.debug;
    if (this.status) this.status.hidden = !this.purPlugin.debug;
    this.updateEditorControls();
  }

  purDiagnosticState(): string {
    return [
      `V${this.viewId}: ${this.activePath || "(no file)"}`,
      `未保存: ${Boolean(this.editor?.dirty)} / 保存中: ${this.saving} / 外部更新: ${this.externalChanged}`,
      this.failure, ...this.warnings,
    ].filter(Boolean).join("\n");
  }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    this.populatePurMenu(menu);
  }

  private showPurMenu(event: MouseEvent): void {
    const menu = new Menu();
    this.populatePurMenu(menu);
    menu.showAtMouseEvent(event);
  }

  private populatePurMenu(menu: Menu): void {
    menu.addItem(item => item.setTitle("選択時に最前面へ移動")
      .setChecked(this.purPlugin.frontOnSelect)
      .onClick(() => void this.purPlugin.setPurFrontOnSelect(!this.purPlugin.frontOnSelect)));
    const action = (title: string, callback: () => void, disabled = false) =>
      menu.addItem(item => item.setTitle(title).setDisabled(disabled).onClick(callback));
    action("保存（現在の .pur を上書き）", () => void this.savePurCurrent(), !this.sourceBytes || this.saving);
    action("別名 .pur 保存", () => void this.savePurCopy(), !this.sourceBytes || this.saving);
    action("クリップボードから貼り付け", () => this.pasteClipboardImage(), !this.canAddImages);
    action("ストレージから画像を読み込む", () => this.chooseStorageImages(), !this.canAddImages);
    action("保管庫から画像を追加", () => this.chooseVaultImage(), !this.canAddImages);
    action("選択した画像を削除", () => this.renderer?.removeSelected(), !this.renderer?.canTransformSelected);
    action("元に戻す", () => this.renderer?.undo(), !this.editor?.canUndo);
    action("やり直す", () => this.renderer?.redo(), !this.editor?.canRedo);
    action("90°時計回りに回転", () => this.renderer?.rotateSelected(Math.PI / 2),
      !this.renderer?.canTransformSelected);
    action("90°反時計回りに回転", () => this.renderer?.rotateSelected(-Math.PI / 2),
      !this.renderer?.canTransformSelected);
    action("左右反転", () => this.renderer?.flipSelected("horizontal"),
      !this.renderer?.canTransformSelected);
    action("上下反転", () => this.renderer?.flipSelected("vertical"),
      !this.renderer?.canTransformSelected);
    action("全体表示", () => this.renderer?.fit());
    action("拡大", () => this.renderer?.zoom(1.25));
    action("縮小", () => this.renderer?.zoom(0.8));
    action(this.editButton?.dataset.editing === "true" ? "閲覧モードへ" : "編集モードへ", () => this.toggleEditMode());
    action("変更を破棄", () => void this.confirmDiscard(), !this.editor?.dirty);
    action("外部更新を再読込", () => void this.confirmExternalReload());
    if (this.backupPath) {
      const backup = this.backupPath;
      action("直前の復旧用コピーの場所", () => new Notice(`復旧用コピー: ${backup}`, 15000));
    }
    action("ビューを閉じる", () => void this.closeView());
  }

  private get canAddImages(): boolean {
    return !this.closed && Boolean(this.sourceBytes && this.editor && this.renderer) &&
      this.editButton?.dataset.editing === "true";
  }
  private queueImageFiles(files: File[], client?: Point): void {
    for (const file of files) {
      this.queueImageRead(async () => {
        if (file.size > MAX_FILE_BYTES) throw new Error("64 MiBを超える画像は追加できません");
        return new Uint8Array(await file.arrayBuffer());
      }, client);
    }
  }
  private async pasteClipboardImage(): Promise<void> {
    if (!this.canAddImages) return;
    const loadId = this.loadId;
    try {
      const clipboard = this.contentEl.ownerDocument.defaultView?.navigator.clipboard;
      if (!clipboard || typeof clipboard.read !== "function")
        throw new Error("この端末では画像のクリップボード読取APIを利用できません。ストレージから画像を選択してください");
      // Start within the menu click, before any queue or other asynchronous work.
      const items = await clipboard.read();
      if (loadId !== this.loadId || !this.canAddImages)
        throw new Error("クリップボードの読取中にPURビューが変更されました");
      let queued = false;
      for (const item of items) {
        const type = IMAGE_TYPES.find(type => item.types.includes(type));
        if (type) {
          queued = true;
          this.queueImageRead(async () => {
            const blob = await item.getType(type);
            if (blob.size > MAX_FILE_BYTES) throw new Error("64 MiBを超える画像は追加できません");
            return new Uint8Array(await blob.arrayBuffer());
          });
        } else if (item.types.some(type => type.startsWith("image/"))) {
          queued = true;
          this.queueImageRead(async () => {
            throw new Error("クリップボードの画像形式は未対応です。PNG、JPEG、GIF、WebP、BMP、SVG、HEICを選択してください");
          });
        } else if (item.types.includes("text/plain")) {
          const text = await item.getType("text/plain");
          if (text.size > MAX_FILE_BYTES) throw new Error("64 MiBを超えるクリップボードデータは追加できません");
          const value = await text.text();
          if (loadId !== this.loadId || !this.canAddImages)
            throw new Error("クリップボードの読取中にPURビューが変更されました");
          if (/^data:image\/svg\+xml[;,]/i.test(value.trim())) {
            queued = true;
            this.queueImageRead(async () => svgDataUrl(value));
          }
        }
      }
      if (!queued) throw new Error("クリップボードに対応画像またはSVGデータURLがありません");
    } catch (error) {
      const denied = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
      this.reportFailure("クリップボード貼り付け", denied
        ? new Error("端末がクリップボードの読取を拒否しました。権限とアプリのフォーカスを確認し、メニューから再実行してください")
        : error);
    }
  }
  private chooseStorageImages(): void {
    if (!this.canAddImages) return;
    this.imagePickerCleanup?.();
    const loadId = this.loadId;
    const input = this.contentEl.createEl("input");
    input.type = "file";
    input.accept = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".heif",
      ...IMAGE_TYPES].join(",");
    input.multiple = true;
    input.hidden = true;
    const cleanup = () => {
      input.remove();
      if (this.imagePickerCleanup === cleanup) this.imagePickerCleanup = undefined;
    };
    this.imagePickerCleanup = cleanup;
    input.addEventListener("cancel", cleanup, { once: true });
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      cleanup();
      if (loadId !== this.loadId || !this.canAddImages) {
        this.reportFailure("ストレージ画像選択", new Error("画像の選択中にPURビューが変更されました"));
        return;
      }
      this.queueImageFiles(files);
    }, { once: true });
    try {
      // The host WebView opens the OS file picker; no desktop-only path APIs.
      if (typeof input.showPicker === "function") input.showPicker();
      else input.click();
    } catch (error) {
      cleanup();
      this.reportFailure("ストレージ画像選択", error);
    }
  }
  private chooseVaultImage(): void {
    if (!this.canAddImages) return;
    const loadId = this.loadId;
    new VaultImageModal(this.app, file => {
      if (this.loadId !== loadId || !this.canAddImages) {
        this.reportFailure("画像追加", new Error("画像の選択中にビューが変更されました"));
        return;
      }
      this.queueImageRead(async () => {
        const path = file.path;
        if (file.stat.size > MAX_FILE_BYTES) throw new Error("64 MiBを超える画像は追加できません");
        const data = new Uint8Array(await this.app.vault.readBinary(file));
        if (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file)
          throw new Error("画像の読込中にファイルが改名または削除されました");
        return data;
      });
    }).open();
  }
  private queueImageRead(read: () => Promise<Uint8Array>, client?: Point): void {
    const renderer = this.renderer, editor = this.editor, loadId = this.loadId;
    const signal = this.loading?.signal;
    if (!renderer || !editor || !signal) return;
    const center = renderer.insertionPoint(client);
    this.importQueue = this.importQueue.then(async () => {
      const current = () => this.loadId === loadId && this.renderer === renderer && this.canAddImages;
      if (!current()) throw new Error("読込先のPURビューが変更されました");
      const data = await read();
      if (!current()) throw new Error("画像の読込中にPURビューが変更されました");
      if (renderer.retainedCount >= 10000) throw new Error("Undo用の画像を含む10000画像の上限に達しています");
      if (renderer.retainedBytes + data.length > MAX_FILE_BYTES)
        throw new Error("Undo用の画像データを含む64 MiBの上限を超えています");
      const { content, bitmap } = await importImage(data, center, renderer.retainedPixels, signal);
      try {
        if (!current()) throw new Error("画像の展開中にPURビューが変更されました");
        renderer.addImage(content, bitmap);
      } catch (error) { bitmap.close(); throw error; }
    }).catch(error => this.reportFailure("画像追加", error));
  }

  runPurAction(action: "save" | "undo" | "redo" | "fit" | "menu"): void {
    if (action === "save") void this.savePurCurrent();
    else if (action === "undo") this.renderer?.undo();
    else if (action === "redo") this.renderer?.redo();
    else if (action === "fit") this.renderer?.fit();
    else {
      const menu = new Menu();
      this.populatePurMenu(menu);
      const rect = this.contentEl.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left + 12, y: rect.top + 12 });
    }
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.diagnostics.viewFile = file.path;
    this.trace(`onLoadFile entered: ${file.path}`);
    if (this.saving && file === this.loadedFile) {
      this.modifyPending = true;
      this.trace("same-file load deferred during save");
      return;
    }
    if (file === this.loadedFile && this.sourceBytes) {
      const loadId = this.loadId;
      const expected = this.sourceBytes;
      const path = file.path;
      try {
        const bytes = new Uint8Array(await this.app.vault.readBinary(file));
        if (this.closed || loadId !== this.loadId) return;
        if (this.saving) { this.modifyPending = true; return; }
        if (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file)
          throw new Error("再読込中に元ファイルが改名または削除されました");
        if (this.sourceBytes !== expected) {
          await this.handleExternalModify(file);
          return;
        }
        if (sameBytes(expected, bytes)) {
          if (this.activePath !== path) {
            this.activePath = path;
            this.externalChanged = false;
            this.failure = "";
            this.updateEditorControls();
          }
          this.trace("same-file load retained unchanged board and history");
          return;
        }
      } catch (error) {
        this.reportFailure("再読込の確認", error);
        return;
      }
    }
    if (this.editor?.dirty && this.loadedFile && file.path !== this.loadedFile.path) {
      const loadId = this.loadId;
      const previous = this.loadedFile;
      const discard = await new ConfirmModal(
        this.app,
        "編集内容を破棄してファイルを切り替えますか？",
        "編集内容はこの .pur へ保存されていません。破棄して新しいファイルを開くか、今の編集へ戻ります。",
        "破棄して切り替え",
        "今の編集へ戻る",
      ).show();
      if (this.closed || loadId !== this.loadId) {
        this.trace("file-switch confirmation ignored after load changed");
        return;
      }
      if (!discard) {
        await this.leaf.openFile(previous);
        return;
      }
      this.editor.discard();
    }
    if (this.editor?.dirty && this.loadedFile?.path === file.path) return;
    await this.loadPurBoard(file);
  }

  private async loadPurBoard(file: TFile): Promise<void> {
    if (this.closed) {
      this.trace(`load ignored after close: ${file.path}`);
      return;
    }
    const startedAt = performance.now();
    this.clearBoard(`loadPurBoard: ${file.path}`);
    const loadId = this.loadId;
    this.activePath = file.path;
    const loading = new AbortController();
    this.loading = loading;
    this.diagnostics.viewFile = file.path;
    this.trace("reading file");
    try {
      if (!this.status || !this.canvas) throw new Error("onOpenでビューが初期化されていません");
      this.status.setText("ファイル読込中…");
      if (file.stat.size > MAX_FILE_BYTES) throw new Error("64 MiBを超える .pur はこの版では開けません");
      const bytes = new Uint8Array(await this.app.vault.readBinary(file));
      loading.signal.throwIfAborted();
      this.trace("parsing file");
      this.status.setText("PURデータを解析中…");
      const board = await parsePur(bytes);
      loading.signal.throwIfAborted();
      const bounds = boardBounds(board.images);
      this.trace("decoding images");
      this.status.setText("画像を展開中…");
      const images = await decodeImages(board.images, loading.signal);
      if (loading.signal.aborted) {
        for (const { bitmap } of images) bitmap.close();
        return;
      }
      this.editor = new BoardEditor(board.images, () => {
        try { this.onEditorChange(); }
        catch (error) { this.reportFailure("編集状態の更新", error); }
      },
        board.maxHiddenRootZ, board.frontmostRootId, board.maxItemId);
      this.trace("renderer initialized; waiting for frame");
      try {
        this.renderer = new BoardRenderer(this.canvas, images, bounds, this.editor,
          state => { this.trace(state, loadId); },
          error => this.reportFailure("Canvas操作または描画", error), () => this.purPlugin.frontOnSelect,
          message => { if (this.purPlugin.debug) this.trace(`interaction: ${message}`, loadId); });
      }
      catch (error) { for (const { bitmap } of images) bitmap.close(); throw error; }
      this.loadedFile = file;
      this.sourceBytes = bytes;
      this.warnings = board.warnings;
      this.renderer.setEditMode(true);
      if (this.editButton) {
        this.editButton.dataset.editing = "true";
        this.editButton.setText("閲覧に戻る");
        this.editButton.setAttribute("aria-pressed", "true");
      }
      const metrics = loadMetrics(bytes.byteLength, images, performance.now() - startedAt);
      const summary = board.images.length
        ? `形式 ${board.version}`
        : `形式 ${board.version} / 表示できる画像がありません`;
      this.status.setText([summary, formatLoadMetrics(metrics), ...board.warnings].join("\n"));
      this.updateEditorControls();
    } catch (error) {
      if (loading.signal.aborted) {
        this.trace("load aborted", loadId);
        return;
      }
      this.reportFailure("ファイル読込", error);
    }
  }

  private reportFailure(stage: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = this.stage;
    this.trace(`${stage} failed at ${failedAt}: ${message}`);
    console.error("LazyRef PUR Viewer:", error);
    this.failure = `${stage}に失敗しました: ${message}`;
    this.updateEditorControls();
    this.status?.setText(`${stage}に失敗しました: ${message}`);
    new Notice(`PURビューアー ${stage}エラー: ${message}`, 10000);
  }

  private async handleExternalModify(file: TFile): Promise<void> {
    if (this.saving) { this.modifyPending = true; return; }
    const loadId = this.loadId;
    const expected = this.sourceBytes;
    try {
      const bytes = new Uint8Array(await this.app.vault.readBinary(file));
      if (this.closed || loadId !== this.loadId || file !== this.loadedFile) return;
      if (this.saving) { this.modifyPending = true; return; }
      if (this.sourceBytes !== expected) return this.handleExternalModify(file);
      if (expected && sameBytes(expected, bytes)) return;
    } catch (error) {
      this.reportFailure("外部更新の確認", error);
      return;
    }
    if (this.closed || loadId !== this.loadId || file !== this.loadedFile) return;
    this.trace(`vault modify: ${file.path}`);
    this.externalChanged = true;
    this.updateEditorControls();
    if (this.editor?.dirty) {
      if (this.externalPrompt) return this.externalPrompt;
      this.externalPrompt = this.confirmExternalReload().finally(() => { this.externalPrompt = undefined; });
      return this.externalPrompt;
    }
    await this.loadPurBoard(file);
  }

  private async confirmExternalReload(): Promise<void> {
    const file = this.loadedFile;
    if (!file) return;
    const loadId = this.loadId;
    const discard = await new ConfirmModal(
      this.app,
      "元ファイルが更新されました",
      "未保存の編集があります。編集を破棄して更新後の .pur を読み込むか、現在の編集を維持するか選んでください。",
      "破棄して再読込",
      "編集を維持",
    ).show();
    if (this.closed || loadId !== this.loadId) {
      this.trace("reload confirmation ignored after load changed");
      return;
    }
    if (!discard) {
      if (this.reloadButton) this.reloadButton.hidden = false;
      if (this.editStatus) this.editStatus.setText("外部更新あり。再読込すると編集内容が破棄されます。");
      return;
    }
    this.editor?.discard();
    if (this.reloadButton) this.reloadButton.hidden = true;
    await this.loadPurBoard(file);
  }

  private async confirmDiscard(): Promise<void> {
    const editor = this.editor, loadId = this.loadId;
    if (!editor?.dirty) return;
    const discard = await new ConfirmModal(
      this.app, "編集内容を破棄しますか？",
      "最後の上書き保存時（未保存なら読込時）の画像と配置へ戻します。別名保存済みのコピーは残ります。",
      "変更を破棄", "編集へ戻る",
    ).show();
    if (discard && !this.closed && this.loadId === loadId && this.editor === editor) this.renderer?.discardEdits();
  }

  private async closeView(): Promise<void> {
    const loadId = this.loadId, editor = this.editor;
    if (this.editor?.dirty) {
      await this.savePurCurrent("close");
      if (this.closed || loadId !== this.loadId || editor !== this.editor) return;
      if (!editor?.dirty) {
        this.leaf.detach();
        return;
      }
      const discard = await new ConfirmModal(
        this.app, "編集内容を破棄して閉じますか？",
        "閉じる前の保存を完了できませんでした。未保存の編集を破棄して閉じるか、キャンセルして編集を続けます。",
        "破棄して閉じる", "キャンセル",
      ).show();
      if (!discard || this.closed || loadId !== this.loadId || editor !== this.editor) return;
      editor?.discard();
    }
    this.leaf.detach();
  }

  private async savePurCopy(): Promise<void> {
    const file = this.loadedFile, source = this.sourceBytes, editor = this.editor;
    if (!file || !source || !editor || this.saving) return;
    const loadId = this.loadId;
    const sourcePath = file.path;
    this.autosave.pause();
    this.saving = true;
    this.savingSnapshot = editor.snapshot();
    this.activeSaveCompletion = new Promise(resolve => { this.finishSave = resolve; });
    this.updateEditorControls();
    try {
      const name = await new CopyNameModal(this.app, `${file.basename}-edited.pur`).show();
      if (name === undefined) return;
      if (this.closed || loadId !== this.loadId) throw new Error("ビューが変更されたため保存を中止しました");
      const path = copyPath(sourcePath, name);
      const placements = editor.snapshot();
      const deletedIds = editor.deletedIds;
      const current = () => !this.closed && loadId === this.loadId && file.path === sourcePath && editor === this.editor &&
        sameSnapshot(placements, editor.snapshot());
      if (!sameBytes(source, new Uint8Array(await this.app.vault.readBinary(file))))
        throw new Error("元ファイルが外部更新されています。再読込前に現在の編集を別途確認してください");
      const output = await writePurCopy(source, placements, deletedIds);
      await saveVerifiedCopy({
        source: async () => new Uint8Array(await this.app.vault.readBinary(file)),
        exists: async target => this.app.vault.adapter.exists(target),
        create: async (target, bytes) => { await this.app.vault.createBinary(target, Uint8Array.from(bytes).buffer); },
        read: async target => new Uint8Array(await this.app.vault.adapter.readBinary(target)),
      }, source, path, output, current);
      if (!current()) throw new Error(`ビューまたは編集状態が変わりました。保存先 ${path} は作成済みですが、現在の状態の保存済みコピーとしては扱いません`);
      this.savedCopy = path;
      new Notice(`別名保存しました: ${path}。元ファイルの編集状態は維持します`, 10000);
    } catch (error) {
      this.reportFailure("別名保存", error);
    } finally {
      this.saving = false;
      this.savingSnapshot = undefined;
      this.updateEditorControls();
      this.reconcilePurModify();
      this.autosave.resume(editor.dirty, true);
      this.finishSave?.();
      this.finishSave = undefined;
      this.activeSaveCompletion = undefined;
    }
  }

  async savePurCurrent(reason: "manual" | "autosave" | "close" = "manual"): Promise<void> {
    if (this.saving) {
      if (reason === "close" && this.activeSaveCompletion) {
        await this.activeSaveCompletion;
        if (this.editor?.dirty && !this.closed) await this.savePurCurrent("close");
      }
      return;
    }
    const file = this.loadedFile, source = this.sourceBytes, editor = this.editor;
    if (!file || !source || !editor || this.saving) {
      if (reason === "autosave") {
        this.autosave.resume(false);
        this.reportFailure("自動保存", new Error("保存可能なファイルを開いていないか、読込状態が変更されています"));
      } else new Notice("この形式は保存未対応か、読込または保存中です");
      return;
    }
    const path = file.path, loadId = this.loadId;
    if (path !== this.activePath) {
      if (reason === "autosave") this.autosave.resume(false);
      this.reportFailure("上書き保存", new Error("元ファイルが改名されました。再読込が必要です"));
      return;
    }
    if (this.purPlugin.savingPaths.has(path)) {
      this.autosave.resume(false);
      new Notice(reason === "autosave"
        ? "自動保存を保留しました。同じファイルを別のPURビューで保存中です。編集は未保存のままです。"
        : "別のPURビューでこのファイルを保存中です");
      return;
    }
    let placements: ReturnType<BoardEditor["snapshot"]>;
    let deletedIds: number[];
    try {
      this.renderer?.finishPendingEdit();
      placements = editor.snapshot();
      deletedIds = editor.deletedIds;
    } catch (error) {
      this.reportFailure(reason === "autosave" ? "自動保存" : "保存準備", error);
      this.autosave.resume(editor.dirty);
      return;
    }
    this.autosave.pause();
    const current = () => !this.closed && loadId === this.loadId && editor === this.editor && this.file === file &&
      file.path === path && this.app.vault.getAbstractFileByPath(path) === file;
    this.saving = true;
    this.savingSnapshot = placements;
    this.activeSaveCompletion = new Promise(resolve => { this.finishSave = resolve; });
    this.purPlugin.savingPaths.add(path);
    this.updateEditorControls();
    try {
      const output = await writePurCopy(source, placements, deletedIds);
      const backupStore: BackupStore = {
        exists: name => this.app.vault.adapter.exists(name),
        read: async name => new Uint8Array(await this.app.vault.adapter.readBinary(name)),
        create: async (name, data) => { await this.app.vault.createBinary(name, Uint8Array.from(data).buffer); },
        remove: async (name, expected) => {
          const target = this.app.vault.getAbstractFileByPath(name);
          if (!(target instanceof TFile) || target.path !== name) throw new Error(`削除対象が見つかりません: ${name}`);
          const bytes = new Uint8Array(await this.app.vault.readBinary(target));
          if (!sameBytes(bytes, expected) || target.path !== name || this.app.vault.getAbstractFileByPath(name) !== target)
            throw new Error(`復旧用コピーが確認中に変更されました: ${name}。削除しません`);
          await this.app.vault.delete(target);
        },
      };
      const backup = await overwriteVerified({
        read: async () => new Uint8Array(await this.app.vault.readBinary(file)),
        backup: bytes => this.purPlugin.backups.prepare(backupStore, path, bytes, current),
        write: async bytes => {
          if (!current()) throw new Error("書込直前にファイルまたはビューが変更されました");
          await this.app.vault.modifyBinary(file, Uint8Array.from(bytes).buffer);
        },
      }, source, output, current);
      if (!current()) throw new Error(`保存後にビューが変わりました。復旧用コピー: ${backup}`);
      this.sourceBytes = output;
      this.backupPath = backup;
      this.failure = "";
      this.externalChanged = false;
      editor.acceptSaved(placements);
      try {
        await this.purPlugin.backups.prune(backupStore, backup);
        if (reason === "manual") new Notice(`保存しました: ${path}。直前の復旧用コピー1世代: ${backup}`, 10000);
        else if (reason === "autosave") new Notice(`自動保存しました: ${path}`, 5000);
        else new Notice(`ビューを閉じる前に保存しました: ${path}`, 5000);
      } catch (error) {
        this.reportFailure("ファイル保存は完了しましたが、バックアップの1世代整理は未完了です。コピーを手動で確認してください",
          new Error(`${error instanceof Error ? error.message : String(error)}。直前の復旧用コピー: ${backup}`));
      }
    } catch (error) {
      this.reportFailure(`上書き保存 (${path})`, error);
    } finally {
      this.purPlugin.savingPaths.delete(path);
      this.saving = false;
      this.savingSnapshot = undefined;
      this.updateEditorControls();
      this.reconcilePurModify();
      this.autosave.resume(editor.dirty);
      this.finishSave?.();
      this.finishSave = undefined;
      this.activeSaveCompletion = undefined;
    }
  }

  private reconcilePurModify(): void {
    if (!this.modifyPending) return;
    this.modifyPending = false;
    if (this.loadedFile && !this.closed) void this.handleExternalModify(this.loadedFile);
  }

  private toggleEditMode(): void {
    const enabled = this.editButton?.dataset.editing !== "true";
    if (this.editButton) {
      this.editButton.dataset.editing = String(enabled);
      this.editButton.setText(enabled ? "閲覧に戻る" : "編集を開始");
      this.editButton.setAttribute("aria-pressed", String(enabled));
    }
    this.renderer?.setEditMode(enabled);
    this.updateEditorControls();
  }

  private updateEditorControls(): void {
    const editor = this.editor;
    if (this.undoButton) this.undoButton.disabled = !editor?.canUndo;
    if (this.redoButton) this.redoButton.disabled = !editor?.canRedo;
    if (this.discardButton) this.discardButton.disabled = !editor?.dirty;
    if (this.saveButton) {
      this.saveButton.disabled = !this.sourceBytes || this.saving;
      this.saveButton.title = this.sourceBytes ? "コンテナー2.1 / DB 200101へ保存" : "この形式は保存未対応です";
    }

    if (this.editStatus) {
      const mode = this.editButton?.dataset.editing === "true" ? "編集モード" : "閲覧モード";
      const selection = editor?.selected ? ` / 選択中: ${editor.selected.id}` : "";
      const dirty = editor?.dirty ? " / 未保存変更" : "";
      const copy = this.savedCopy ? ` / 保存済みコピー: ${this.savedCopy}（保存時の配置）` : "";
      this.editStatus.setText(`${mode}${selection}${dirty}${copy}`);
    }
    if (this.alerts) {
      const messages = [
        editor && !editor.images.length ? "表示できる画像がありません" : "",
        this.editor?.dirty ? "未保存変更" : "",
        this.saving ? "保存中…" : "",
        this.externalChanged ? "外部更新あり。保存前に再読込または復旧が必要です" : "",
        this.failure,
        ...this.warnings,
      ].filter(Boolean);
      this.alerts.setText(messages.join("\n"));
      this.alerts.hidden = !this.purPlugin.debug || messages.length === 0;
    }
  }

  private onEditorChange(): void {
    this.updateEditorControls();
    const editor = this.editor;
    const snapshot = this.savingSnapshot;
    if (this.saving && editor && snapshot)
      this.autosave.changed(!sameSnapshot(editor.snapshot(), snapshot));
    else if (!this.saving) this.autosave.changed(Boolean(editor?.dirty));
  }

  private clearBoard(reason: string): void {
    this.imagePickerCleanup?.();
    this.trace(`clearBoard: ${reason}; renderer=${Boolean(this.renderer)}; loading=${Boolean(this.loading)}; dirty=${Boolean(this.editor?.dirty)}`);
    const caller = new Error().stack?.split("\n").slice(2, 6).map(line => line.trim()).join(" <- ");
    if (caller) this.trace(`clearBoard caller: ${caller}`);
    this.loading?.abort();
    this.loading = undefined;
    this.autosave.cancel();
    this.renderer?.dispose();
    this.renderer = undefined;
    this.editor = undefined;
    this.sourceBytes = undefined;
    this.savedCopy = undefined;
    this.warnings = [];
    this.failure = "";
    this.externalChanged = false;
    this.backupPath = undefined;
    this.loadId++;
    if (this.editButton) {
      this.editButton.dataset.editing = "false";
      this.editButton.setText("編集を開始");
      this.editButton.setAttribute("aria-pressed", "false");
    }
    if (this.reloadButton) this.reloadButton.hidden = true;
    this.updateEditorControls();
  }
  async onUnloadFile(file: TFile): Promise<void> {
    this.trace(`onUnloadFile: ${file.path}`);
    if (file.path !== this.activePath) {
      this.trace(`stale unload ignored: ${file.path}`);
      return;
    }
    if (this.saving && file === this.loadedFile) {
      this.trace("unload deferred during save");
      return;
    }
    if (this.editor?.dirty && file === this.loadedFile) {
      this.trace("unload retained dirty editor");
      return;
    }
    this.clearBoard(`onUnloadFile: ${file.path}`);
    this.activePath = "";
    this.loadedFile = undefined;
    this.status?.setText("");
  }
  async onClose(): Promise<void> {
    this.trace("onClose entered");
    this.autosave.cancel();
    if (this.editor?.dirty) {
      new Notice("ビューを閉じる前の最終保存を試みます。終了操作によって保存完了を待てない場合があります。", 8000);
      await this.savePurCurrent("close");
    }
    this.closed = true;
    if (this.editor?.dirty) {
      new Notice("ビュー終了後も未保存変更が残りました。自動保存は完了していません。診断と保存通知を確認してください。", 12000);
    }
    this.autosave.dispose();
    this.clearBoard("onClose");
    this.trace("onClose complete");
    this.purPlugin.purViews.delete(this);
  }
}

export default class PurPlugin extends Plugin {
  debug = false;
  frontOnSelect = true;
  autosaveDelaySeconds = DEFAULT_AUTOSAVE_SECONDS;
  readonly purViews = new Set<PurView>();
  readonly savingPaths = new Set<string>();
  backups!: PurBackups;
  private backupRecords: BackupRecord[] = [];
  private settingsQueue: Promise<void> = Promise.resolve();
  private readonly diagnostics: ViewerDiagnostics = {
    pluginStage: "plugin not loaded",
    launchStage: "no open request",
    requestedFile: "",
    viewStage: "no view created",
    viewFile: "",
    nextViewId: 0,
    sequence: 0,
    history: [],
    views: new Map(),
  };
  private persistedSettings: Record<string, unknown> = {};
  private autosaveSettingsNotice?: Notice;

  async onload(): Promise<void> {
    const settings: unknown = await this.loadData.call(this);
    this.persistedSettings = isSettingsRecord(settings) ? { ...settings } : {};
    this.debug = typeof settings === "object" && settings !== null && "debug" in settings && settings.debug === true;
    this.frontOnSelect = !(typeof settings === "object" && settings !== null &&
      "frontOnSelect" in settings && settings.frontOnSelect === false);
    const savedAutosaveSeconds = typeof settings === "object" && settings !== null &&
      "autosaveDelaySeconds" in settings ? settings.autosaveDelaySeconds : undefined;
    this.autosaveDelaySeconds = isAutosaveInterval(savedAutosaveSeconds)
      ? savedAutosaveSeconds
      : DEFAULT_AUTOSAVE_SECONDS;
    const records = typeof settings === "object" && settings !== null && "backups" in settings ? settings.backups : undefined;
    this.backups = new PurBackups(records, backups => this.persistPurSettings({ backups }));
    this.backupRecords = this.backups.snapshot();
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.backups.rename(oldPath, file.path).catch(error => {
        console.error("LazyRef PUR backup rename:", error);
        new Notice(`バックアップ管理の改名更新に失敗しました: ${error instanceof Error ? error.message : String(error)}`, 15000);
      });
    }));
    this.addSettingTab(new PurSettings(this.app, this));
    setHeicFallbackHandler(message => {
      this.diagnostics.pluginStage = `HEIC fallback: ${message}`;
      new Notice(message, 10000);
    });
    this.register(() => { disposeHeicWorker(); setHeicFallbackHandler(); });
    this.diagnostics.pluginStage = `onload entered; build ${BUILD_ID}`;
    this.registerView(VIEW_TYPE, leaf => {
      const view = new PurView(leaf, this.diagnostics, this);
      this.purViews.add(view);
      return view;
    });
    this.registerExtensions(["pur"], VIEW_TYPE);
    this.diagnostics.pluginStage = "view and pur extension registered";
    for (const [action, name] of [
      ["save", "現在のPURを保存"], ["undo", "PURの編集を元に戻す"],
      ["redo", "PURの編集をやり直す"], ["fit", "PURを全体表示"], ["menu", "PUR操作メニュー"],
    ] as const) {
      this.addCommand({
        id: `pur-${action}`, name,
        checkCallback: checking => {
          const view = this.app.workspace.getActiveViewOfType(PurView);
          if (!view) return false;
          if (!checking) view.runPurAction(action);
          return true;
        },
      });
    }
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pur") return;
      menu.addItem(item => item
        .setTitle("Open with LazyRef PUR Viewer")
        .setIcon("image")
        .onClick(() => {
          this.diagnostics.requestedFile = file.path;
          this.diagnostics.launchStage = "file-menu request received";
          void this.openPurFile(file);
        }));
    }));
    this.addCommand({
      id: "show-diagnostics",
      name: "PURビューアーの診断情報を表示",
      callback: () => {
        const modal = new Modal(this.app);
        modal.setTitle(`PUR診断 / ビルド ${BUILD_ID}`);
        const text = [
        `ビルド: ${BUILD_ID}`,
        `プラグイン: ${this.diagnostics.pluginStage}`,
        `起動要求: ${this.diagnostics.launchStage}`,
        `対象: ${this.diagnostics.requestedFile || "なし"}`,
        `ビュー: ${this.diagnostics.viewStage}`,
        `ファイル: ${this.diagnostics.viewFile || "なし"}`,
        "",
        "各ビュー（直近12件）:",
        ...this.diagnostics.views.values(),
        "",
        "現在の状態と警告:",
        ...[...this.purViews].map(view => view.purDiagnosticState()),
        "",
        "イベント履歴（直近64件）:",
        ...this.diagnostics.history,
        ].join("\n");
        const output = modal.contentEl.createEl("textarea");
        output.value = text;
        output.readOnly = true;
        output.rows = 20;
        output.style.width = "100%";
        output.setAttribute("aria-label", "PUR診断情報");
        modal.open();
      },
    });
  }

  private async openPurFile(file: TFile): Promise<void> {
    this.diagnostics.requestedFile = file.path;
    this.diagnostics.launchStage = "setViewState requested";
    try {
      await this.app.workspace.getLeaf(false).setViewState({
        type: VIEW_TYPE,
        state: { file: file.path },
        active: true,
      });
      this.diagnostics.launchStage = "setViewState completed";
    } catch (error) {
      this.diagnostics.launchStage = `setViewState failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error("LazyRef PUR Viewer:", error);
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`PURビューを開けません: ${message}`, 10000);
    }
  }

  async setPurFrontOnSelect(value: boolean): Promise<void> {
    try {
      await this.persistPurSettings({ frontOnSelect: value });
    } catch (error) {
      console.error("LazyRef PUR settings:", error);
      new Notice(`前面化の設定を保存できません: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async setPurDebug(value: boolean): Promise<void> {
    await this.persistPurSettings({ debug: value });
    for (const view of this.purViews) view.applyPurDebug();
  }

  async setAutosaveInterval(seconds: number): Promise<void> {
    if (!isAutosaveInterval(seconds)) throw new RangeError("自動保存の待ち時間は1～60秒で指定してください");
    await this.persistPurSettings({ autosaveDelaySeconds: seconds });
    for (const view of this.purViews) view.applyAutosaveInterval(seconds);
    this.clearAutosaveSettingsFailure();
  }

  reportAutosaveSettingsFailure(error: unknown): void {
    const message = `自動保存の待ち時間を保存できません: ${error instanceof Error ? error.message : String(error)}`;
    console.error("LazyRef PUR autosave setting:", error);
    if (this.autosaveSettingsNotice) {
      this.autosaveSettingsNotice.setMessage(message);
      return;
    }
    this.autosaveSettingsNotice = new Notice(message, 0);
  }

  private clearAutosaveSettingsFailure(): void {
    this.autosaveSettingsNotice?.hide();
    this.autosaveSettingsNotice = undefined;
  }

  private persistPurSettings(patch: {
    debug?: boolean;
    frontOnSelect?: boolean;
    autosaveDelaySeconds?: number;
    backups?: BackupRecord[];
  }): Promise<void> {
    const result = this.settingsQueue.then(async () => {
      const next = {
        ...this.persistedSettings,
        debug: this.debug,
        frontOnSelect: this.frontOnSelect,
        autosaveDelaySeconds: this.autosaveDelaySeconds,
        backups: this.backupRecords,
        ...patch,
      };
      await this.saveData.call(this, next);
      const readback: unknown = await this.loadData.call(this);
      if (!settingsMatch(next, readback))
        throw new Error("設定の書き込み後確認に失敗しました。実行中の設定値は変更していません");
      this.persistedSettings = { ...readback };
      this.debug = next.debug;
      this.frontOnSelect = next.frontOnSelect;
      this.autosaveDelaySeconds = next.autosaveDelaySeconds;
      this.backupRecords = next.backups;
    });
    this.settingsQueue = result.catch(() => undefined);
    return result;
  }
}

function isAutosaveInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= MIN_AUTOSAVE_SECONDS && value <= MAX_AUTOSAVE_SECONDS;
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsMatch(expected: Record<string, unknown>, actual: unknown): actual is Record<string, unknown> {
  if (!isSettingsRecord(actual)) return false;
  return Object.entries(expected).every(([key, value]) =>
    Object.prototype.hasOwnProperty.call(actual, key) &&
    JSON.stringify(actual[key]) === JSON.stringify(value));
}

class PurSettings extends PluginSettingTab {
    constructor(app: App, private readonly purPlugin: PurPlugin) { super(app, purPlugin); }
    display(): void {
      this.containerEl.empty();
      new Setting(this.containerEl).setName("デバッグモード")
        .setDesc("ツールバー、警告と状態、ビルド番号、読込計測を表示します。通常はオフで使用してください。")
        .addToggle(toggle => toggle.setValue(this.purPlugin.debug).onChange(async value => {
          try {
            await this.purPlugin.setPurDebug(value);
          } catch (error) {
            console.error("LazyRef PUR settings:", error);
            new Notice(`PUR設定を保存できません: ${error instanceof Error ? error.message : String(error)}`);
            toggle.setValue(this.purPlugin.debug);
          }
        }));
      let latestRequest = 0;
      const intervalDescription = `編集を止めてから保存を始めるまでの秒数（${MIN_AUTOSAVE_SECONDS}～${MAX_AUTOSAVE_SECONDS}秒、初期値${DEFAULT_AUTOSAVE_SECONDS}秒）。未保存の編集がある場合、設定変更後に待ち時間を数え直します。保存中は現在の間隔を維持し、設定保存後に反映します。`;
      const intervalSetting = new Setting(this.containerEl).setName("自動保存までの待ち時間")
        .setDesc(intervalDescription);
      intervalSetting
        .addSlider(slider => slider
          .setLimits(MIN_AUTOSAVE_SECONDS, MAX_AUTOSAVE_SECONDS, 1)
          .setValue(this.purPlugin.autosaveDelaySeconds)
          .setDynamicTooltip()
          .onChange(async value => {
            const request = ++latestRequest;
            intervalSetting.descEl.textContent = `${intervalDescription}（保存中…）`;
            try {
              await this.purPlugin.setAutosaveInterval(value);
              if (request === latestRequest) intervalSetting.descEl.textContent = intervalDescription;
            } catch (error) {
              this.purPlugin.reportAutosaveSettingsFailure(error);
              if (request === latestRequest) {
                slider.setValue(this.purPlugin.autosaveDelaySeconds);
                intervalSetting.descEl.textContent = intervalDescription;
              }
            }
          }));
  }
}
