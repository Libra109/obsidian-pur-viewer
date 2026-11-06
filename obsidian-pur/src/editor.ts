import { BoardImage, Matrix } from "./board";
import { check } from "./binary";

export interface ImageEditState {
  id: number;
  item: Matrix;
  z: number;
}

interface EditCommand {
  id: number;
  before: Matrix;
  after: Matrix;
  beforeZ: number;
  afterZ: number;
}

function copy(matrix: Matrix): Matrix {
  return [...matrix];
}

function same(a: Matrix, b: Matrix): boolean {
  return a.every((value, index) => value === b[index]);
}

export class BoardEditor {
  selectedId?: number;
  private readonly original = new Map<number, Matrix>();
  private readonly originalZ = new Map<number, number>();
  private readonly tieOrder = new Map<number, number>();
  private undoStack: EditCommand[] = [];
  private redoStack: EditCommand[] = [];

  constructor(readonly images: BoardImage[], private readonly onChange: () => void = () => {},
    private readonly hiddenMaxZ = -Infinity, private readonly initialFrontId?: number) {
    images.forEach((image, index) => {
      this.original.set(image.id, copy(image.item));
      this.originalZ.set(image.id, image.z);
      this.tieOrder.set(image.id, index);
    });
  }

  get dirty(): boolean {
    return this.images.some(image => !same(image.item, this.original.get(image.id)!) ||
      image.z !== this.originalZ.get(image.id));
  }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  snapshot(): ImageEditState[] {
    return this.images.map(image => ({ id: image.id, item: copy(image.item), z: image.z }));
  }
  acceptSaved(placements: ImageEditState[]): void {
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
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.onChange();
  }
  bringToFront(id: number): void {
    const image = this.images.find(image => image.id === id);
    if (!image) return;
    const max = this.images.reduce((max, image) => Math.max(max, image.z), this.hiddenMaxZ);
    if (this.images[this.images.length - 1] === image &&
      (image.z > this.hiddenMaxZ || image.z === this.hiddenMaxZ && image.id === this.initialFrontId)) return;
    const z = max + Math.max(1, Math.abs(max) * Number.EPSILON * 2);
    check(Number.isFinite(z) && z > max, "重なり順が数値の上限に達したため最前面へ移動できません");
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
    const image = this.images.find(image => image.id === command.id)!;
    image.z = command.beforeZ;
    this.sortImages();
    this.setItem(command.id, command.before);
  }
  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    this.undoStack.push(command);
    const image = this.images.find(image => image.id === command.id)!;
    image.z = command.afterZ;
    this.sortImages();
    this.setItem(command.id, command.after);
  }
  discard(): void {
    for (const image of this.images) {
      image.item = copy(this.original.get(image.id)!);
      image.z = this.originalZ.get(image.id)!;
    }
    this.sortImages();
    this.undoStack = [];
    this.redoStack = [];
    this.onChange();
  }
}
