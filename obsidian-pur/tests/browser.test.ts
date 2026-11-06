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
  const menuActions: (() => void)[] = [];
  const titledActions = new Map<string, () => void>();
  const menuChecks = new Map<string, boolean>();
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
  const fixture = readFileSync(new URL("../../crates/purcore/tests/fixtures/S1_redbar-new.pur", import.meta.url));
  const heicFixture = new Uint8Array(readFileSync(new URL("./fixtures/example.heic", import.meta.url)));
  let closedBitmaps = 0;
  let pendingRead: Promise<ArrayBuffer> | undefined;
  const drawingContext = new Proxy({}, { get: () => () => {} });
  const ownerWindow = {
    devicePixelRatio: 1,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
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
    renderer: { insertionPoint(point?: { x: number; y: number }): { x: number; y: number } };
    onPaneMenu(menu: MenuStub, source: string): void;
    editor: {
      snapshot(): ImageEditState[];
      bringToFront(id: number): void;
      setItem(id: number, matrix: number[]): void;
      commit(id: number, before: number[]): void;
      undo(): void;
      redo(): void;
      discard(): void;
      select(id?: number): void;
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
      if (tag === "input") inputs.push(child);
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
    getBoundingClientRect() { return { left: 0, top: 0 }; }
    private child() {
      const element = new ElementStub();
      this.children.push(element);
      return element;
    }
  }
  class MenuStub {
    addItem(callback: (item: MenuItemStub) => void) {
      callback(new MenuItemStub());
      return this;
    }
    showAtMouseEvent() {}
    showAtPosition() {}
  }
  class MenuItemStub {
    title = "";
    setTitle(title: string) { this.title = title; return this; }
    setIcon(_icon: string) { return this; }
    setDisabled(_disabled: boolean) { return this; }
    setChecked(checked: boolean) { menuChecks.set(this.title, checked); return this; }
    onClick(callback: () => void) {
      menuActions.push(callback);
      titledActions.set(this.title, callback);
      return this;
    }
  }
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
    addAction() { return new ElementStub(); }
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
  assert.ok(diagnosticNotice.includes("ビルド: 0.12.0"));
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
  lifecycleView.onPaneMenu(new MenuStub(), "more-options");
  assert.ok(titledActions.has("選択時に最前面へ移動"));
  assert.equal(menuChecks.get("選択時に最前面へ移動"), true);
  titledActions.get("選択時に最前面へ移動")!();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(savedSettings?.frontOnSelect, false);
  lifecycleView.onPaneMenu(new MenuStub(), "more-options");
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
    lifecycleView.onPaneMenu(new MenuStub(), "more-options");
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
  imageView.onPaneMenu(new MenuStub(), "more-options");
  titledActions.get("保管庫から画像を追加")!();
  assert.ok(imagePicker);
  assert.ok(imagePicker.getItems().includes(vaultPng) && imagePicker.getItems().includes(vaultJpeg));
  assert.equal(imagePicker.getItems().some(file => file.extension === "txt"), false);
  imagePicker.onChooseItem(vaultPng);
  await imageView.importQueue;
  assert.equal(imageView.editor.snapshot().length, 4);
  const imageKeys = canvasHandlers.get(imageCanvas)!.get("keydown")!;
  let deletePrevented = false;
  imageKeys({ key: "Delete", preventDefault: () => { deletePrevented = true; } });
  assert.equal(deletePrevented, true);
  assert.equal(imageView.editor.snapshot().length, 3);
  imageView.editor.undo();
  imageView.onPaneMenu(new MenuStub(), "more-options");
  titledActions.get("選択した画像を削除")!();
  assert.equal(imageView.editor.snapshot().length, 3);
  imageView.editor.undo();
  imageKeys({ key: "Backspace", preventDefault() {} });
  assert.equal(imageView.editor.snapshot().length, 3);
  imageView.editor.undo();
  imageKeys({ key: "v", ctrlKey: true, preventDefault: () => assert.fail("native Ctrl+V was blocked") });
  imageView.onPaneMenu(new MenuStub(), "more-options");
  titledActions.get("閲覧モードへ")!();
  paste({ target: imageCanvas, clipboardData, preventDefault: () => assert.fail("read-only paste was intercepted") });
  imageKeys({ key: "Delete", preventDefault: () => assert.fail("read-only Delete was intercepted") });
  assert.equal(imageView.editor.snapshot().length, 4);
  imageView.onPaneMenu(new MenuStub(), "more-options");
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
  imageKeys({ key: "Delete", preventDefault() {} });
  await imageView.savePurCurrent();
  assert.equal(imageView.editor.dirty, false);
  const deletedOutput = new Uint8Array(liveFiles.get("boards/images.pur")!);
  assert.equal((await parsePur(deletedOutput)).images.length, 3);
  imageView.editor.undo();
  await imageView.savePurCurrent();
  assert.equal((await parsePur(new Uint8Array(liveFiles.get("boards/images.pur")!))).images.length, 4,
    "Undo after saving a deletion recreates its image rows");
  imageView.editor.select(dropped.id);
  imageKeys({ key: "Delete", preventDefault() {} });
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
    imageView.onPaneMenu(new MenuStub(), "more-options");
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
  for (const dispose of livePlugin.disposers) dispose();
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.isDesktopOnly, false);
});
