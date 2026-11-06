import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { test } from "node:test";
import { imageDimensions } from "../src/image-import";
import type { ImageEditState } from "../src/editor";
import { animatedWebp, bmpFixture, gifFixture } from "./raster-fixtures";
import { svgFixture } from "./svg-fixtures";
import { transformedBounds } from "../src/board";
import { imageCenter, imageHandles, rotationHandles, selectionFrame } from "../src/handles";
import { groupFixture } from "./group-fixture";

test("browser bundle parses actual v2 and rejects legacy without Node, WASM assets or network", async () => {
  // Use the exact same build settings as the shipped plugin.
  const { browserOptions } = await import("../build.mjs");
  const bundle = await build({
    ...browserOptions,
    entryPoints: ["src/parser.ts"], write: false, format: "iife", globalName: "PurBrowser",
  });

  const sandbox = vm.createContext({
    console, TextDecoder, TextEncoder, setTimeout, clearTimeout, crypto: webcrypto,
    window: {},
    // Deliberately mimic the desktop's Node globals: the build must still choose the browser backend.
    process: { versions: { node: "test" } },
    require(name: string) { throw new Error(`Native dependency requested: ${name}`); },
    fetch() { throw new Error("Network requested"); },
  });
  vm.runInContext(bundle.outputFiles[0].text, sandbox);
  for (const name of ["S1_redbar-new.pur"]) {
    const data = [...readFileSync(new URL(`../../crates/purcore/tests/fixtures/${name}`, import.meta.url))];
    sandbox.fixtureBytes = data;
    const result = await vm.runInContext(
      "PurBrowser.parsePur(new Uint8Array(fixtureBytes)).then(b => JSON.stringify({count:b.images.length,warnings:b.warnings}))", sandbox);
    assert.deepEqual(JSON.parse(result), { count: 1, warnings: [] });
  }
  sandbox.fixtureBytes = [...readFileSync(new URL("../../crates/purcore/tests/fixtures/legacy/S1_redbar.pur", import.meta.url))];
  await assert.rejects(vm.runInContext("PurBrowser.parsePur(new Uint8Array(fixtureBytes))", sandbox), /未対応.*1\.10/);
});

test("HEIC browser bundle decodes with Node globals and without native, WASM, network or eval", async () => {
  const { browserOptions } = await import("../build.mjs");
  const bundle = await build({
    ...browserOptions, entryPoints: ["src/heic.ts"], write: false, format: "iife", globalName: "HeicBrowser",
  });
  const sandbox = vm.createContext({
    console, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    AbortController, window: {}, process: { versions: { node: "test" } },
    require(name: string) { throw new Error(`Native dependency requested: ${name}`); },
    fetch() { throw new Error("Network requested"); },
    WebAssembly: new Proxy({}, { get() { throw new Error("WASM requested"); } }),
    bytes: new Uint8Array(readFileSync(new URL("./fixtures/example.heic", import.meta.url))),
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(bundle.outputFiles[0].text, sandbox);
  const result = await vm.runInContext(
    "HeicBrowser.heicPixels(new Uint8Array(bytes),new AbortController().signal).then(p=>JSON.stringify({width:p.width,height:p.height,length:p.data.length}))",
    sandbox);
  assert.deepEqual(JSON.parse(result), { width: 1280, height: 854, length: 4372480 });
});

test("shipped CommonJS entry registers the pur view and opens files from the file menu", async () => {
  const { browserOptions } = await import("../build.mjs");
  const bundle = await build({
    ...browserOptions,
    entryPoints: ["src/main.ts"], write: false, format: "cjs", external: ["obsidian"], minify: true,
    legalComments: "eof",
  });
  const shippedEntry = readFileSync(new URL("../dist/main.js", import.meta.url), "utf8");
  assert.equal(shippedEntry, bundle.outputFiles[0].text, "build dist before testing the shipped plugin");
  const requests: string[] = [];
  let fileMenuHandler: ((menu: MenuStub, file: FakeTFile) => void) | undefined;
  type MenuEvent = { clientX: number; clientY: number; pointerType?: string } | { key: string };
  const menuActions: ((event?: MenuEvent) => void)[] = [];
  const titledActions = new Map<string, (event?: MenuEvent) => void>();
  const shownMenus: MenuStub[] = [];
  const headerActions = new Map<string, (event: MenuEvent) => void>();
  const menuChecks = new Map<string, boolean>();
  const menuDisabled = new Map<string, boolean>();
  interface CommandStub { id: string; name: string; hotkeys?: unknown[]; callback?: () => void; checkCallback?: (checking: boolean) => boolean }
  const commands: CommandStub[] = [];
  const notices: string[] = [];
  let noticeCreations = 0;
  const diagnosticOutputs: ElementStub[] = [];
  const loggedErrors: unknown[][] = [];
  const clickHandlers = new Map<ElementStub, () => void>();
  const modalButtons = new Map<string, () => void>();
  const inputs: ElementStub[] = [];
  const savedFiles = new Map<string, ArrayBuffer>();
  const liveFiles = new Map<string, ArrayBuffer>();
  const identities = new Map<string, FakeTFile>();
  const vaultHandlers = new Map<string, Array<(file: FakeTFile, oldPath?: string) => void>>();
  let writeHook: (() => void) | undefined;
  let writeError = false;
  let deleteError = false;
  let backupHook: (() => Promise<void>) | undefined;
  let savedSettings: {
    debug: boolean;
    frontOnSelect?: boolean;
    autosaveDelaySeconds?: number;
    backups?: unknown[];
    [key: string]: unknown;
  } | undefined;
  let settingTab: { display(): void } | undefined;
  let toggleDebug: ((value: boolean) => Promise<void>) | undefined;
  let changeAutosaveInterval: ((value: number) => Promise<void>) | undefined;
  let sliderValue = 0;
  let sliderLimits: [number | null, number | null, number | "any"] | undefined;
  let settingsSaveError = false;
  let dropSettingsSave = false;
  let holdSettingsSave = false;
  let releaseSettingsSave: (() => void) | undefined;
  let autosaveDescription: ElementStub | undefined;
  let activeView: TestView | null = null;
  const domHandlers = new Map<ElementStub, Map<string, (event: unknown) => void>>();
  const canvasHandlers = new Map<ElementStub, Map<string, (event: unknown) => void>>();
  let imagePicker: { getItems(): FakeTFile[]; onChooseItem(file: FakeTFile): void } | undefined;
  let savedNotice: (() => void) | undefined;
  let systemPicker: (() => void) | undefined;
  const fixture = readFileSync(new URL("../../crates/purcore/tests/fixtures/S1_redbar-new.pur", import.meta.url));
  const heicFixture = new Uint8Array(readFileSync(new URL("./fixtures/example.heic", import.meta.url)));
  let closedBitmaps = 0;
  let pendingRead: Promise<ArrayBuffer> | undefined;
  const drawingContext = new Proxy({}, { get: () => () => {} });
  const ownerWindow = {
    devicePixelRatio: 1,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    navigator: { clipboard: undefined as undefined | { read(): Promise<Array<{
      types: string[]; getType(type: string): Promise<Blob>;
    }>> } },
  };
  interface TestView {
    scope: Scope;
    contentEl: ElementStub;
    file: FakeTFile | null;
    setState(state: { file: string }): Promise<void>;
    getState(): { file?: string };
    canAcceptExtension(extension: string): boolean;
    onOpen(): Promise<void>;
    onLoadFile(file: FakeTFile): Promise<void>;
    onUnloadFile(file: FakeTFile): Promise<void>;
    onClose(): Promise<void>;
    savePurCurrent(): Promise<void>;
    importQueue: Promise<void>;
    renderer: {
      insertionPoint(point?: { x: number; y: number }): { x: number; y: number };
      camera: { x: number; y: number; scale: number };
      editGroup(id?: number): void;
      parentGroup(): void;
      undo(): void;
    };
    onPaneMenu(menu: MenuStub, source: string): void;
    runPurAction(action: "save" | "undo" | "redo" | "fit" | "menu"): void;
    editor: {
      snapshot(): ImageEditState[];
      bringToFront(id: number): void;
      setItem(id: number, matrix: number[]): void;
      commit(id: number, before: number[]): void;
      undo(): void;
      redo(): void;
      discard(): void;
      select(id?: number): void;
      toggleSelection(id: number): void;
      selectIds(ids: number[]): void;
      editingParent: number;
      selected?: import("../src/board").BoardImage;
      selectedImages: { id: number }[];
      selectedId?: number;
      dirty: boolean;
      canUndo: boolean;
      canRedo: boolean;
    };
    autosave: { delayMs: number };
  }
  let openedState: unknown;
  let createView: ((leaf: unknown) => TestView) | undefined;
  class FakeTFile {
    stat = { size: 1 };
    constructor(public path: string) { identities.set(path, this); }
    get extension() { return this.path.split(".").pop() ?? ""; }
    get basename() { return this.path.split("/").pop()?.replace(/\.pur$/, "") ?? ""; }
  }
  class ElementStub {
    type = "";
    accept = "";
    multiple = false;
    files: unknown[] | null = null;
    removed = false;
    pickerOpened = false;
    showPicker?: () => void;
    click() { this.pickerOpened = true; }
    remove() { this.removed = true; }
    isContentEditable = false;
    closest() { return ["input", "textarea", "select"].includes(this.tagName) ? this : null; }
    textContent = "";
    hidden = false;
    tabIndex = 0;
    dataset: Record<string, string> = {};
    clientWidth = 640;
    clientHeight = 480;
    ownerDocument = { defaultView: ownerWindow };
    style = { width: "" };
    value = "";
    text = "";
    tagName = "";
    children: ElementStub[] = [];
    empty() {}
    addClass(_className: string) {}
    createDiv(_options?: unknown) { return this.child(); }
    createEl(tag: string, options?: { text?: string; value?: string }) {
      const child = this.child();
      child.text = options?.text ?? "";
      child.tagName = tag;
      child.value = options?.value ?? "";
      if (tag === "textarea") diagnosticOutputs.push(child);
      if (tag === "input") { inputs.push(child); child.showPicker = systemPicker; }
      return child;
    }
    createSpan(_options?: unknown) { return this.child(); }
    setAttribute(_name: string, _value: string) {}
    setText(text: string) { this.textContent = text; }
    getContext() { return drawingContext; }
    addEventListener(name: string, callback: (event: unknown) => void) {
      const handlers = canvasHandlers.get(this) ?? new Map();
      handlers.set(name, callback);
      canvasHandlers.set(this, handlers);
    }
    focus() {}
    setPointerCapture() {}
    getBoundingClientRect() { return { left: 0, top: 0 }; }
    private child() {
      const element = new ElementStub();
      this.children.push(element);
      return element;
    }
  }
  class MenuStub {
    items: MenuItemStub[] = [];
    position?: { x: number; y: number };
    doc?: unknown;
    addItem(callback: (item: MenuItemStub) => void) {
      const item = new MenuItemStub();
      this.items.push(item);
      callback(item);
      return this;
    }
    showAtMouseEvent() { shownMenus.push(this); }
    showAtPosition(position: { x: number; y: number }, doc: unknown) {
      this.position = position; this.doc = doc; shownMenus.push(this);
    }
  }
  class MenuItemStub {
    title = "";
    callback?: (event?: MenuEvent) => void;
    setTitle(title: string) { this.title = title; return this; }
    setIcon(_icon: string) { return this; }
    setDisabled(disabled: boolean) { menuDisabled.set(this.title, disabled); return this; }
    setChecked(checked: boolean) { menuChecks.set(this.title, checked); return this; }
    onClick(callback: (event?: MenuEvent) => void) {
      this.callback = callback;
      menuActions.push(callback);
      titledActions.set(this.title, callback);
      return this;
    }
  }
  const openPurMenu = (view: TestView) => {
    const root = new MenuStub();
    view.onPaneMenu(root, "more-options");
    for (const item of root.items) item.callback?.();
    return root;
  };
  class Plugin {
    readonly disposers: Array<() => void> = [];
    register(callback: () => void) { this.disposers.push(callback); }
    viewType?: string;
    extensions?: string[];
    extensionType?: string;
    app = { vault: {
      on(name: string, handler: (file: FakeTFile, oldPath?: string) => void) {
        vaultHandlers.set(name, [...(vaultHandlers.get(name) ?? []), handler]);
        return {};
      },
    }, workspace: {
      on(name: string, callback: (menu: MenuStub, file: FakeTFile) => void) {
        assert.equal(name, "file-menu");
        fileMenuHandler = callback;
        return {};
      },
      getLeaf(newLeaf?: boolean) {
        assert.equal(newLeaf, false);
        return { setViewState: async (state: unknown) => { openedState = state; } };
      },
      getActiveViewOfType() { return activeView; },
    } };
    async loadData() {
      if (!(this instanceof Plugin)) throw new TypeError("Illegal invocation");
      return savedSettings;
    }
    async saveData(data: {
      debug: boolean;
      frontOnSelect?: boolean;
      autosaveDelaySeconds?: number;
      backups?: unknown[];
    }) {
      if (holdSettingsSave) await new Promise<void>(resolve => { releaseSettingsSave = resolve; });
      if (settingsSaveError) throw new TypeError("Illegal invocation");
      if (!(this instanceof Plugin)) throw new TypeError("Illegal invocation");
      if (!dropSettingsSave) savedSettings = data;
    }
    addSettingTab(tab: { display(): void }) { settingTab = tab; }
    registerEvent(_event: unknown) {}
    addCommand(command: CommandStub) {
      commands.push(command);
      return command;
    }
    registerView(type: string, creator: (leaf: unknown) => TestView) {
      this.viewType = type;
      createView = creator;
    }
    registerExtensions(extensions: string[], type: string) {
      this.extensions = extensions; this.extensionType = type;
    }
  }
  class Modal {
    contentEl = new ElementStub();
    setTitle(_title: string) {}
    open() { this.onOpen(); }
    onOpen() {}
    close() { this.onClose(); }
    onClose() {}
  }
  class PluginSettingTab {
    containerEl = new ElementStub();
  }
  class Scope {
    handler?: (event: { target?: ElementStub; preventDefault(): void }) => false | undefined;
    constructor(readonly parent?: Scope) {}
    register(modifiers: string[], key: string, handler: Scope["handler"]) {
      assert.deepEqual([...modifiers], ["Mod"]);
      assert.equal(key, "s");
      this.handler = handler;
    }
    dispatch(event: { target?: ElementStub; preventDefault(): void }): void {
      if (this.handler?.(event) !== false) this.parent?.dispatch(event);
    }
  }
  class Setting {
    descEl = new ElementStub();
    setName(name: string) {
      if (name === "自動保存までの待ち時間") autosaveDescription = this.descEl;
      return this;
    }
    setDesc() { return this; }
    addSlider(callback: (slider: unknown) => void) {
      const slider = {
        setLimits(min: number | null, max: number | null, step: number | "any") {
          sliderLimits = [min, max, step];
          return slider;
        },
        setValue(value: number) { sliderValue = value; return slider; },
        setDynamicTooltip() { return slider; },
        onChange(fn: (value: number) => Promise<void>) { changeAutosaveInterval = fn; return slider; },
      };
      callback(slider);
      return this;
    }
    addToggle(callback: (toggle: unknown) => void) {
      const toggle = {
        setValue() { return toggle; },
        onChange(fn: (value: boolean) => Promise<void>) { toggleDebug = fn; return toggle; },
      };
      callback(toggle);
      return this;
    }
  }
  class FileView {
    file: FakeTFile | null = null;
    contentEl = new ElementStub();
    app = {
      scope: new Scope(),
      vault: {
        on: (name: string, handler: (file: FakeTFile, oldPath?: string) => void) => {
          vaultHandlers.set(name, [...(vaultHandlers.get(name) ?? []), handler]);
          return {};
        },
        getAbstractFileByPath: (path: string) => identities.get(path),
        getFiles: () => [...identities.values()],
        readBinary: async (file: FakeTFile) => pendingRead ?? savedFiles.get(file.path) ?? liveFiles.get(file.path) ?? Uint8Array.from(fixture).buffer,
        modifyBinary: async (file: FakeTFile, bytes: ArrayBuffer) => {
          writeHook?.();
          if (writeError) throw new Error("disk full");
          liveFiles.set(file.path, bytes);
          if (activeView?.file === file) {
            await activeView.onUnloadFile(file);
            await activeView.onLoadFile(file);
          }
          for (const handler of vaultHandlers.get("modify") ?? []) handler(file);
        },
        adapter: {
          exists: async (path: string) => savedFiles.has(path),
          readBinary: async (path: string) => savedFiles.get(path)!,
        },
        createBinary: async (path: string, bytes: ArrayBuffer) => {
          assert.equal(savedFiles.has(path), false);
          savedFiles.set(path, bytes);
          new FakeTFile(path);
          if (path.endsWith(".bak")) await backupHook?.();
        },
        delete: async (file: FakeTFile) => {
          if (deleteError) throw new Error("backup delete failed");
          assert.equal(identities.get(file.path), file);
          savedFiles.delete(file.path);
          identities.delete(file.path);
        },
      },
    };
    constructor(_leaf: unknown) {}
    async setState(state: { file: string }) {
      await this.loadFile(new FakeTFile(state.file));
    }
    getState() { return { file: this.file?.path }; }
    async loadFile(file: FakeTFile) {
      if (this.file) await this.onUnloadFile(this.file);
      this.file = file;
      await this.onLoadFile(file);
    }
    async onLoadFile(_file: FakeTFile) {}
    async onUnloadFile(_file: FakeTFile) {}
    registerDomEvent(target: ElementStub, eventName: string, callback: (event: unknown) => void) {
      if (eventName === "click") clickHandlers.set(target, () => callback(undefined));
      const handlers = domHandlers.get(target) ?? new Map();
      handlers.set(eventName, callback);
      domHandlers.set(target, handlers);
    }
    registerEvent(_event: unknown) {}
    register(_callback: () => void) {}
    addAction(_icon: string, title: string, callback: (event: MenuEvent) => void) {
      headerActions.set(title, callback);
      return new ElementStub();
    }
    onPaneMenu(_menu: MenuStub, _source: string) {}
  }
  class ButtonComponent {
    label = "";
    constructor(_container: HTMLElement) {}
    setButtonText(text: string) { this.label = text; return this; }
    onClick(callback: () => void) { modalButtons.set(this.label, callback); return this; }
    setWarning() { return this; }
  }
  class FuzzySuggestModal {
    constructor(readonly app: FileView["app"]) {}
    setPlaceholder() {}
    getItems(): FakeTFile[] { return []; }
    onChooseItem(_file: FakeTFile) {}
    open() { imagePicker = this; }
  }
  const sandbox = vm.createContext({
    console: { ...console, error: (...args: unknown[]) => loggedErrors.push(args) },
    TextDecoder, TextEncoder, setTimeout, clearTimeout, crypto: webcrypto, performance,
    AbortController, DOMException, window: {}, HTMLElement: ElementStub, process: { versions: { node: "test" } },
    Blob,
    atob, URL,
    ImageData: class {
      constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
    },
    DOMParser: class {
      parseFromString(text: string) {
        assert.equal(text, new TextDecoder().decode(svgFixture), "SVG DOM stub is limited to its known fixture");
        const attrs: Record<string, string> = {
          xmlns: "http://www.w3.org/2000/svg", width: "3", height: "2",
        };
        const root = {
          localName: "svg", namespaceURI: "http://www.w3.org/2000/svg",
          getAttribute: (name: string) => attrs[name] ?? null,
          attributes: Object.entries(attrs).map(([localName, value]) => ({
            localName, value, namespaceURI: localName === "xmlns" ? "http://www.w3.org/2000/xmlns/" : null,
          })),
        };
        return { documentElement: root, querySelector: () => null, getElementsByTagName: () => [root] };
      }
    },
    Image: class {
      width = 0; height = 0;
      onload?: () => void;
      onerror?: () => void;
      set src(value: string) { if (value) void Promise.resolve().then(() => this.onload?.()); }
    },
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => drawingContext }) },
    createImageBitmap: async (blob: Blob | { width: number; height: number }) => {
      if (!(blob instanceof Blob)) return { width: blob.width, height: blob.height, close() { closedBitmaps++; } };
      const dimensions = imageDimensions(new Uint8Array(await blob.arrayBuffer()));
      return { width: dimensions.width, height: dimensions.height, close() { closedBitmaps++; } };
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    module: { exports: {} },
    require(name: string) {
      requests.push(name);
      if (name === "obsidian") {
        return {
          Plugin, Modal, FuzzySuggestModal, ButtonComponent, FileView, Menu: MenuStub, PluginSettingTab, Setting, Scope,
          Notice: class {
            private readonly noticeIndex: number;
            constructor(message: string) {
              noticeCreations++;
              notices.push(message);
              this.noticeIndex = notices.length - 1;
              if (message.startsWith("別名保存しました:") || message.startsWith("保存しました:")) savedNotice?.();
            }
            setMessage(message: string) { notices[this.noticeIndex] = message; return this; }
            hide() { notices[this.noticeIndex] = ""; }
          },
          TFile: FakeTFile,
        };
      }
      throw new Error(`Unexpected runtime dependency: ${name}`);
    },
  });
  vm.runInContext(shippedEntry, sandbox);
  savedSettings = {
    debug: false,
    frontOnSelect: true,
    autosaveDelaySeconds: 3,
    backups: [],
    unrelatedPluginSetting: { retained: true },
  };
  const registration = JSON.parse(await vm.runInContext(`(async () => {
    const plugin = new module.exports.default();
    globalThis.testPlugin = plugin;
    await plugin.onload();
    return JSON.stringify({
      extensions: plugin.extensions,
      consistent: plugin.viewType === plugin.extensionType,
      frontOnSelect: plugin.frontOnSelect,
      autosaveDelaySeconds: plugin.autosaveDelaySeconds
    });
  })()`, sandbox));
  assert.deepEqual(requests, ["obsidian"]);
  assert.deepEqual(registration, {
    extensions: ["pur"], consistent: true, frontOnSelect: true, autosaveDelaySeconds: 3,
  });
  const livePlugin = vm.runInContext("testPlugin", sandbox) as {
    setAutosaveInterval(value: number): Promise<void>;
    autosaveDelaySeconds: number;
    disposers: Array<() => void>;
  };
  assert.equal(livePlugin.disposers.length, 1, "plugin unload registers HEIC Worker cleanup");
  assert.ok(createView);
  assert.equal(createView({}).canAcceptExtension("pur"), true);
  assert.ok(fileMenuHandler);
  const file = new FakeTFile("boards/example.pur");
  const menu = new MenuStub();
  fileMenuHandler(new MenuStub(), new FakeTFile("boards/notes.md"));
  assert.equal(menuActions.length, 0);
  fileMenuHandler(menu, file);
  assert.equal(menuActions.length, 1);
  menuActions[0]?.();
  assert.deepEqual(JSON.parse(JSON.stringify(openedState)), {
    type: "lazyref-pur-view",
    state: { file: "boards/example.pur" },
    active: true,
  });
  assert.ok(createView);
  const view = createView({});
  await view.onOpen();
  await view.onLoadFile(Object.assign(new FakeTFile("boards/large.pur"), {
    stat: { size: 64 * 1024 * 1024 + 1 },
  }));
  assert.ok(notices.some(message => message.includes("64 MiB")));
  assert.equal(loggedErrors.length, 1);
  const diagnosticsCommand = commands.find(command => command.id === "show-diagnostics");
  assert.ok(diagnosticsCommand);
  diagnosticsCommand.callback!();
  const diagnosticNotice = diagnosticOutputs[diagnosticOutputs.length - 1]?.value ?? "";
  assert.ok(diagnosticNotice.includes("ビルド: 0.18.1"));
  assert.ok(diagnosticNotice.includes("ファイル読込 failed"));
  const first = new FakeTFile("boards/first.pur");
  const second = new FakeTFile("boards/second.pur");
  await view.onLoadFile(first);
  assert.equal(closedBitmaps, 0);
  await view.onLoadFile(second);
  assert.equal(closedBitmaps, 1);
  await view.onUnloadFile(first);
  assert.equal(closedBitmaps, 1, "late unload of the old file must not dispose the new renderer");
  const otherView = createView({});
  await otherView.onOpen();
  await otherView.onLoadFile(first);
  await otherView.onClose();
  assert.equal(closedBitmaps, 2);
  diagnosticsCommand.callback!();
  const history = diagnosticOutputs[diagnosticOutputs.length - 1]?.value ?? "";
  assert.match(history, /V2\/L\d+ boards\/second.pur: stale unload ignored/);
  assert.match(history, /V3\/L\d+ boards\/first.pur: clearBoard: onClose; renderer=true/);
  assert.match(history, /V2\/L\d+ boards\/second.pur: frame drawn/);
  await view.onUnloadFile(second);
  assert.equal(closedBitmaps, 3);
  await otherView.onLoadFile(second);
  assert.equal(closedBitmaps, 3, "a closed view must not restart loading");
  let completeRead: ((bytes: ArrayBuffer) => void) | undefined;
  pendingRead = new Promise(resolve => { completeRead = resolve; });
  const pendingView = createView({});
  await pendingView.onOpen();
  const pendingLoad = pendingView.onLoadFile(first);
  await pendingView.onClose();
  assert.ok(completeRead);
  completeRead(Uint8Array.from(fixture).buffer);
  await pendingLoad;
  diagnosticsCommand.callback!();
  const cancelledHistory = diagnosticOutputs[diagnosticOutputs.length - 1]?.value ?? "";
  assert.match(cancelledHistory, /V4\/L1 boards\/first.pur: load aborted/);
  assert.match(cancelledHistory, /V4\/L2 boards\/first.pur: onClose complete/);
  const summaries = cancelledHistory.split("イベント履歴")[0];
  assert.match(summaries, /V4\/L2 boards\/first.pur: onClose complete/);
  assert.doesNotMatch(summaries, /V4\/L1/);
  assert.equal(closedBitmaps, 3);
  for (let i = 0; i < 80; i++) await view.onUnloadFile(first);
  diagnosticsCommand.callback!();
  const boundedHistory = diagnosticOutputs[diagnosticOutputs.length - 1]?.value.split("イベント履歴（直近64件）:\n")[1] ?? "";
  assert.equal(boundedHistory.split("\n").length, 64);
  const lifecycleView = createView({});
  await lifecycleView.onOpen();
  await lifecycleView.setState({ file: first.path });
  assert.equal(lifecycleView.file?.path, first.path,
    "FileView.setState must retain the base loadFile implementation that assigns file");
  assert.equal(lifecycleView.getState().file, first.path);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(lifecycleView), "loadFile"), false,
    "custom rendering must not shadow FileView's undocumented loadFile method");
  diagnosticsCommand.callback!();
  const lifecycleHistory = diagnosticOutputs[diagnosticOutputs.length - 1]?.value ?? "";
  assert.match(lifecycleHistory, /onLoadFile entered: boards\/first.pur/);
  await lifecycleView.setState({ file: second.path });
  assert.equal(lifecycleView.file?.path, second.path);
  pendingRead = undefined;
  const toolbar = lifecycleView.contentEl.children[0];
  assert.equal(toolbar.hidden, true, "normal mode must hide the toolbar");
  assert.equal(lifecycleView.contentEl.children[1].hidden, true, "normal mode must hide metrics");
  settingTab!.display();
  assert.ok(toggleDebug);
  assert.ok(changeAutosaveInterval);
  assert.deepEqual(sliderLimits, [1, 60, 1], "the interval slider must enforce whole seconds from 1 through 60");
  assert.equal(sliderValue, 3, "the default interval is three seconds");
  await changeAutosaveInterval(5);
  assert.equal(savedSettings?.autosaveDelaySeconds, 5);
  assert.deepEqual(savedSettings?.unrelatedPluginSetting, { retained: true },
    "saving the interval must preserve unknown existing plugin settings");
  assert.equal(lifecycleView.autosave.delayMs, 5000,
    "changing the setting updates an already-open view");
  const restoredInterval = await vm.runInContext(`(async () => {
    const restored = new module.exports.default();
    await restored.onload();
    globalThis.restoredTestPlugin = restored;
    return restored.autosaveDelaySeconds;
  })()`, sandbox);
  assert.equal(restoredInterval, 5, "the configured interval survives plugin reload");
  const persistedSettings = savedSettings;
  savedSettings = { ...savedSettings!, autosaveDelaySeconds: 0 };
  const invalidInterval = await vm.runInContext(`(async () => {
    const restored = new module.exports.default();
    await restored.onload();
    return restored.autosaveDelaySeconds;
  })()`, sandbox);
  savedSettings = persistedSettings;
  assert.equal(invalidInterval, 3, "invalid persisted intervals fall back to the documented default");
  await assert.rejects(livePlugin.setAutosaveInterval(0), /1～60秒/);
  await assert.rejects(livePlugin.setAutosaveInterval(61), /1～60秒/);
  assert.equal(livePlugin.autosaveDelaySeconds, 5, "invalid values do not change the active setting");
  holdSettingsSave = true;
  const pendingSettingSave = changeAutosaveInterval(6);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(autosaveDescription?.textContent ?? "", /（保存中…）$/);
  assert.equal(livePlugin.autosaveDelaySeconds, 5, "the running interval stays active until settings persist");
  assert.ok(releaseSettingsSave);
  releaseSettingsSave();
  await pendingSettingSave;
  holdSettingsSave = false;
  assert.equal(livePlugin.autosaveDelaySeconds, 6);
  assert.doesNotMatch(autosaveDescription?.textContent ?? "", /（保存中…）$/);
  settingsSaveError = true;
  await changeAutosaveInterval(8);
  const noticesBeforeRepeatedFailure = noticeCreations;
  await changeAutosaveInterval(9);
  settingsSaveError = false;
  assert.equal(livePlugin.autosaveDelaySeconds, 6, "a persistence failure must not change the active interval");
  assert.equal(sliderValue, 6, "a persistence failure restores the setting control");
  assert.ok(notices.some(message => message.includes("Illegal invocation")));
  assert.equal(noticeCreations, noticesBeforeRepeatedFailure,
    "repeated slider persistence failures update one notice rather than creating more");
  await changeAutosaveInterval(7);
  assert.equal(notices.filter(message => message.startsWith("自動保存の待ち時間を保存できません:")).length, 0,
    "a successful setting save dismisses the consolidated failure notice");
  assert.equal(savedSettings?.autosaveDelaySeconds, 7);
  dropSettingsSave = true;
  await changeAutosaveInterval(8);
  dropSettingsSave = false;
  assert.equal(livePlugin.autosaveDelaySeconds, 7,
    "a failed readback must not apply an unverified interval");
  assert.equal(sliderValue, 7);
  assert.ok(notices.some(message => message.includes("書き込み後確認に失敗")));
  await toggleDebug(true);
  assert.equal(toolbar.hidden, false);
  assert.equal(savedSettings?.debug, true);
  await toggleDebug(false);
  assert.equal(toolbar.hidden, true, "debug changes must apply to already open views");
  const editButton = toolbar.children.find(element => element.text === "編集を開始");
  assert.equal(editButton?.dataset.editing, "true", "boards must start in edit mode");
  const saveCommand = commands.find(command => command.id === "pur-save");
  assert.equal(saveCommand?.checkCallback?.(true), false, "save command must not intercept other notes");
  activeView = lifecycleView;
  assert.equal(saveCommand?.checkCallback?.(true), true);
  assert.equal(saveCommand?.hotkeys, undefined, "PUR command must not register a duplicate global hotkey");
  openPurMenu(lifecycleView);
  assert.ok(titledActions.has("選択時に最前面へ移動"));
  assert.equal(menuChecks.get("選択時に最前面へ移動"), true);
  titledActions.get("選択時に最前面へ移動")!();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(savedSettings?.frontOnSelect, false);
  openPurMenu(lifecycleView);
  assert.equal(menuChecks.get("選択時に最前面へ移動"), false);
  assert.equal(await vm.runInContext(`(async () => {
    const restored = new module.exports.default();
    await restored.onload();
    globalThis.restoredTestPlugin = restored;
    return restored.frontOnSelect;
  })()`, sandbox), false, "front-on-select preference must survive a new plugin instance");
  await toggleDebug(true);
  assert.equal(savedSettings?.frontOnSelect, false, "debug settings must preserve the front-on-select preference");
  await toggleDebug(false);
  titledActions.get("選択時に最前面へ移動")!();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(savedSettings?.frontOnSelect, true);
  assert.ok(titledActions.has("保存（現在の .pur を上書き）"), "the pane menu provides touch-accessible saving");
  assert.ok(titledActions.has("元に戻す") && titledActions.has("全体表示"));
  const selectedPlacement = lifecycleView.editor.snapshot()[0];
  lifecycleView.editor.select(selectedPlacement.id);
  for (const [title, expectedLabel] of [
    ["90°時計回りに回転", "clockwise"],
    ["90°反時計回りに回転", "counterclockwise"],
    ["左右反転", "horizontal flip"],
    ["上下反転", "vertical flip"],
  ]) {
    openPurMenu(lifecycleView);
    const before = lifecycleView.editor.snapshot();
    assert.ok(titledActions.has(title), `${expectedLabel} is available in the PUR operation menu`);
    titledActions.get(title)!();
    const after = lifecycleView.editor.snapshot();
    assert.notDeepEqual(after, before, `${expectedLabel} changes the selected image transform`);
    assert.equal(lifecycleView.editor.dirty, true);
    assert.equal(lifecycleView.editor.canUndo, true);
    lifecycleView.editor.undo();
    assert.deepEqual(lifecycleView.editor.snapshot(), before, `${expectedLabel} is undone as one operation`);
    lifecycleView.editor.redo();
    assert.deepEqual(lifecycleView.editor.snapshot(), after, `${expectedLabel} is redone consistently`);
    lifecycleView.editor.undo();
  }
  lifecycleView.editor.discard();
  const canvas = lifecycleView.contentEl.children[3];
  assert.ok(domHandlers.get(canvas)?.has("contextmenu"));
  assert.ok(domHandlers.get(canvas)?.has("pointerdown"), "touch long press is registered on the canvas");
  const shortcutSaved = new Promise<void>(resolve => { savedNotice = resolve; });
  let prevented = false;
  assert.equal(lifecycleView.scope.handler?.({
    target: canvas, preventDefault: () => { prevented = true; },
  }), false, "view scope must stop the parent standard-save handler");
  await shortcutSaved;
  assert.equal(prevented, true, "Mod+S is handled by the PUR view scope");
  assert.ok(lifecycleView.scope.parent, "unhandled keys retain the app's parent scope");
  let standardSaves = 0;
  lifecycleView.scope.parent!.handler = () => { standardSaves++; return false; };
  const scopedSaved = new Promise<void>(resolve => { savedNotice = resolve; });
  lifecycleView.scope.dispatch({ target: canvas, preventDefault() {} });
  await scopedSaved;
  assert.equal(standardSaves, 0, "PUR save must not also invoke the parent standard-save command");
  lifecycleView.scope.parent!.dispatch({ preventDefault() {} });
  assert.equal(standardSaves, 1, "the app's standard save must remain available outside the PUR scope");
  const inputTarget = new ElementStub();
  inputTarget.isContentEditable = true;
  assert.equal(lifecycleView.scope.handler?.({ target: inputTarget, preventDefault: () => assert.fail() }), undefined);
  assert.ok([...domHandlers.values()].every(handlers => !handlers.has("keydown")),
    "saving must not also be registered through DOM handlers");
  const saveButton = toolbar.children.find(element => element.text === "別名 .pur 保存");
  assert.ok(saveButton);
  const saved = new Promise<void>(resolve => { savedNotice = resolve; });
  const saveClick = clickHandlers.get(saveButton);
  assert.ok(saveClick);
  saveClick();
  const nameInput = inputs[inputs.length - 1];
  assert.ok(nameInput);
  nameInput.value = "ui-copy.pur";
  const confirmSave = modalButtons.get("別名保存");
  assert.ok(confirmSave);
  confirmSave();
  await saved;
  assert.ok(savedFiles.has("boards/ui-copy.pur"));
  assert.equal(lifecycleView.getState().file, second.path, "save-as must not switch or rename the source view");
  const editor = lifecycleView.editor;
  const before = editor.snapshot()[0];
  const moved = [...before.item] as typeof before.item;
  moved[4] += 10;
  editor.setItem(before.id, moved);
  editor.commit(before.id, before.item);
  await lifecycleView.savePurCurrent();
  assert.equal(editor.dirty, false, "successful overwrite must update the saved baseline");
  assert.equal(lifecycleView.editor, editor, "self modify must not recreate the editor");
  await lifecycleView.onLoadFile(lifecycleView.file!);
  assert.equal(lifecycleView.editor, editor, "late same-file loads must retain history after saving");
  assert.ok(liveFiles.has(second.path));
  assert.ok([...savedFiles.keys()].some(path => path.startsWith(`${second.path}.lazyref-`) && path.endsWith(".bak")));
  const written = Uint8Array.from(new Uint8Array(liveFiles.get(second.path)!));
  const after = editor.snapshot()[0];
  const movedAgain = [...after.item] as typeof after.item;
  movedAgain[4] += 20;
  editor.setItem(before.id, movedAgain);
  editor.commit(before.id, after.item);
  writeHook = () => {
    const snapshot = editor.snapshot()[0];
    const later = [...snapshot.item] as typeof snapshot.item;
    later[4] += 30;
    editor.setItem(snapshot.id, later);
    editor.commit(snapshot.id, snapshot.item);
  };
  await lifecycleView.savePurCurrent();
  writeHook = undefined;
  const managed = [...savedFiles.keys()].filter(path => path.startsWith(`${second.path}.lazyref-managed-`));
  assert.equal(managed.length, 1, "consecutive saves must retain one managed recovery generation");
  assert.deepEqual(new Uint8Array(savedFiles.get(managed[0])!), written, "backup must contain the preceding saved version");
  assert.equal(editor.dirty, true, "edits during saving must remain dirty");
  assert.equal(lifecycleView.editor, editor);
  editor.undo();
  assert.equal(editor.dirty, false);
  editor.redo();
  assert.equal(editor.dirty, true);
  writeError = true;
  await lifecycleView.savePurCurrent();
  writeError = false;
  assert.equal(editor.dirty, true, "write failure must preserve unsaved edits");
  const alerts = lifecycleView.contentEl.children[2];
  assert.equal(alerts.hidden, true, "normal mode must hide persistent failures and dirty status");
  await toggleDebug(true);
  assert.equal(alerts.hidden, false);
  assert.match(alerts.textContent, /disk full/);
  await toggleDebug(false);
  assert.equal(alerts.hidden, true);
  diagnosticsCommand.callback!();
  assert.match(diagnosticOutputs[diagnosticOutputs.length - 1].value, /disk full/);
  assert.ok(notices.some(message => message.includes("disk full") && message.includes("復旧用コピー")));
  liveFiles.set(second.path, written.buffer);
  await lifecycleView.savePurCurrent();
  assert.equal(editor.dirty, true, "external source changes must not clear edits");
  assert.ok(notices.some(message => message.includes("外部更新")));
  const oldPath = lifecycleView.file!.path;
  lifecycleView.file!.path = "boards/renamed.pur";
  await lifecycleView.savePurCurrent();
  assert.ok(notices.some(message => message.includes("改名")));
  lifecycleView.file!.path = oldPath;
  identities.delete(oldPath);
  await lifecycleView.savePurCurrent();
  assert.ok(notices.some(message => message.includes("削除")));
  assert.equal(editor.dirty, true);
  await lifecycleView.onClose();
  const { sqlite, extractDatabase, parsePur } = await import("../src/parser");
  const { wrapDatabase } = await import("../src/writer");
  const SQL = await sqlite();
  const stackedDb = new SQL.Database(extractDatabase(fixture));
  let stackedBytes: Uint8Array;
  try {
    stackedDb.run(`INSERT INTO items (id,parent,transform,opacity,z,sort_order)
      SELECT id+1,parent,transform,opacity,z,sort_order FROM items;
      INSERT INTO items_images (id,image,image_transform,image_bounds,flags,playback_state,playback_frame)
      SELECT id+1,image,image_transform,image_bounds,flags,playback_state,playback_frame FROM items_images;`);
    stackedBytes = wrapDatabase(fixture, stackedDb.export());
  } finally { stackedDb.close(); }
  const stackedView = createView({});
  liveFiles.set("boards/stacked.pur", Uint8Array.from(stackedBytes).buffer);
  await stackedView.onOpen();
  await stackedView.setState({ file: "boards/stacked.pur" });
  activeView = stackedView;
  const stackingEditor = stackedView.editor;
  const initialStack = stackingEditor.snapshot();
  stackingEditor.bringToFront(initialStack[0].id);
  await stackedView.savePurCurrent();
  assert.equal(stackingEditor.dirty, false, "successful overwrite accepts a stacking-only edit");
  const savedStack = await parsePur(new Uint8Array(liveFiles.get("boards/stacked.pur")!));
  assert.equal(savedStack.images[savedStack.images.length - 1].id, initialStack[0].id);
  writeHook = () => stackingEditor.bringToFront(initialStack[1].id);
  await stackedView.savePurCurrent();
  writeHook = undefined;
  assert.equal(stackingEditor.dirty, true, "additional front changes during overwrite remain dirty");
  assert.equal(stackedView.editor, stackingEditor, "self modify must preserve the order editor and history");
  stackingEditor.undo();
  assert.equal(stackingEditor.dirty, false);
  stackingEditor.redo();
  assert.equal(stackingEditor.dirty, true);
  await stackedView.savePurCurrent();
  deleteError = true;
  await stackedView.savePurCurrent();
  deleteError = false;
  assert.equal(stackingEditor.dirty, false, "verified output is saved even if backup cleanup separately fails");
  assert.ok(notices.some(message => message.includes("整理は未完了") && message.includes("backup delete failed")));
  assert.equal([...savedFiles.keys()].filter(path => path.startsWith("boards/stacked.pur.lazyref-managed-")).length, 2);
  await toggleDebug(true);
  assert.ok((savedSettings?.backups?.length ?? 0) > 0, "UI settings must retain backup ownership records");
  await toggleDebug(false);
  await stackedView.savePurCurrent();
  assert.equal([...savedFiles.keys()].filter(path => path.startsWith("boards/stacked.pur.lazyref-managed-")).length, 1,
    "a later verified save retries failed cleanup");
  const renamedFile = stackedView.file!;
  const pendingRename = stackedView.editor.snapshot()[0];
  const pendingMatrix = [...pendingRename.item];
  pendingMatrix[4] += 1;
  stackedView.editor.setItem(pendingRename.id, pendingMatrix);
  stackedView.editor.commit(pendingRename.id, pendingRename.item);
  const renameEditor = stackedView.editor;
  const renamedBytes = liveFiles.get(renamedFile.path)!;
  const renamedOldPath = renamedFile.path;
  identities.delete(renamedOldPath);
  liveFiles.delete(renamedOldPath);
  renamedFile.path = "boards/stacked-renamed.pur";
  identities.set(renamedFile.path, renamedFile);
  liveFiles.set(renamedFile.path, renamedBytes);
  for (const handler of vaultHandlers.get("rename") ?? []) handler(renamedFile, renamedOldPath);
  await stackedView.onLoadFile(renamedFile);
  assert.equal(stackedView.editor, renameEditor, "verified rename reload preserves the existing edit history");
  assert.equal(renameEditor.dirty, true);
  await stackedView.savePurCurrent();
  assert.equal(renameEditor.dirty, false, "save must use the verified new source path");
  const renamedBackups = [...savedFiles.keys()].filter(path =>
    path.startsWith("boards/stacked-renamed.pur.lazyref-managed-") || path.startsWith("boards/stacked.pur.lazyref-managed-"));
  assert.equal(renamedBackups.length, 1);
  assert.deepEqual(new Uint8Array(savedFiles.get(renamedBackups[0])!), new Uint8Array(renamedBytes));
  assert.ok(savedSettings?.backups?.some(record => typeof record === "object" && record !== null &&
    "source" in record && record.source === renamedFile.path), "registered backup follows the renamed source");
  await stackedView.onClose();
  const closingView = createView({});
  await closingView.onOpen();
  await closingView.setState({ file: "boards/closing.pur" });
  const closeBefore = closingView.editor.snapshot()[0];
  const closeMoved = [...closeBefore.item] as typeof closeBefore.item;
  closeMoved[4] += 7;
  closingView.editor.setItem(closeBefore.id, closeMoved);
  closingView.editor.commit(closeBefore.id, closeBefore.item);
  const closingEditor = closingView.editor;
  let closingCompletion: Promise<void> | undefined;
  backupHook = async () => { closingCompletion = closingView.onClose(); };
  await closingView.savePurCurrent();
  backupHook = undefined;
  await closingCompletion;
  assert.equal(liveFiles.has("boards/closing.pur"), true, "close waits for the save already in progress when the API permits");
  assert.equal(closingEditor.dirty, false, "a close-time save preserves the last edit before disposing the renderer");
  assert.ok(notices.some(message => message.includes("閉じる前の最終保存")));
  assert.ok(notices.some(message => message.includes("保存しました: boards/closing.pur")),
    "the already-running operation reports its verified write before close completes");
  const directCloseView = createView({});
  liveFiles.set("boards/direct-close.pur", Uint8Array.from(fixture).buffer);
  await directCloseView.onOpen();
  await directCloseView.setState({ file: "boards/direct-close.pur" });
  const directCloseEditor = directCloseView.editor;
  const directBefore = directCloseEditor.snapshot()[0];
  const directMoved = [...directBefore.item] as typeof directBefore.item;
  directMoved[4] += 9;
  directCloseEditor.setItem(directBefore.id, directMoved);
  directCloseEditor.commit(directBefore.id, directBefore.item);
  await directCloseView.onClose();
  assert.equal(directCloseEditor.dirty, false, "direct close makes a final save attempt before disposing");
  assert.ok(notices.some(message => message.includes("ビューを閉じる前に保存しました: boards/direct-close.pur")));
  const failedCloseView = createView({});
  liveFiles.set("boards/failed-close.pur", Uint8Array.from(fixture).buffer);
  await failedCloseView.onOpen();
  await failedCloseView.setState({ file: "boards/failed-close.pur" });
  const failedCloseEditor = failedCloseView.editor;
  const failedBefore = failedCloseEditor.snapshot()[0];
  const failedMoved = [...failedBefore.item] as typeof failedBefore.item;
  failedMoved[4] += 11;
  failedCloseEditor.setItem(failedBefore.id, failedMoved);
  failedCloseEditor.commit(failedBefore.id, failedBefore.item);
  writeError = true;
  await failedCloseView.onClose();
  writeError = false;
  assert.equal(failedCloseEditor.dirty, true, "failed final save retains dirty state");
  assert.ok(notices.some(message => message.includes("ビュー終了後も未保存変更が残りました")));
  const restoredPlugin = vm.runInContext("restoredTestPlugin", sandbox) as {
    setAutosaveInterval(value: number): Promise<void>;
  };
  await restoredPlugin.setAutosaveInterval(3);
  const idleView = createView({});
  assert.equal(idleView.autosave.delayMs, 3000, "new views use the persisted interval");
  liveFiles.set("boards/idle.pur", Uint8Array.from(fixture).buffer);
  await idleView.onOpen();
  await idleView.setState({ file: "boards/idle.pur" });
  const idleEditor = idleView.editor;
  const idleBefore = idleEditor.snapshot()[0];
  const idleMoved = [...idleBefore.item] as typeof idleBefore.item;
  idleMoved[4] += 12;
  idleEditor.setItem(idleBefore.id, idleMoved);
  idleEditor.commit(idleBefore.id, idleBefore.item);
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(idleEditor.dirty, false, "the real FileView integration saves after the idle debounce");
  assert.ok(liveFiles.get("boards/idle.pur")?.byteLength);
  await idleView.onClose();
  const imageView = createView({});
  liveFiles.set("boards/images.pur", Uint8Array.from(fixture).buffer);
  await imageView.onOpen();
  await imageView.setState({ file: "boards/images.pur" });
  activeView = imageView;
  const imageCanvas = imageView.contentEl.children[3];
  const paste = domHandlers.get(imageView.contentEl)!.get("paste")!;
  const drop = domHandlers.get(imageCanvas)!.get("drop")!;
  const imageBytes = imageView.editor.snapshot()[0];
  const png = (await parsePur(new Uint8Array(fixture))).images[0].data;
  const pngFile = { size: png.length, arrayBuffer: async () => Uint8Array.from(png).buffer };
  const clipboardData = { items: [{ kind: "file", getAsFile: () => pngFile }] };
  let pastePrevented = false;
  const plainInput = new ElementStub();
  plainInput.tagName = "input";
  paste({ target: plainInput, clipboardData, preventDefault: () => assert.fail("input paste was intercepted") });
  paste({ target: { isContentEditable: false, closest: () => plainInput }, clipboardData,
    preventDefault: () => assert.fail("a popout input paste was intercepted") });
  paste({ target: imageCanvas, clipboardData: { items: [] },
    preventDefault: () => assert.fail("text-only paste was intercepted") });
  assert.equal(imageView.editor.snapshot().length, 1);
  const center = imageView.renderer.insertionPoint();
  paste({ target: imageCanvas, clipboardData, preventDefault: () => { pastePrevented = true; } });
  await imageView.importQueue;
  assert.equal(pastePrevented, true);
  assert.equal(imageView.editor.snapshot().length, 2);
  const pasted = imageView.editor.snapshot()[1];
  assert.equal(pasted.item[4], center.x);
  assert.equal(pasted.item[5], center.y);
  assert.equal(imageView.editor.selectedId, pasted.id);
  assert.ok(pasted.z > imageBytes.z);
  const position = { x: 100, y: 120 };
  const expectedPosition = imageView.renderer.insertionPoint(position);
  let dropPrevented = false, dropStopped = false;
  drop({ clientX: position.x, clientY: position.y, dataTransfer: { files: [pngFile] },
    preventDefault: () => { dropPrevented = true; }, stopPropagation: () => { dropStopped = true; } });
  await imageView.importQueue;
  assert.equal(dropPrevented && dropStopped, true, "OS drops stay inside the PUR view");
  const dropped = imageView.editor.snapshot()[2];
  assert.equal(dropped.item[4], expectedPosition.x);
  assert.equal(dropped.item[5], expectedPosition.y);
  assert.equal(imageView.editor.snapshot().length, 3);
  const vaultPng = new FakeTFile("assets/added.png");
  const vaultJpeg = new FakeTFile("assets/added.jpg");
  new FakeTFile("assets/unsupported.txt");
  liveFiles.set(vaultPng.path, Uint8Array.from(png).buffer);
  openPurMenu(imageView);
  titledActions.get("保管庫から画像を追加")!();
  assert.ok(imagePicker);
  assert.ok(imagePicker.getItems().includes(vaultPng) && imagePicker.getItems().includes(vaultJpeg));
  assert.equal(imagePicker.getItems().some(file => file.extension === "txt"), false);
  imagePicker.onChooseItem(vaultPng);
  await imageView.importQueue;
  assert.equal(imageView.editor.snapshot().length, 4);
  const imageKeys = canvasHandlers.get(imageCanvas)!.get("keydown")!;
  let deletePrevented = false;
  imageKeys({ target: imageCanvas, key: "Delete", preventDefault: () => { deletePrevented = true; } });
  assert.equal(deletePrevented, true);
  assert.equal(imageView.editor.snapshot().length, 3);
  imageView.editor.undo();
  openPurMenu(imageView);
  titledActions.get("選択した画像を削除")!();
  assert.equal(imageView.editor.snapshot().length, 3);
  imageView.editor.undo();
  imageKeys({ target: imageCanvas, key: "Backspace", preventDefault() {} });
  assert.equal(imageView.editor.snapshot().length, 3);
  imageView.editor.undo();
  imageKeys({ target: imageCanvas, key: "v", ctrlKey: true, preventDefault: () => assert.fail("native Ctrl+V was blocked") });
  openPurMenu(imageView);
  titledActions.get("閲覧モードへ")!();
  paste({ target: imageCanvas, clipboardData, preventDefault: () => assert.fail("read-only paste was intercepted") });
  imageKeys({ target: imageCanvas, key: "Delete", preventDefault: () => assert.fail("read-only Delete was intercepted") });
  assert.equal(imageView.editor.snapshot().length, 4);
  openPurMenu(imageView);
  titledActions.get("編集モードへ")!();
  const invalidFile = { size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
  drop({ clientX: 0, clientY: 0, dataTransfer: { files: [invalidFile] }, preventDefault() {}, stopPropagation() {} });
  await imageView.importQueue;
  assert.equal(imageView.editor.snapshot().length, 4);
  assert.ok(notices.some(message => message.includes("対応する画像はPNG、JPEG、GIF、WebP、BMP")));
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(imageView.editor.dirty, false, "image addition participates in idle autosave");
  assert.equal((await parsePur(new Uint8Array(liveFiles.get("boards/images.pur")!))).images.length, 4);
  imageView.editor.select(pasted.id);
  imageKeys({ target: imageCanvas, key: "Delete", preventDefault() {} });
  await imageView.savePurCurrent();
  assert.equal(imageView.editor.dirty, false);
  const deletedOutput = new Uint8Array(liveFiles.get("boards/images.pur")!);
  assert.equal((await parsePur(deletedOutput)).images.length, 3);
  imageView.editor.undo();
  await imageView.savePurCurrent();
  assert.equal((await parsePur(new Uint8Array(liveFiles.get("boards/images.pur")!))).images.length, 4,
    "Undo after saving a deletion recreates its image rows");
  imageView.editor.select(dropped.id);
  imageKeys({ target: imageCanvas, key: "Delete", preventDefault() {} });
  backupHook = async () => { imageView.editor.undo(); };
  await imageView.savePurCurrent();
  backupHook = undefined;
  assert.equal(imageView.editor.dirty, true, "Undo during a deletion save remains dirty against its new baseline");
  const concurrentDeletion = new Uint8Array(liveFiles.get("boards/images.pur")!);
  assert.equal((await parsePur(concurrentDeletion)).images.length, 3);
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(imageView.editor.dirty, false, "concurrent membership edits resume idle autosave");
  assert.equal((await parsePur(new Uint8Array(liveFiles.get("boards/images.pur")!))).images.length, 4);
  const managedImages = (savedSettings?.backups ?? []) as Array<{ source: string; path: string }>;
  const imageBackups = managedImages.filter(record => record.source === "boards/images.pur");
  assert.equal(imageBackups.length, 1, "image edits retain exactly one managed backup generation");
  assert.deepEqual(new Uint8Array(savedFiles.get(imageBackups[0].path)!), concurrentDeletion,
    "the remaining recovery copy contains the immediately preceding deletion");
  const alignments = [
    ["左端揃え", (b: ReturnType<typeof transformedBounds>) => b.x],
    ["右端揃え", (b: ReturnType<typeof transformedBounds>) => b.x + b.width],
    ["上端揃え", (b: ReturnType<typeof transformedBounds>) => b.y],
    ["下端揃え", (b: ReturnType<typeof transformedBounds>) => b.y + b.height],
    ["水平中央揃え", (b: ReturnType<typeof transformedBounds>) => b.x + b.width / 2],
    ["垂直中央揃え", (b: ReturnType<typeof transformedBounds>) => b.y + b.height / 2],
  ] as const;
  for (const id of [undefined, pasted.id]) {
    imageView.editor.select(id);
    openPurMenu(imageView);
    for (const [title] of alignments) assert.equal(menuDisabled.get(title), true);
  }
  imageView.editor.setItem(pasted.id, [0, 3, -2, 0, 100, -200]);
  imageView.editor.commit(pasted.id, pasted.item);
  imageView.editor.setItem(dropped.id, [0.5, 0.3, 0.2, 1, -100, 80]);
  imageView.editor.commit(dropped.id, dropped.item);
  imageView.editor.select(pasted.id);
  imageView.editor.toggleSelection(dropped.id);
  const groupBefore = imageView.editor.snapshot();
  const selectedBounds = transformedBounds(groupBefore.filter(entry =>
    entry.id === pasted.id || entry.id === dropped.id).map(entry => entry.content));
  openPurMenu(imageView);
  assert.equal(menuDisabled.get("90°時計回りに回転"), false, "group rotation is available");
  assert.equal(menuDisabled.get("左右反転"), true, "group reflection is not part of this release");
  assert.equal(menuDisabled.get("選択した画像を削除"), false);
  for (const [title, coordinate] of alignments) {
    openPurMenu(imageView);
    assert.equal(menuDisabled.get(title), false);
    titledActions.get(title)!();
    const aligned = imageView.editor.snapshot();
    for (const entry of aligned) {
      if (entry.id === pasted.id || entry.id === dropped.id) {
        assert.ok(Math.abs(coordinate(transformedBounds([entry.content])) - coordinate(selectedBounds)) < 1e-8,
          `${title} uses the current transformed image bounds`);
      } else assert.deepEqual(entry, groupBefore.find(before => before.id === entry.id));
    }
    await imageView.savePurCurrent();
    const reopened = await parsePur(new Uint8Array(liveFiles.get("boards/images.pur")!));
    for (const expected of aligned) {
      const actual = reopened.images.find(image => image.id === expected.id)!;
      assert.deepEqual(actual.item, Array.from(expected.item), `${title} survives save and reparse`);
      assert.deepEqual(actual.data, Uint8Array.from(expected.content.data));
    }
    imageView.editor.undo();
    assert.deepEqual(imageView.editor.snapshot(), groupBefore, `${title} undoes the entire group`);
    imageView.editor.redo();
    assert.deepEqual(imageView.editor.snapshot(), aligned, `${title} redoes the entire group`);
    imageView.editor.undo();
    assert.equal(imageView.editor.selectedImages.length, 2);
  }
  imageKeys({ target: imageCanvas, key: "Delete", preventDefault() {} });
  assert.equal(imageView.editor.snapshot().length, groupBefore.length - 2, "Delete removes the entire selection");
  imageKeys({ target: imageCanvas, key: "z", ctrlKey: true, preventDefault() {} });
  assert.deepEqual(imageView.editor.snapshot(), groupBefore, "Ctrl+Z restores all selected images in one step");
  assert.equal(imageView.editor.selectedImages.length, 2);
  imageKeys({ target: imageCanvas, key: "z", metaKey: true, shiftKey: true, preventDefault() {} });
  assert.equal(imageView.editor.snapshot().length, groupBefore.length - 2, "Cmd+Shift+Z redoes the whole deletion");
  imageKeys({ target: imageCanvas, key: "z", metaKey: true, preventDefault() {} });
  const keysBefore = imageView.editor.snapshot();
  for (const target of [plainInput, new ElementStub()]) {
    for (const key of ["Delete", "Backspace", "Escape", "z"]) {
      imageKeys({ target, key, ctrlKey: key === "z", preventDefault: () => assert.fail("foreign key intercepted") });
    }
  }
  assert.deepEqual(imageView.editor.snapshot(), keysBefore);
  openPurMenu(imageView);
  titledActions.get("閲覧モードへ")!();
  openPurMenu(imageView);
  for (const [title] of alignments) assert.equal(menuDisabled.get(title), true);
  titledActions.get("編集モードへ")!();
  await imageView.savePurCurrent();
  const preAlignmentFile = new Uint8Array(liveFiles.get("boards/images.pur")!).slice();
  openPurMenu(imageView);
  titledActions.get("右端揃え")!();
  const groupAfter = imageView.editor.snapshot();
  assert.equal(imageView.editor.dirty, true);
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(imageView.editor.dirty, false, "alignment participates in idle autosave");
  const alignedBoard = await parsePur(new Uint8Array(liveFiles.get("boards/images.pur")!));
  for (const expected of groupAfter) {
    const actual = alignedBoard.images.find(image => image.id === expected.id)!;
    assert.deepEqual(actual.item, Array.from(expected.item));
    assert.deepEqual(actual.data, Uint8Array.from(expected.content.data), "alignment never rewrites image bytes");
  }
  const alignmentBackups = (savedSettings?.backups as Array<{ source: string; path: string }>)
    .filter(record => record.source === "boards/images.pur");
  assert.equal(alignmentBackups.length, 1);
  assert.deepEqual(new Uint8Array(savedFiles.get(alignmentBackups[0].path)!), preAlignmentFile);
  imageView.editor.undo();
  assert.deepEqual(imageView.editor.snapshot(), groupBefore);
  await imageView.savePurCurrent();
  const undoneBoard = await parsePur(new Uint8Array(liveFiles.get("boards/images.pur")!));
  for (const expected of groupBefore)
    assert.deepEqual(undoneBoard.images.find(image => image.id === expected.id)!.item, Array.from(expected.item));
  const groupEntries = () => imageView.editor.snapshot().filter(entry =>
    entry.id === pasted.id || entry.id === dropped.id).map(entry => entry.content);
  const sendGroupPointer = (type: string, point: { x: number; y: number }, shiftKey = false) => {
    const camera = imageView.renderer.camera;
    canvasHandlers.get(imageCanvas)!.get(type)!({ type, target: imageCanvas, pointerId: 1,
      pointerType: "mouse", button: 0, shiftKey,
      clientX: point.x * camera.scale + camera.x, clientY: point.y * camera.scale + camera.y,
      preventDefault() {} });
  };
  const selectionBounds = transformedBounds(groupEntries());
  sendGroupPointer("pointerdown", { x: selectionBounds.x - 100, y: selectionBounds.y - 100 }, true);
  sendGroupPointer("pointermove", {
    x: selectionBounds.x + selectionBounds.width + 100, y: selectionBounds.y + selectionBounds.height + 100,
  }, true);
  sendGroupPointer("pointerup", {
    x: selectionBounds.x + selectionBounds.width + 100, y: selectionBounds.y + selectionBounds.height + 100,
  }, true);
  assert.ok(imageView.editor.selectedImages.length >= 2, "Shift blank drag selects intersecting images");
  imageView.editor.select(pasted.id);
  imageView.editor.toggleSelection(dropped.id);
  for (const operation of ["resize", "rotate"] as const) {
    const before = imageView.editor.snapshot(), frame = selectionFrame(groupEntries())!;
    const previousFile = new Uint8Array(liveFiles.get("boards/images.pur")!).slice();
    const center = imageCenter(frame);
    const start = operation === "resize" ? imageHandles(frame)[4]
      : rotationHandles(frame, 20 / imageView.renderer.camera.scale)[0];
    const end = operation === "resize"
      ? { x: start.x + frame.width / 2, y: start.y + frame.height / 2 }
      : { x: center.x - (start.y - center.y), y: center.y + (start.x - center.x) };
    sendGroupPointer("pointerdown", start);
    sendGroupPointer("pointermove", end);
    sendGroupPointer("pointerup", end);
    const after = imageView.editor.snapshot();
    assert.notDeepEqual(after, before, `group ${operation} changes placements`);
    imageView.editor.undo();
    assert.deepEqual(imageView.editor.snapshot(), before, `group ${operation} undoes in one step`);
    imageView.editor.redo();
    assert.deepEqual(imageView.editor.snapshot(), after);
    await new Promise(resolve => setTimeout(resolve, 3200));
    assert.equal(imageView.editor.dirty, false, `group ${operation} participates in autosave`);
    const recovery: Array<{ source: string; path: string }> = (savedSettings?.backups as Array<{ source: string; path: string }>)
      .filter(record => record.source === "boards/images.pur");
    assert.equal(recovery.length, 1, "group transforms retain one previous backup generation");
    assert.deepEqual(new Uint8Array(savedFiles.get(recovery[0].path)!), previousFile);
    const reopened = await parsePur(new Uint8Array(liveFiles.get("boards/images.pur")!));
    for (const expected of after) {
      const actual = reopened.images.find(image => image.id === expected.id)!;
      assert.deepEqual(actual.item, Array.from(expected.item));
      assert.deepEqual(actual.data, Uint8Array.from(expected.content.data));
      assert.deepEqual(actual.image, Array.from(expected.content.image));
    }
    imageView.editor.undo();
    await imageView.savePurCurrent();
    const restored = await parsePur(new Uint8Array(liveFiles.get("boards/images.pur")!));
    for (const expected of before)
      assert.deepEqual(restored.images.find(image => image.id === expected.id)!.item, Array.from(expected.item));
  }
  for (const [extension, data] of [
    ["gif", gifFixture(true)], ["webp", animatedWebp([])], ["bmp", bmpFixture(true)], ["svg", svgFixture],
    ["heic", heicFixture],
  ] as const) {
    const file = { size: data.length, arrayBuffer: async () => Uint8Array.from(data).buffer };
    const beforeCount = imageView.editor.snapshot().length;
    paste({ target: imageCanvas, clipboardData: { items: [{ kind: "file", getAsFile: () => file }] },
      preventDefault() {} });
    await imageView.importQueue;
    assert.equal(imageView.editor.snapshot().length, beforeCount + 1, `${extension}: clipboard adds image`);
    drop({ clientX: 20, clientY: 30, dataTransfer: { files: [file] }, preventDefault() {}, stopPropagation() {} });
    await imageView.importQueue;
    const vaultImage = new FakeTFile(`assets/new.${extension}`);
    liveFiles.set(vaultImage.path, Uint8Array.from(data).buffer);
    openPurMenu(imageView);
    titledActions.get("保管庫から画像を追加")!();
    assert.ok(imagePicker!.getItems().includes(vaultImage));
    imagePicker!.onChooseItem(vaultImage);
    await imageView.importQueue;
    assert.equal(imageView.editor.snapshot().length, beforeCount + 3, `${extension}: all three import paths work`);
    imageView.editor.undo(); imageView.editor.redo();
    if (extension === "gif" || extension === "heic") {
      await new Promise(resolve => setTimeout(resolve, 3200));
      assert.equal(imageView.editor.dirty, false, `${extension}: unmodified import participates in idle autosave`);
    } else await imageView.savePurCurrent();
    const reopened = await parsePur(new Uint8Array(liveFiles.get("boards/images.pur")!));
    const newImages = reopened.images.slice(-3);
    assert.ok(newImages.every(image => image.mime === (extension === "svg" ? "image/svg+xml" : `image/${extension}`) &&
      image.width === (extension === "heic" ? 1280 : 3) && image.height === (extension === "heic" ? 854 : 2)),
      `${extension}: original format saves and reopens on all import paths`);
    for (const image of newImages)
      assert.deepEqual(image.data, data, `${extension}: every import path preserves every received byte`);
    assert.equal(imageView.editor.dirty, false);
  }
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svgFixture).toString("base64")}`;
  paste({ target: plainInput, clipboardData: { items: [], getData: () => dataUrl },
    preventDefault: () => assert.fail("SVG URL input paste was intercepted") });
  const beforeSvg = imageView.editor.snapshot().length;
  let svgPastePrevented = false;
  paste({ target: imageCanvas, clipboardData: { items: [], getData: () => dataUrl },
    preventDefault() { svgPastePrevented = true; } });
  await imageView.importQueue;
  assert.equal(svgPastePrevented, true);
  assert.equal(imageView.editor.snapshot().length, beforeSvg + 1);
  await imageView.savePurCurrent();
  const svgReopened = await parsePur(new Uint8Array(liveFiles.get("boards/images.pur")!));
  assert.deepEqual(svgReopened.images[svgReopened.images.length - 1].data, svgFixture);
  paste({ target: imageCanvas, clipboardData: { items: [], getData: () => "data:image/svg+xml;base64,@@@" },
    preventDefault() {} });
  await imageView.importQueue;
  assert.equal(imageView.editor.snapshot().length, beforeSvg + 1);
  assert.ok(notices.some(message => message.includes("Base64")));
  await imageView.onClose();
  const reopenedView = createView({}) as typeof imageView;
  await reopenedView.onOpen();
  const savedImageFile = identities.get("boards/images.pur")!;
  const savedImageBytes = liveFiles.get(savedImageFile.path)!;
  const expectedImages = (await parsePur(new Uint8Array(savedImageBytes))).images;
  const errorsBeforeReload = loggedErrors.length;
  await reopenedView.onLoadFile(savedImageFile);
  assert.equal(loggedErrors.length, errorsBeforeReload, "shipped plugin reloads HEIC-containing PUR without errors");
  assert.equal(reopenedView.editor.snapshot().length, expectedImages.length);
  const reloadedHeic = reopenedView.editor.snapshot().map(image => image.content)
    .filter(image => image.mime === "image/heic");
  assert.equal(reloadedHeic.length, 3, "existing PUR load includes all HEIC images");
  for (const image of reloadedHeic) assert.deepEqual(Uint8Array.from(image.data), heicFixture);
  diagnosticsCommand.callback!();
  assert.match(diagnosticOutputs[diagnosticOutputs.length - 1]!.value, /frame drawn/);
  assert.equal(liveFiles.get(savedImageFile.path), savedImageBytes, "opening PUR does not rewrite its bytes");
  await reopenedView.onClose();
  const groupedView = createView({});
  const groupedFile = new FakeTFile("boards/groups.pur");
  const groupedFixture = await groupFixture(), mixedDb = new SQL.Database(extractDatabase(groupedFixture));
  let groupedOriginal: Uint8Array;
  try {
    mixedDb.run(`INSERT INTO items(id,parent,z) VALUES(200,-1,15),(201,-1,25);
      INSERT INTO items_notes(id,text) VALUES(200,'preserve');
      INSERT INTO items_drawings(id) VALUES(201)`);
    groupedOriginal = wrapDatabase(groupedFixture, mixedDb.export());
  } finally { mixedDb.close(); }
  liveFiles.set(groupedFile.path, Uint8Array.from(groupedOriginal).buffer);
  await groupedView.onOpen();
  await groupedView.setState({ file: groupedFile.path });
  activeView = groupedView;
  assert.equal(groupedView.editor.snapshot().length, 7, "shipped plugin models images and group backgrounds");
  const groupedCanvas = groupedView.contentEl.children[3];
  const groupedPointer = (type: string, point: { x: number; y: number }, modifiers = {}) => {
    const camera = groupedView.renderer.camera;
    canvasHandlers.get(groupedCanvas)!.get(type)!({ type, target: groupedCanvas, pointerId: 1,
      pointerType: "mouse", button: 0, ...modifiers,
      clientX: point.x * camera.scale + camera.x, clientY: point.y * camera.scale + camera.y,
      preventDefault() {} });
  };
  const nestedImage = groupedView.editor.snapshot().find(entry => entry.id === 2)!;
  const nestedCenter = imageCenter(nestedImage.content);
  groupedView.editor.select(100);
  openPurMenu(groupedView);
  assert.equal(menuDisabled.get("グループの内部を編集"), false);
  titledActions.get("グループの内部を編集")!();
  assert.equal(groupedView.editor.editingParent, 100);
  groupedView.editor.select(110);
  openPurMenu(groupedView);
  titledActions.get("グループの内部を編集")!();
  assert.equal(groupedView.editor.editingParent, 110);
  groupedPointer("pointerdown", nestedCenter, { ctrlKey: true });
  groupedPointer("pointerup", nestedCenter, { ctrlKey: true });
  assert.equal(groupedView.editor.selectedId, 2, "nested image is directly hit-testable in world coordinates");
  const initialGroup = groupedView.editor.snapshot();
  groupedPointer("pointerdown", nestedCenter);
  const movedCenter = { x: nestedCenter.x + 45, y: nestedCenter.y - 23 };
  groupedPointer("pointermove", movedCenter);
  groupedPointer("pointerup", movedCenter);
  const movedGroup = groupedView.editor.snapshot();
  const movedNested = movedGroup.find(entry => entry.id === 2)!;
  assert.ok(Math.abs(movedNested.item[4] - nestedImage.item[4] - 45) < 1e-8);
  assert.ok(Math.abs(movedNested.item[5] - nestedImage.item[5] + 23) < 1e-8);
  for (const entry of movedGroup.filter(entry => entry.id !== 2 && !entry.content.group))
    assert.deepEqual(entry, initialGroup.find(before => before.id === entry.id));
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(groupedView.editor.dirty, false, "nested image movement uses idle autosave");
  const groupedSaved = await parsePur(new Uint8Array(liveFiles.get(groupedFile.path)!));
  for (const expected of movedGroup) {
    const actual = [...groupedSaved.images, ...groupedSaved.groups ?? []].find(image => image.id === expected.id)!;
    actual.item.forEach((value, i) => assert.ok(Math.abs(value - expected.item[i]) < 1e-8));
    assert.equal(actual.parent?.id, expected.content.parent?.id);
    assert.deepEqual(actual.data, Uint8Array.from(expected.content.data));
  }
  const groupBackups = (savedSettings?.backups as Array<{ source: string; path: string }>)
    .filter(record => record.source === groupedFile.path);
  assert.equal(groupBackups.length, 1);
  assert.deepEqual(new Uint8Array(savedFiles.get(groupBackups[0].path)!), groupedOriginal);
  groupedView.editor.undo();
  assert.deepEqual(groupedView.editor.snapshot(), initialGroup, "nested world movement undoes as one operation");
  groupedView.editor.redo();
  assert.deepEqual(groupedView.editor.snapshot(), movedGroup);
  openPurMenu(groupedView);
  titledActions.get("親の階層へ戻る")!();
  openPurMenu(groupedView);
  titledActions.get("親の階層へ戻る")!();
  assert.equal(groupedView.editor.editingParent, -1, "tablet menu returns through nested parents");
  groupedView.editor.select(100);
  groupedView.editor.toggleSelection(3);
  openPurMenu(groupedView);
  assert.equal(menuDisabled.get("右端揃え"), false);
  titledActions.get("右端揃え")!();
  await groupedView.savePurCurrent();
  const alignedGroups = await parsePur(new Uint8Array(liveFiles.get(groupedFile.path)!));
  const bounds = [...alignedGroups.images, ...alignedGroups.groups ?? []]
    .filter(image => [100, 3].includes(image.id)).map(image => transformedBounds([image]));
  assert.ok(bounds.every(bound => Math.abs(bound.x + bound.width - bounds[0].x - bounds[0].width) < 1e-8),
    "alignment works on a group and a root image without flattening");
  groupedView.renderer.editGroup(100);
  groupedView.renderer.editGroup(110);
  groupedView.editor.select(2);
  openPurMenu(groupedView);
  titledActions.get("選択した画像を削除")!();
  await groupedView.savePurCurrent();
  assert.equal((await parsePur(new Uint8Array(liveFiles.get(groupedFile.path)!))).images.some(image => image.id === 2), false);
  groupedView.editor.undo();
  await groupedView.savePurCurrent();
  assert.equal((await parsePur(new Uint8Array(liveFiles.get(groupedFile.path)!))).images.find(image => image.id === 2)!.parent!.id, 110,
    "Undo after saving a deletion restores the exact nested parent");
  groupedView.renderer.parentGroup(); groupedView.renderer.parentGroup();
  groupedView.editor.selectIds([100, 3]);
  openPurMenu(groupedView);
  const beforeGroupErrors = loggedErrors.length;
  titledActions.get("選択項目をグループ化")!();
  assert.equal(loggedErrors.length, beforeGroupErrors, "unrelated notes and drawings do not trigger the global structure guard");
  const newGroupId = groupedView.editor.selectedId!;
  assert.ok(groupedView.editor.selected!.group);
  openPurMenu(groupedView);
  titledActions.get("グループ背景色を変更")!();
  const colorModalInput = inputs[inputs.length - 1];
  colorModalInput.value = "#123456";
  modalButtons.get("色を適用")!();
  await groupedView.savePurCurrent();
  assert.equal((await parsePur(new Uint8Array(liveFiles.get(groupedFile.path)!)))
    .groups!.find(image => image.id === newGroupId)!.group!.color, "#ff123456");
  const beforeMixed = new SQL.Database(extractDatabase(groupedOriginal));
  const afterMixed = new SQL.Database(extractDatabase(new Uint8Array(liveFiles.get(groupedFile.path)!)));
  try {
    for (const query of ["SELECT * FROM items WHERE id IN (200,201) ORDER BY id",
      "SELECT * FROM items_notes", "SELECT * FROM items_drawings"])
      assert.deepEqual(afterMixed.exec(query), beforeMixed.exec(query));
  } finally { beforeMixed.close(); afterMixed.close(); }
  openPurMenu(groupedView);
  titledActions.get("選択グループを解除")!();
  await groupedView.savePurCurrent();
  assert.equal((await parsePur(new Uint8Array(liveFiles.get(groupedFile.path)!)))
    .groups!.some(image => image.id === newGroupId), false);
  groupedView.renderer.undo();
  await groupedView.savePurCurrent();
  assert.equal((await parsePur(new Uint8Array(liveFiles.get(groupedFile.path)!)))
    .groups!.find(image => image.id === newGroupId)!.group!.color, "#ff123456");
  await groupedView.onClose();
  const menuView = createView({});
  const menuFile = new FakeTFile("boards/menu-imports.pur");
  liveFiles.set(menuFile.path, Uint8Array.from(fixture).buffer);
  await menuView.onOpen();
  await menuView.setState({ file: menuFile.path });
  const categories = ["画像の追加", "編集", "整列", "グループ", "表示", "保存"];
  const rootMenu = new MenuStub();
  menuView.onPaneMenu(rootMenu, "more-options");
  assert.deepEqual(rootMenu.items.map(item => item.title), categories,
    "pane menu has exactly six categories without exposing leaf actions");
  const expectedItems = [
    ["クリップボードから貼り付け", "ストレージから画像を読み込む", "保管庫から画像を追加"],
    ["元に戻す", "やり直す", "選択した画像を削除", "90°時計回りに回転", "90°反時計回りに回転", "左右反転", "上下反転"],
    ["左端揃え", "右端揃え", "上端揃え", "下端揃え", "水平中央揃え", "垂直中央揃え"],
    ["グループの内部を編集", "親の階層へ戻る", "選択項目をグループ化", "選択グループを解除", "グループ背景色を変更"],
    ["全体表示", "拡大", "縮小", "閲覧モードへ", "選択時に最前面へ移動", "ビューを閉じる"],
    ["保存（現在の .pur を上書き）", "別名 .pur 保存", "変更を破棄", "外部更新を再読込"],
  ];
  const beforeMenuNavigation = menuView.editor.snapshot();
  let prematureRead = false;
  ownerWindow.navigator.clipboard = { read: async () => { prematureRead = true; return []; } };
  for (const [index, item] of rootMenu.items.entries()) {
    item.callback!({ clientX: 25, clientY: 40, pointerType: "touch" });
    const child = shownMenus[shownMenus.length - 1];
    assert.deepEqual(child.items.map(entry => entry.title),
      ["PUR操作へ戻る", categories[index], ...expectedItems[index]]);
    assert.deepEqual({ ...child.position }, { x: 0, y: 0 }, "pane submenu uses its fixed view anchor");
    assert.equal(child.doc, menuView.contentEl.ownerDocument, "submenu uses the view's document");
    assert.equal(menuDisabled.get(categories[index]), true, "child heading is not an executable action");
    child.items[0].callback!({ key: "Enter" });
    const back = shownMenus[shownMenus.length - 1];
    assert.deepEqual(back.items.map(entry => entry.title), categories, "back restores only the root categories");
    assert.deepEqual({ ...back.position }, { x: 0, y: 0 }, "keyboard navigation anchors at the canvas");
  }
  assert.equal(prematureRead, false, "category navigation never reads the clipboard");
  assert.deepEqual(menuView.editor.snapshot(), beforeMenuNavigation, "navigation leaves selection and placement unchanged");
  ownerWindow.navigator.clipboard = undefined;
  headerActions.get("PUR操作（保存、元に戻す、全体表示）")!({ clientX: 25, clientY: 40 });
  assert.deepEqual(shownMenus[shownMenus.length - 1].items.map(item => item.title), categories,
    "header action uses the same categorized menu");
  const checkAnchor = (anchor: { x: number; y: number }) => {
    for (let i = 0; i < 3; i++) {
      const root = shownMenus[shownMenus.length - 1];
      assert.deepEqual({ ...root.position }, anchor);
      assert.equal(root.doc, menuView.contentEl.ownerDocument);
      root.items[0].callback!({ clientX: 400 + i * 50, clientY: 600 + i * 50, pointerType: "touch" });
      const child = shownMenus[shownMenus.length - 1];
      assert.deepEqual({ ...child.position }, anchor, "child keeps the opening anchor, not the tapped row");
      assert.equal(child.doc, root.doc);
      child.items[0].callback!(i === 0 ? { key: "Enter" } : { clientX: 800, clientY: 900 });
      const back = shownMenus[shownMenus.length - 1];
      assert.deepEqual({ ...back.position }, anchor, "back never accumulates coordinate drift");
      assert.equal(back.doc, root.doc);
    }
  };
  checkAnchor({ x: 25, y: 40 });
  menuView.runPurAction("menu");
  checkAnchor({ x: 12, y: 12 });
  const menuCanvas = menuView.contentEl.children[3];
  titledActions.delete("クリップボードから貼り付け");
  domHandlers.get(menuCanvas)!.get("contextmenu")!({ clientX: 0, clientY: 70, preventDefault() {} });
  assert.ok(!titledActions.has("クリップボードから貼り付け"), "imports are nested, not duplicated at root");
  checkAnchor({ x: 0, y: 70 });
  assert.deepEqual(shownMenus[shownMenus.length - 1].items.map(item => item.title), categories);
  titledActions.get("画像の追加")!({ clientX: 10, clientY: 20 });
  assert.ok(titledActions.has("クリップボードから貼り付け"), "right-click shares image import actions");
  titledActions.delete("ストレージから画像を読み込む");
  domHandlers.get(menuCanvas)!.get("pointerdown")!({
    pointerType: "touch", isPrimary: true, clientX: 10, clientY: 20,
  });
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.ok(!titledActions.has("ストレージから画像を読み込む"));
  checkAnchor({ x: 10, y: 20 });
  assert.deepEqual(shownMenus[shownMenus.length - 1].items.map(item => item.title), categories);
  titledActions.get("画像の追加")!({ clientX: 10, clientY: 20, pointerType: "touch" });
  assert.ok(titledActions.has("ストレージから画像を読み込む"), "tablet long press shares image import actions");
  domHandlers.get(menuCanvas)!.get("pointerup")!({});
  assert.equal(menuDisabled.get("クリップボードから貼り付け"), false);
  assert.equal(menuDisabled.get("ストレージから画像を読み込む"), false);
  const menuPaste = titledActions.get("クリップボードから貼り付け")!;
  const storage = titledActions.get("ストレージから画像を読み込む")!;
  const last = <T>(items: T[]): T => items[items.length - 1];
  await menuPaste();
  assert.ok(notices.some(message => message.includes("クリップボード読取APIを利用できません")));
  ownerWindow.navigator.clipboard = { read: async () => { throw new DOMException("denied", "NotAllowedError"); } };
  await menuPaste();
  assert.ok(notices.some(message => message.includes("クリップボードの読取を拒否")));
  ownerWindow.navigator.clipboard = { read: async () => [] };
  await menuPaste();
  assert.ok(notices.some(message => message.includes("対応画像またはSVGデータURLがありません")));
  for (const [mime, data] of [
    ["image/png", png],
    ["image/jpeg", new Uint8Array([255, 216, 255, 224, 0, 4, 0, 0,
      255, 192, 0, 11, 8, 0, 48, 0, 64, 1, 1, 17, 0])],
    ["image/gif", gifFixture(true)], ["image/webp", animatedWebp([])],
    ["image/bmp", bmpFixture(true)], ["image/svg+xml", svgFixture], ["image/heic", heicFixture],
  ] as const) {
    const beforeCount = menuView.editor.snapshot().length;
    const byteCopy = data.slice();
    let readStarted = false;
    ownerWindow.navigator.clipboard = { read: () => {
      readStarted = true;
      return Promise.resolve([{ types: mime === "image/png" ? [mime] : ["image/png", mime],
        getType: async type => {
          assert.equal(type, mime, "use offered original format instead of PNG alternative");
          return new Blob([Uint8Array.from(data)], { type });
        } }]);
    } };
    const clipboardAction = menuPaste();
    assert.equal(readStarted, true, "clipboard.read starts inside menu user gesture before awaiting queue");
    await clipboardAction;
    await menuView.importQueue;
    assert.equal(menuView.editor.snapshot().length, beforeCount + 1, `${mime}: menu clipboard adds image`);
    const added = last(menuView.editor.snapshot()).content;
    assert.deepEqual(Uint8Array.from(added.data), byteCopy);
    storage();
    const picker = last(inputs);
    assert.ok(picker.type === "file" && picker.multiple && picker.pickerOpened);
    assert.ok(picker.accept.includes(".heic") && picker.accept.includes(".svg"));
    picker.files = [{ size: data.length, arrayBuffer: async () => Uint8Array.from(data).buffer }];
    canvasHandlers.get(picker)!.get("change")!({});
    await menuView.importQueue;
    assert.ok(picker.removed);
    assert.equal(menuView.editor.snapshot().length, beforeCount + 2, `${mime}: OS picker adds image`);
    assert.deepEqual(Uint8Array.from(last(menuView.editor.snapshot()).content.data), byteCopy);
    menuView.editor.undo(); menuView.editor.redo();
  }
  ownerWindow.navigator.clipboard = { read: async () => [{
    types: ["text/plain"], getType: async () => new Blob([dataUrl], { type: "text/plain" }),
  }] };
  await menuPaste();
  await menuView.importQueue;
  assert.deepEqual(Uint8Array.from(last(menuView.editor.snapshot()).content.data), svgFixture);
  const menuCount = menuView.editor.snapshot().length;
  const oversizedClipboard = new Blob([]);
  Object.defineProperty(oversizedClipboard, "size", { value: 64 * 1024 * 1024 + 1 });
  oversizedClipboard.arrayBuffer = async () => assert.fail("oversized clipboard must not be read");
  for (const item of [
    { types: ["image/png"], getType: async () => { throw new Error("clipboard image data unavailable"); } },
    { types: ["image/png"], getType: async () => oversizedClipboard },
    { types: ["image/tiff"], getType: async () => assert.fail("unsupported clipboard image must not be read") },
  ]) {
    ownerWindow.navigator.clipboard = { read: async () => [item] };
    const errorsBeforePaste: number = loggedErrors.length;
    await menuPaste();
    await menuView.importQueue;
    assert.equal(menuView.editor.snapshot().length, menuCount);
    assert.equal(loggedErrors.length, errorsBeforePaste + 1, "clipboard item failure is reported instead of ignored");
  }
  systemPicker = () => { throw new DOMException("System picker requires a user gesture", "NotAllowedError"); };
  storage();
  assert.ok(last(inputs).removed);
  assert.ok(last(notices).includes("System picker requires a user gesture"));
  let showPickerCalled = false;
  systemPicker = () => { showPickerCalled = true; };
  storage();
  assert.ok(showPickerCalled, "system file selector is opened synchronously inside menu action");
  const multiPicker = last(inputs);
  multiPicker.files = [
    { size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer },
    { size: 64 * 1024 * 1024 + 1, arrayBuffer: async () => assert.fail("oversized file was read") },
    { size: png.length, arrayBuffer: async () => Uint8Array.from(png).buffer },
  ];
  canvasHandlers.get(multiPicker)!.get("change")!({});
  await menuView.importQueue;
  assert.equal(menuView.editor.snapshot().length, menuCount + 1,
    "valid files after failed entries still import through the system picker");
  menuView.editor.undo();
  assert.equal(menuView.editor.snapshot().length, menuCount);
  assert.ok(last(notices).includes("64 MiB"));
  systemPicker = undefined;
  storage();
  const canceledPicker = last(inputs);
  canvasHandlers.get(canceledPicker)!.get("cancel")!({});
  assert.ok(canceledPicker.removed);
  assert.equal(menuView.editor.snapshot().length, menuCount);
  storage();
  const oversizedPicker = last(inputs);
  oversizedPicker.files = [{ size: 64 * 1024 * 1024 + 1,
    arrayBuffer: async () => assert.fail("oversized file must be rejected before reading") }];
  canvasHandlers.get(oversizedPicker)!.get("change")!({});
  await menuView.importQueue;
  assert.ok(last(notices).includes("64 MiB"));
  assert.equal(menuView.editor.snapshot().length, menuCount);
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(menuView.editor.dirty, false, "menu imports participate in autosave");
  const menuSaved = await parsePur(new Uint8Array(liveFiles.get(menuFile.path)!));
  assert.equal(menuSaved.images.length, menuCount);
  for (const state of menuView.editor.snapshot()) {
    const saved = menuSaved.images.find(image => image.id === state.id)!;
    assert.deepEqual(saved.data, Uint8Array.from(state.content.data));
  }
  openPurMenu(menuView);
  titledActions.get("閲覧モードへ")!();
  openPurMenu(menuView);
  assert.equal(menuDisabled.get("クリップボードから貼り付け"), true);
  assert.equal(menuDisabled.get("ストレージから画像を読み込む"), true);
  ownerWindow.navigator.clipboard = { read: async () => assert.fail("read-only menu must not read clipboard") };
  await menuPaste();
  openPurMenu(menuView);
  titledActions.get("編集モードへ")!();
  let resolveClipboard: ((items: []) => void) | undefined;
  ownerWindow.navigator.clipboard = { read: () => new Promise(resolve => { resolveClipboard = resolve; }) };
  const pendingMenuPaste = menuPaste();
  storage();
  const pendingPicker = last(inputs);
  await menuView.onClose();
  assert.ok(pendingPicker.removed, "view close removes pending OS file picker");
  resolveClipboard!([]);
  await pendingMenuPaste;
  assert.ok(last(notices).includes("PURビューが変更されました"));
  ownerWindow.navigator.clipboard = undefined;
  for (const dispose of livePlugin.disposers) dispose();
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.isDesktopOnly, false);
});
