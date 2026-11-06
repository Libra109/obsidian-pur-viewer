import { BoardImage, transformedBounds, Matrix } from "./board";
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
}
type EditCommand = PlacementCommand | { kind: "add" | "remove"; images: BoardImage[] } |
  { kind: "batch"; commands: PlacementCommand[] };

export type Alignment = "left" | "right" | "top" | "bottom" | "horizontal-center" | "vertical-center";

function copy(matrix: Matrix): Matrix {
  return [...matrix];
}

function same(a: Matrix, b: Matrix): boolean {
  return a.every((value, index) => value === b[index]);
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

  constructor(readonly images: BoardImage[], private readonly onChange: () => void = () => {},
    private readonly hiddenMaxZ = -Infinity, private readonly initialFrontId?: number, maxItemId = -1) {
    this.nextId = Math.max(maxItemId, ...images.map(image => image.id)) + 1;
    images.forEach((image, index) => {
      this.known.set(image.id, image);
      this.original.set(image.id, copy(image.item));
      this.originalZ.set(image.id, image.z);
      this.tieOrder.set(image.id, index);
    });
  }

  get dirty(): boolean {
    return this.images.length !== this.original.size ||
      this.images.some(image => !this.original.has(image.id) || !same(image.item, this.original.get(image.id)!) ||
      image.z !== this.originalZ.get(image.id));
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
      content: { ...image, item: copy(image.item), image: copy(image.image) },
    }));
  }
  acceptSaved(placements: ImageEditState[]): void {
    this.original.clear();
    this.originalZ.clear();
    for (const placement of placements) {
      this.original.set(placement.id, copy(placement.item));
      this.originalZ.set(placement.id, placement.z);
    }
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
  commitItems(before: { id: number; item: Matrix }[]): void {
    const commands: PlacementCommand[] = [];
    const images = new Map(this.images.map(image => [image.id, image]));
    for (const state of before) {
      const image = images.get(state.id);
      if (image && !same(image.item, state.item))
        commands.push({ id: image.id, before: copy(state.item), after: copy(image.item),
          beforeZ: image.z, afterZ: image.z });
    }
    if (!commands.length) return;
    this.undoStack.push({ kind: "batch", commands });
    this.redoStack = [];
    this.onChange();
  }
  alignSelected(alignment: Alignment): void {
    const images = this.selectedImages;
    if (images.length < 2) return;
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
    images.forEach((image, index) => { image.item = after[index]; });
    this.commitItems(before);
  }
  add(content: Omit<BoardImage, "id" | "z">): BoardImage {
    check(Number.isSafeInteger(this.nextId), "画像項目IDが整数の上限に達しています");
    const image: BoardImage = { ...content, stored: undefined, id: this.nextId++, z: this.nextFrontZ() };
    this.known.set(image.id, image);
    this.tieOrder.set(image.id, this.tieOrder.size);
    this.images.push(image);
    this.undoStack.push({ kind: "add", images: [image] });
    this.redoStack = [];
    this.selectedId = image.id;
    this.onChange();
    return image;
  }
  removeSelected(): void {
    const images = this.selectedImages;
    if (!images.length) return;
    for (const image of images) this.images.splice(this.images.indexOf(image), 1);
    this.undoStack.push({ kind: "remove", images });
    this.redoStack = [];
    this.selectedId = undefined;
    this.onChange();
  }
  private nextFrontZ(): number {
    const max = this.images.reduce((max, image) => Math.max(max, image.z), this.hiddenMaxZ);
    if (max === -Infinity) return 1;
    const z = max + Math.max(1, Math.abs(max) * Number.EPSILON * 2);
    check(Number.isFinite(z) && z > max, "重なり順が数値の上限に達したため最前面へ移動できません");
    return z;
  }
  bringToFront(id: number): void {
    const image = this.images.find(image => image.id === id);
    if (!image) return;
    const max = this.images.reduce((max, image) => Math.max(max, image.z), this.hiddenMaxZ);
    if (this.images[this.images.length - 1] === image &&
      (image.z > this.hiddenMaxZ || image.z === this.hiddenMaxZ && image.id === this.initialFrontId)) return;
    const z = this.nextFrontZ();
    const beforeZ = image.z;
    image.z = z;
    this.undoStack.push({ id, before: copy(image.item), after: copy(image.item), beforeZ, afterZ: z });
    this.redoStack = [];
    this.sortImages();
    this.onChange();
  }
  private sortImages(): void {
    this.images.sort((a, b) => a.z - b.z || this.tieOrder.get(a.id)! - this.tieOrder.get(b.id)!);
  }
  setItem(id: number, matrix: Matrix): void {
    const image = this.images.find(item => item.id === id);
    if (!image) return;
    image.item = copy(matrix);
    this.onChange();
  }
  setItems(states: { id: number; item: Matrix }[]): void {
    const matrices = new Map(states.map(state => [state.id, state.item]));
    for (const image of this.images) {
      const matrix = matrices.get(image.id);
      if (matrix) image.item = copy(matrix);
    }
    this.onChange();
  }
  commit(id: number, before: Matrix): void {
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
    if ("kind" in command && command.kind !== "batch") {
      const present = forward === (command.kind === "add");
      if (present) this.selection.clear();
      for (const image of command.images) this.applyMembership(image, present);
      return;
    }
    const images = new Map(this.images.map(image => [image.id, image]));
    for (const placement of "kind" in command ? command.commands : [command]) {
      const image = images.get(placement.id)!;
      image.z = forward ? placement.afterZ : placement.beforeZ;
      image.item = copy(forward ? placement.after : placement.before);
    }
  }
  discard(): void {
    this.images.splice(0, this.images.length, ...[...this.original.keys()].map(id => this.known.get(id)!));
    for (const image of this.images) {
      image.item = copy(this.original.get(image.id)!);
      image.z = this.originalZ.get(image.id)!;
    }
    this.sortImages();
    this.undoStack = [];
    this.redoStack = [];
    for (const id of this.selection) if (!this.images.some(image => image.id === id)) this.selection.delete(id);
    this.onChange();
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
