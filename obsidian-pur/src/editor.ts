import { Board, BoardImage, compareImageStack, transformedBounds, Matrix, invert, multiply, parentId, rememberLocal, updateHierarchy } from "./board";
import { check } from "./binary";

export interface ImageEditState {
  id: number;
  item: Matrix;
  z: number;
  content: BoardImage;
}

interface PlacementCommand {
  id: number;
  before: Matrix;
  after: Matrix;
  beforeZ: number;
  afterZ: number;
  beforeContent?: BoardImage;
  afterContent?: BoardImage;
}
type EditCommand = PlacementCommand | { kind: "add" | "remove"; images: BoardImage[] } |
  { kind: "batch"; commands: PlacementCommand[] } |
  { kind: "scene"; before: ImageEditState[]; after: ImageEditState[] };

export type Alignment = "left" | "right" | "top" | "bottom" | "horizontal-center" | "vertical-center";

function copy(matrix: Matrix): Matrix {
  return [...matrix];
}

function same(a: Matrix, b: Matrix): boolean {
  return a.every((value, index) => value === b[index]);
}
function clone(image: BoardImage): BoardImage {
  return { ...image, item: copy(image.item), image: copy(image.image),
    ...(image.localItem ? { localItem: copy(image.localItem) } : {}),
    ...(image.localItemWorld ? { localItemWorld: copy(image.localItemWorld) } : {}),
    ...(image.parent ? { parent: { ...image.parent, transform: copy(image.parent.transform),
      ancestors: image.parent.ancestors.map(ancestor => ({ ...ancestor })) } } : {}),
    ...(image.group ? { group: { ...image.group } } : {}) };
}
function replace(image: BoardImage, content: BoardImage): void {
  delete image.parent; delete image.group; delete image.localItem; delete image.localItemWorld;
  Object.assign(image, clone(content));
}

export class BoardEditor {
  private readonly selection = new Set<number>();
  get selectedImages(): BoardImage[] { return this.images.filter(image => this.selection.has(image.id)); }
  get selectedId(): number | undefined {
    return this.selection.size === 1 ? this.selection.values().next().value : undefined;
  }
  set selectedId(id: number | undefined) {
    this.selection.clear();
    if (id !== undefined) this.selection.add(id);
  }
  private readonly original = new Map<number, Matrix>();
  private readonly originalZ = new Map<number, number>();
  private readonly known = new Map<number, BoardImage>();
  private readonly tieOrder = new Map<number, number>();
  private nextId: number;
  private undoStack: EditCommand[] = [];
  private redoStack: EditCommand[] = [];
  private baseline: ImageEditState[] = [];
  private baselineById = new Map<number, BoardImage>();
  private pendingPlacement?: ImageEditState[];
  editingParent = -1;

  constructor(readonly images: BoardImage[], private readonly onChange: () => void = () => {},
    private readonly hiddenMaxZ = -Infinity, private readonly initialFrontId?: number, maxItemId = -1,
    groups: BoardImage[] = [], readonly structureIssue?: string,
    private readonly hiddenItems: NonNullable<Board["hiddenItems"]> = []) {
    images.push(...groups);
    this.nextId = Math.max(maxItemId, ...images.map(image => image.id)) + 1;
    images.forEach((image, index) => {
      this.known.set(image.id, image);
      this.original.set(image.id, copy(image.item));
      this.originalZ.set(image.id, image.z);
      this.tieOrder.set(image.id, index);
    });
    this.sortImages();
    this.baseline = this.snapshot();
    this.baselineById = new Map(this.baseline.map(state => [state.id, state.content]));
  }

  get dirty(): boolean {
    return this.images.length !== this.original.size ||
      this.images.some(image => !this.original.has(image.id) || !same(image.item, this.original.get(image.id)!) ||
      image.z !== this.originalZ.get(image.id) ||
      parentId(image) !== parentId(this.baselineById.get(image.id)!) ||
      image.group?.color !== this.baselineById.get(image.id)!.group?.color);
  }
  get deletedIds(): number[] {
    const present = new Set(this.images.map(image => image.id));
    return [...this.original.keys()].filter(id => !present.has(id));
  }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  snapshot(): ImageEditState[] {
    return this.images.map(image => ({
      id: image.id, item: copy(image.item), z: image.z,
      content: clone(image),
    }));
  }
  acceptSaved(placements: ImageEditState[]): void {
    this.original.clear();
    this.originalZ.clear();
    for (const placement of placements) {
      this.original.set(placement.id, copy(placement.item));
      this.originalZ.set(placement.id, placement.z);
    }
    this.baseline = placements.map(state => ({ ...state, item: copy(state.item), content: clone(state.content) }));
    this.baselineById = new Map(this.baseline.map(state => [state.id, state.content]));
    this.onChange();
  }
  get selected(): BoardImage | undefined {
    return this.images.find(image => image.id === this.selectedId);
  }
  select(id?: number): void {
    if (this.selectedId === id && (id !== undefined || !this.selection.size)) return;
    this.selectedId = id;
    this.onChange();
  }
  isSelected(id: number): boolean { return this.selection.has(id); }
  toggleSelection(id: number): void {
    if (!this.images.some(image => image.id === id)) return;
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.onChange();
  }
  selectIds(ids: number[]): void {
    const present = new Set(this.images.map(image => image.id));
    this.selection.clear();
    for (const id of ids) if (present.has(id)) this.selection.add(id);
    this.onChange();
  }
  get scopeItems(): BoardImage[] { return this.images.filter(image => parentId(image) === this.editingParent); }
  enterGroup(id: number): void {
    const image = this.images.find(image => image.id === id);
    check(image?.group && parentId(image) === this.editingParent, "この階層のグループを選択してください");
    check(!image.group.unsupported, image.group.unsupported ?? "");
    this.editingParent = id;
    this.select();
  }
  leaveGroup(): void {
    const group = this.images.find(image => image.id === this.editingParent);
    this.editingParent = group ? parentId(group) : -1;
    this.select(group?.id);
  }
  private assertEditable(images: BoardImage[]): void {
    for (const image of images) if (image.group?.unsupported) throw new Error(image.group.unsupported);
  }
  commitItems(before: { id: number; item: Matrix }[]): void {
    const pending = this.pendingPlacement;
    this.pendingPlacement = undefined;
    if (pending) before = pending;
    const commands: PlacementCommand[] = [];
    const images = new Map(this.images.map(image => [image.id, image]));
    const beforeContents = new Map(pending?.map(state => [state.id, state.content]));
    for (const state of before) {
      const image = images.get(state.id);
      if (image && same(image.item, state.item)) {
        const content = beforeContents.get(image.id);
        if (content) {
          delete image.localItem; delete image.localItemWorld;
          if (content.localItem) image.localItem = copy(content.localItem);
          if (content.localItemWorld) image.localItemWorld = copy(content.localItemWorld);
        }
      } else if (image)
        commands.push({ id: image.id, before: copy(state.item), after: copy(image.item),
          beforeZ: image.z, afterZ: image.z,
          beforeContent: beforeContents.get(image.id),
          afterContent: clone(image) });
    }
    if (!commands.length) return;
    this.undoStack.push({ kind: "batch", commands });
    this.redoStack = [];
    this.onChange();
  }
  alignSelected(alignment: Alignment): void {
    const images = this.selectedImages;
    if (images.length < 2) return;
    this.assertEditable(images);
    const bounds = transformedBounds(images);
    const before = images.map(image => ({ id: image.id, item: copy(image.item) }));
    const after = images.map(image => {
      const current = transformedBounds([image]);
      const item = copy(image.item);
      if (alignment === "left") item[4] += bounds.x - current.x;
      else if (alignment === "right") item[4] += bounds.x + bounds.width - current.x - current.width;
      else if (alignment === "top") item[5] += bounds.y - current.y;
      else if (alignment === "bottom") item[5] += bounds.y + bounds.height - current.y - current.height;
      else if (alignment === "horizontal-center") item[4] += bounds.x + bounds.width / 2 - current.x - current.width / 2;
      else item[5] += bounds.y + bounds.height / 2 - current.y - current.height / 2;
      check(item.every(Number.isFinite), "整列後の画像座標が対応範囲を超えています");
      return item;
    });
    this.setItems(images.map((image, index) => ({ id: image.id, item: after[index] })));
    this.commitItems(before);
  }
  add(content: Omit<BoardImage, "id" | "z">): BoardImage {
    this.editingParent = -1;
    check(Number.isSafeInteger(this.nextId), "画像項目IDが整数の上限に達しています");
    const image: BoardImage = { ...content, stored: undefined, parent: undefined, group: undefined,
      localItem: undefined, localItemWorld: undefined, stackOrder: undefined,
      id: this.nextId++, z: this.nextFrontZ() };
    rememberLocal(image);
    this.known.set(image.id, image);
    this.tieOrder.set(image.id, this.tieOrder.size);
    this.images.push(image);
    this.sortImages();
    this.undoStack.push({ kind: "add", images: [image] });
    this.redoStack = [];
    this.selectedId = image.id;
    this.onChange();
    return image;
  }
  removeSelected(): void {
    const images = this.selectedImages;
    if (!images.length) return;
    this.assertEditable(images);
    if (images.some(image => image.group)) {
      check(!this.structureIssue, this.structureIssue ?? "");
      const before = this.snapshot();
      const ids = new Set(images.map(image => image.id));
      for (const image of this.images)
        if (image.parent?.ancestors.some(parent => ids.has(parent.id))) ids.add(image.id);
      this.images.splice(0, this.images.length, ...this.images.filter(image => !ids.has(image.id)));
      this.recordScene(before);
      return;
    }
    for (const image of images) this.images.splice(this.images.indexOf(image), 1);
    if (this.images.some(image => image.group)) updateHierarchy(this.images);
    this.undoStack.push({ kind: "remove", images });
    this.redoStack = [];
    this.selectedId = undefined;
    this.onChange();
  }
  private nextFrontZ(target?: BoardImage): number {
    const hidden = target?.parent?.hiddenMaxZ ?? this.hiddenMaxZ;
    const max = this.images.filter(image => image.parent?.id === target?.parent?.id)
      .reduce((max, image) => Math.max(max, image.z), hidden);
    if (max === -Infinity) return 1;
    const z = max + Math.max(1, Math.abs(max) * Number.EPSILON * 2);
    check(Number.isFinite(z) && z > max, "重なり順が数値の上限に達したため最前面へ移動できません");
    return z;
  }
  bringToFront(id: number): void {
    const image = this.images.find(image => image.id === id);
    if (!image) return;
    this.assertEditable([image]);
    const hidden = image.parent?.hiddenMaxZ ?? this.hiddenMaxZ;
    const siblings = this.images.filter(sibling => sibling.parent?.id === image.parent?.id);
    if (siblings[siblings.length - 1] === image &&
      (image.z > hidden || image.z === hidden &&
        image.id === (image.parent?.frontmostId ?? this.initialFrontId))) return;
    const z = this.nextFrontZ(image);
    const beforeZ = image.z;
    image.z = z;
    this.undoStack.push({ id, before: copy(image.item), after: copy(image.item), beforeZ, afterZ: z });
    this.redoStack = [];
    if (this.images.some(image => image.group)) updateHierarchy(this.images);
    this.sortImages();
    this.onChange();
  }
  private sortImages(): void {
    this.images.sort((a, b) => compareImageStack(a, b, this.tieOrder.get(a.id)!, this.tieOrder.get(b.id)!));
  }
  setItem(id: number, matrix: Matrix): void {
    this.setItems([{ id, item: matrix }]);
  }
  setItems(states: { id: number; item: Matrix }[]): void {
    const matrices = new Map(states.map(state => [state.id, state.item]));
    this.assertEditable(this.images.filter(image => matrices.has(image.id)));
    this.pendingPlacement ??= this.snapshot();
    const baseline = new Map(this.pendingPlacement.map(state => [state.id, state.item]));
    const changedIds = new Set(this.images.filter(image => matrices.has(image.id) && !same(image.item, matrices.get(image.id)!))
      .map(image => image.id));
    const changes = this.images.filter(image => image.group && changedIds.has(image.id))
      .map(image => {
        const initial = baseline.get(image.id)!;
        const inverse = invert(initial);
        check(inverse, "グループの変換を逆変換できません");
        return { id: image.id, delta: same(initial, matrices.get(image.id)!) ? undefined : multiply(matrices.get(image.id)!, inverse) };
      });
    const changeMap = new Map(changes.map(change => [change.id, change.delta]));
    for (const image of this.images) {
      const matrix = matrices.get(image.id);
      if (matrix) image.item = copy(matrix);
      else {
        const ancestor = image.parent?.ancestors.find(ancestor => changeMap.has(ancestor.id));
        if (ancestor) {
          const delta = changeMap.get(ancestor.id);
          image.item = delta ? multiply(delta, baseline.get(image.id)!) : copy(baseline.get(image.id)!);
        }
      }
    }
    if (this.images.some(image => image.group)) updateHierarchy(this.images);
    for (const image of this.images) {
      if (changedIds.has(image.id)) rememberLocal(image);
      else if (image.parent?.ancestors.some(parent => changeMap.has(parent.id)))
        rememberLocal(image, Boolean(image.localItem));
    }
    this.onChange();
  }
  commit(id: number, before: Matrix): void {
    if (this.pendingPlacement) { this.commitItems(this.pendingPlacement); return; }
    const image = this.images.find(item => item.id === id);
    if (!image || same(image.item, before)) return;
    this.undoStack.push({ id, before: copy(before), after: copy(image.item), beforeZ: image.z, afterZ: image.z });
    this.redoStack = [];
    this.onChange();
  }
  transformItem(id: number, after: Matrix): void {
    const image = this.images.find(item => item.id === id);
    if (!image || same(image.item, after)) return;
    const before = copy(image.item);
    this.setItem(id, after);
    this.commit(id, before);
  }
  undo(): void {
    const command = this.undoStack.pop();
    if (!command) return;
    this.redoStack.push(command);
    this.applyCommand(command, false);
    this.sortImages();
    this.onChange();
  }
  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    this.undoStack.push(command);
    this.applyCommand(command, true);
    this.sortImages();
    this.onChange();
  }
  private applyCommand(command: EditCommand, forward: boolean): void {
    if ("kind" in command && command.kind === "scene") {
      this.restore(forward ? command.after : command.before);
      return;
    }
    if ("kind" in command && command.kind !== "batch") {
      const present = forward === (command.kind === "add");
      if (present) this.selection.clear();
      for (const image of command.images) this.applyMembership(image, present);
      if (this.images.some(image => image.group)) updateHierarchy(this.images);
      return;
    }
    const images = new Map(this.images.map(image => [image.id, image]));
    for (const placement of "kind" in command ? command.commands : [command]) {
      const image = images.get(placement.id)!;
      const content = forward ? placement.afterContent : placement.beforeContent;
      if (content) replace(image, content);
      image.z = forward ? placement.afterZ : placement.beforeZ;
      image.item = copy(forward ? placement.after : placement.before);
      if (!content && !same(image.localItemWorld ?? image.item, image.item)) rememberLocal(image);
    }
    if (this.images.some(image => image.group)) updateHierarchy(this.images);
  }
  discard(): void {
    this.restore(this.baseline);
    this.pendingPlacement = undefined;
    this.undoStack = [];
    this.redoStack = [];
    this.onChange();
  }
  private restore(states: ImageEditState[]): void {
    for (const state of states) {
      const image = this.known.get(state.id);
      if (image) { replace(image, state.content); image.item = copy(state.item); image.z = state.z; }
      else this.known.set(state.id, clone(state.content));
    }
    this.images.splice(0, this.images.length, ...states.map(state => this.known.get(state.id)!));
    if (this.editingParent !== -1 && !this.images.some(image => image.id === this.editingParent)) this.editingParent = -1;
    const hierarchical = this.images.some(image => image.group);
    const selectable = new Set(this.images.filter(image => !hierarchical || parentId(image) === this.editingParent)
      .map(image => image.id));
    for (const id of this.selection) if (!selectable.has(id)) this.selection.delete(id);
    if (this.images.some(image => image.group)) updateHierarchy(this.images);
    this.sortImages();
  }
  private recordScene(before: ImageEditState[]): void {
    if (this.images.some(image => image.group)) updateHierarchy(this.images);
    this.sortImages();
    this.undoStack.push({ kind: "scene", before, after: this.snapshot() });
    this.redoStack = [];
    this.pendingPlacement = undefined;
    this.select();
  }
  setGroupColor(color: string | null): void {
    const image = this.selected;
    check(image?.group, "グループを1つ選択してください");
    this.assertEditable([image]);
    check(color === null || /^#[\da-f]{8}$/i.test(color), "背景色の形式が不正です");
    if (image.group.color === color) return;
    const before = this.snapshot();
    image.group.color = color;
    this.recordScene(before);
    this.select(image.id);
  }
  groupSelected(): void {
    check(!this.structureIssue, this.structureIssue ?? "");
    const selected = this.selectedImages;
    check(selected.length >= 2 && selected.every(image => parentId(image) === this.editingParent),
      "同じ階層の項目を2つ以上選択してください");
    check(this.images.length + this.hiddenItems.length < 20000 && (selected[0].parent?.ancestors.length ?? 0) < 64,
      "階層項目数またはグループ深さの上限を超えるためグループ化できません");
    this.assertEditable(selected);
    const top = selected[selected.length - 1];
    const sortOrder = top.group?.sortOrder ?? (top.stored
      ? { value: top.stored.item.values.sort_order, text: top.stored.item.textColumns.includes("sort_order") }
      : undefined);
    const before = this.snapshot(), bounds = transformedBounds(selected);
    check(Number.isSafeInteger(this.nextId), "グループIDが整数の上限に達しています");
    const scale = Math.max(bounds.width, bounds.height, 1) / 200;
    const group: BoardImage = { id: this.nextId++, data: new Uint8Array(), mime: "application/x-pur-group",
      width: 20, height: 20, image: [1, 0, 0, 1, 0, 0],
      item: [scale, 0, 0, scale, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2],
      opacity: 1, z: top.z, stackOrder: top.stackOrder, group: { color: null, sortOrder },
      ...(selected[0].parent ? { parent: { ...selected[0].parent } } : {}) };
    this.known.set(group.id, group); this.tieOrder.set(group.id, this.tieOrder.size);
    this.images.push(group);
    for (const image of selected) image.parent = { id: group.id, transform: copy(group.item),
      ancestors: [], hiddenMaxZ: -Infinity };
    updateHierarchy(this.images);
    rememberLocal(group);
    for (const image of selected) rememberLocal(image);
    this.recordScene(before);
    this.select(group.id);
  }
  ungroupSelected(): void {
    check(!this.structureIssue, this.structureIssue ?? "");
    const group = this.selected;
    check(group?.group, "グループを1つ選択してください");
    this.assertEditable([group]);
    const before = this.snapshot();
    const siblings = this.scopeItems;
    const children = this.images.filter(image => parentId(image) === group.id);
    // Keep every unselected/hidden sibling's SQL cells and mutual order unchanged.
    const hiddenSiblings = this.hiddenItems.filter(item => item.parent === this.editingParent);
    const siblingZ = [...siblings.filter(image => image !== group).map(image => image.z),
      ...hiddenSiblings.map(item => item.z)];
    const normalize = !hiddenSiblings.length && siblingZ.includes(group.z);
    check(!children.length || normalize || !siblingZ.includes(group.z),
      "同じ重なり位置の別項目があるため安全にグループ解除できません。グループを最前面へ移動してから再試行してください");
    const lower = Math.max(-Infinity, ...siblingZ.filter(z => z < group.z));
    const upper = Math.min(Infinity, ...siblingZ.filter(z => z > group.z));
    const step = Math.max(1, Math.abs(group.z) * Number.EPSILON * (children.length + 2));
    const start = Number.isFinite(lower) ? lower : group.z - step;
    const end = Number.isFinite(upper) ? upper : group.z + step;
    const positions = children.map((_, i) => start + (end - start) * ((i + 1) / (children.length + 1)));
    check(normalize || positions.every((z, i) => Number.isFinite(z) && z > lower && z < upper &&
      (!i || z > positions[i - 1])), "重なり順の数値間隔が不足しているため安全にグループ解除できません");
    for (const child of children) {
      delete child.parent;
      if (group.parent) child.parent = { ...group.parent };
      rememberLocal(child);
    }
    if (normalize) {
      const index = siblings.indexOf(group);
      [...siblings.slice(0, index), ...children, ...siblings.slice(index + 1)]
        .forEach((image, i) => { image.z = i + 1; });
    } else children.forEach((image, i) => { image.z = positions[i]; });
    this.images.splice(this.images.indexOf(group), 1);
    this.recordScene(before);
    this.selectIds(children.map(image => image.id));
  }
  private applyMembership(image: BoardImage, present: boolean): void {
    if (present) {
      this.images.push(image);
      this.selection.add(image.id);
    } else {
      this.images.splice(this.images.indexOf(image), 1);
      this.selection.delete(image.id);
    }
  }
}
