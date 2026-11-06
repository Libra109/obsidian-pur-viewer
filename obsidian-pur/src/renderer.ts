import { check } from "./binary";
import { BoardImage, boardBounds, Bounds, Clip, compareImageStack, invert, Matrix, multiply, Point, transform } from "./board";
import { Camera, gesturePoints } from "./camera";
import { Alignment, BoardEditor } from "./editor";
import { drawGrid } from "./grid";
import { decodeRaster, imageDimensions } from "./image-import";
import {
  flipItem, imageCenter, imageHandles, ImageGeometry, intersectsSelection, resizeCursor, resizeFromHandle,
  rotateMatrixAboutPoint, rotationHandles, selectionFrame,
} from "./handles";

export interface DecodedImage { image: BoardImage; bitmap: ImageBitmap }

const ROTATION_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M7.2 8.2A7 7 0 1 1 5 13" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round"/><path d="M7.2 8.2V3.8M7.2 8.2h4.4" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.2 8.2A7 7 0 1 1 5 13" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="M7.2 8.2V3.8M7.2 8.2h4.4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
)}") 12 12, crosshair`;

export async function decodeImages(images: BoardImage[], signal: AbortSignal): Promise<DecodedImage[]> {
  const decoded: DecodedImage[] = [];
  let pixels = 0;
  try {
    for (const image of images) {
      signal.throwIfAborted();
      if (["image/gif", "image/webp", "image/bmp", "image/svg+xml"].includes(image.mime)) {
        const dimensions = imageDimensions(image.data);
        check(dimensions.width === image.width && dimensions.height === image.height,
          "画像ヘッダーの寸法と保存寸法が一致しません");
      }
      check(pixels + image.width * image.height <= 80_000_000, "合計80メガピクセルの上限を超えています");
      const bitmap = await decodeRaster(image.data, image.mime, signal, {
        maxPixels: 80_000_000 - pixels, width: image.width, height: image.height,
      });
      if (signal.aborted) { bitmap.close(); signal.throwIfAborted(); }
      pixels += bitmap.width * bitmap.height;
      if (bitmap.width !== image.width || bitmap.height !== image.height || pixels > 80_000_000) {
        bitmap.close();
        throw new Error("画像の実寸が保存寸法と異なるか、合計80メガピクセルの上限を超えています");
      }
      decoded.push({ image, bitmap });
    }
    return decoded;
  } catch (error) {
    for (const entry of decoded) entry.bitmap.close();
    throw error;
  }
}

function clipPath(context: CanvasRenderingContext2D, clip: Clip): void {
  context.beginPath();
  for (let i = 0; i < clip.elements.length; i++) {
    const e = clip.elements[i];
    if (e.type === 0) context.moveTo(e.x, e.y);
    else if (e.type === 1) context.lineTo(e.x, e.y);
    else if (e.type === 2) {
      const b = clip.elements[++i], c = clip.elements[++i];
      context.bezierCurveTo(e.x, e.y, b.x, b.y, c.x, c.y);
    }
  }
  context.clip(clip.fillRule);
}

export function drawBoard(context: CanvasRenderingContext2D, images: DecodedImage[], camera: Camera,
  groups: BoardImage[] = []): void {
  context.save();
  context.translate(camera.x, camera.y);
  context.scale(camera.scale, camera.scale);
  const entries: { image: BoardImage; bitmap?: ImageBitmap }[] = [...images, ...groups.map(image => ({ image }))];
  const order = new Map(entries.map((entry, i) => [entry.image.id, i]));
  entries.sort((a, b) => compareImageStack(a.image, b.image, order.get(a.image.id)!, order.get(b.image.id)!));
  for (const { image, bitmap } of entries) {
    context.save();
    context.globalAlpha = image.opacity;
    context.transform(...image.item);
    if (image.clip) clipPath(context, image.clip);
    context.transform(...image.image);
    if (image.group) {
      const color = image.group.color;
      context.fillStyle = color ? `#${color.slice(3)}${color.slice(1, 3)}` : "#202020";
      const radius = Math.min(8, image.width / 2, image.height / 2);
      context.beginPath();
      context.moveTo(radius, 0); context.lineTo(image.width - radius, 0);
      context.quadraticCurveTo(image.width, 0, image.width, radius);
      context.lineTo(image.width, image.height - radius);
      context.quadraticCurveTo(image.width, image.height, image.width - radius, image.height);
      context.lineTo(radius, image.height);
      context.quadraticCurveTo(0, image.height, 0, image.height - radius);
      context.lineTo(0, radius); context.quadraticCurveTo(0, 0, radius, 0);
      context.fill();
    } else if (bitmap) context.drawImage(bitmap, 0, 0, image.width, image.height);
    context.restore();
  }
  context.restore();
}

function drawSelection(context: CanvasRenderingContext2D, image: ImageGeometry | undefined, camera: Camera): void {
  if (image) {
    const handles = imageHandles(image).map(world => {
      return { x: world.x * camera.scale + camera.x, y: world.y * camera.scale + camera.y };
    });
    const corners = handles.filter((_, i) => i % 2 === 0);
    context.save();
    context.strokeStyle = "#64b5f6";
    context.fillStyle = "#64b5f6";
    context.lineWidth = 1;
    context.setLineDash([]);
    context.beginPath();
    context.moveTo(corners[0].x, corners[0].y);
    for (const point of corners.slice(1)) context.lineTo(point.x, point.y);
    context.closePath();
    context.stroke();
    for (const handle of handles) {
      context.beginPath();
      context.arc(handle.x, handle.y, 3, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.restore();
  }
}

type Gesture =
  | { kind: "camera" }
  | { kind: "selection" }
  | { kind: "marquee"; start: Point; current: Point }
  | { kind: "move"; before: { id: number; item: Matrix }[]; start: Point; frame: ImageGeometry }
  | { kind: "resize"; before: { id: number; item: Matrix }[]; frame: ImageGeometry;
      index: number; anchor: Point; vector: Point; start: Point }
  | { kind: "rotate"; before: { id: number; item: Matrix }[]; frame: ImageGeometry;
      center: Point; lastAngle: number; angle: number };

interface TransformDiagnostic {
  kind: "resize" | "rotate";
  pointerMoves: number;
  drawCalls: number;
  renderedFrames: number;
}

export class BoardRenderer {
  readonly camera = new Camera();
  private readonly context: CanvasRenderingContext2D;
  private readonly events = new AbortController();
  private readonly observer: ResizeObserver;
  private readonly ownerWindow: Window;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: Gesture = { kind: "camera" };
  private editing = false;
  private frame = 0;
  private fitted = false;
  private disposed = false;
  private pendingFront?: number;
  private readonly tieOrder = new Map<number, number>();
  private transformDiagnostic?: TransformDiagnostic;
  private groupFrame?: { geometry: ImageGeometry; states: {
    id: number; item: Matrix; width: number; height: number; image: Matrix;
  }[] };

  private selectionGeometry(): ImageGeometry | undefined {
    const images = this.editor.selectedImages;
    if (images.length < 2) { this.groupFrame = undefined; return images[0]; }
    const cached = this.groupFrame;
    if (cached && images.length === cached.states.length && images.every((image, index) =>
      image.id === cached.states[index].id && image.width === cached.states[index].width &&
      image.height === cached.states[index].height &&
      image.image.every((value, i) => value === cached.states[index].image[i]) &&
      image.item.every((value, i) => value === cached.states[index].item[i])))
      return cached.geometry;
    const geometry = selectionFrame(images)!;
    this.rememberFrame(geometry);
    return geometry;
  }

  private rememberFrame(geometry: ImageGeometry): void {
    if (this.editor.selectedImages.length < 2) return;
    this.groupFrame = { geometry, states: this.editor.selectedImages.map(image => ({
      id: image.id, item: [...image.item], image: [...image.image], width: image.width, height: image.height,
    })) };
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly images: DecodedImage[],
    private readonly bounds: Bounds,
    private readonly editor: BoardEditor,
    private readonly onState: (state: string) => void = () => {},
    private readonly onError: (error: unknown) => void = error => console.error("LazyRef PUR Viewer:", error),
    private readonly frontOnSelect: () => boolean = () => false,
    private readonly onInteractionDiagnostic: (message: string) => void = () => {},
  ) {
    images.forEach(({ image }, index) => this.tieOrder.set(image.id, index));
    const context = canvas.getContext("2d");
    check(context, "Canvas 2Dを初期化できません");
    this.context = context;
    const ownerWindow = canvas.ownerDocument.defaultView;
    check(ownerWindow, "Canvasのウィンドウを取得できません");
    this.ownerWindow = ownerWindow;
    const signal = this.events.signal;
    const point = (event: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const setGestureCursor = () => {
      const gesture = this.gesture;
      if (gesture.kind === "rotate") this.canvas.style.cursor = ROTATION_CURSOR;
      else if (gesture.kind === "resize") {
        const image = this.selectionGeometry();
        if (image) this.canvas.style.cursor = resizeCursor(image, gesture.index);
      }
      else if (gesture.kind === "move" || this.pointers.size > 0) this.canvas.style.cursor = "grabbing";
    };
    const setHoverCursor = (screen: Point, pointerType: string) => {
      if (pointerType === "touch" || this.pointers.size) return;
      const selected = this.editing ? this.selectionGeometry() : undefined;
      const handles = selected ? imageHandles(selected) : [];
      const resizeRadius = 9;
      const resizeCandidates = handles.map((world, index) => ({
        kind: "resize" as const, index,
        distance: Math.hypot(screen.x - world.x * this.camera.scale - this.camera.x,
          screen.y - world.y * this.camera.scale - this.camera.y),
        radius: resizeRadius,
      }));
      const rotateRadius = 11;
      const rotateCandidates = selected
        ? rotationHandles(selected, 20 / this.camera.scale).map((world, index) => ({
          kind: "rotate" as const, index,
          distance: Math.hypot(screen.x - world.x * this.camera.scale - this.camera.x,
            screen.y - world.y * this.camera.scale - this.camera.y),
          radius: rotateRadius,
        }))
        : [];
      const nearest = [...resizeCandidates, ...rotateCandidates]
        .filter(candidate => candidate.distance <= candidate.radius)
        .sort((a, b) => a.distance - b.distance)[0];
      if (nearest?.kind === "rotate") this.canvas.style.cursor = ROTATION_CURSOR;
      else if (nearest?.kind === "resize" && selected)
        this.canvas.style.cursor = resizeCursor(selected, nearest.index);
      else this.canvas.style.cursor = "grab";
    };
    canvas.addEventListener("pointerdown", event => {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault();
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
      if (this.pointers.size > 0) {
        this.pendingFront = undefined;
        this.commitGesture();
        this.gesture = { kind: "camera" };
      } else if (this.editing && event.button === 0) {
        const p = point(event);
        const modified = event.ctrlKey || event.metaKey;
        const hit = this.hitTest(p);
        if (hit?.group?.unsupported) { this.onError(new Error(hit.group.unsupported)); return; }
        if (hit && this.editor.isSelected(hit.id) && this.editor.selectedImages.some(image => image.group?.unsupported)) {
          this.onError(new Error("未対応の子要素を持つグループは編集できません")); return;
        }
        const marquee = event.shiftKey && !hit;
        const selected = modified || marquee ? undefined : this.selectionGeometry();
        const handles = selected ? imageHandles(selected) : [];
        const resizeRadius = event.pointerType === "touch" ? 22 : 9;
        const resizeCandidates = handles.map((world, index) => ({
          kind: "resize" as const, index,
          distance: Math.hypot(p.x - world.x * this.camera.scale - this.camera.x,
            p.y - world.y * this.camera.scale - this.camera.y),
          radius: resizeRadius,
        }));
        const rotateRadius = event.pointerType === "touch" ? 16 : 11;
        const rotateCandidates = selected
          ? rotationHandles(selected, 20 / this.camera.scale).map((world, index) => ({
            kind: "rotate" as const, index,
            distance: Math.hypot(p.x - world.x * this.camera.scale - this.camera.x,
              p.y - world.y * this.camera.scale - this.camera.y),
            radius: rotateRadius,
          }))
          : [];
        const nearest = [...resizeCandidates, ...rotateCandidates]
          .filter(candidate => candidate.distance <= candidate.radius)
          .sort((a, b) => a.distance - b.distance)[0];
        if (selected && nearest?.kind === "rotate") {
          const world = this.worldPoint(p), center = imageCenter(selected);
          const angle = Math.atan2(world.y - center.y, world.x - center.x);
          this.gesture = {
            kind: "rotate", before: this.editor.selectedImages.map(image => ({ id: image.id, item: [...image.item] })),
            frame: { ...selected, item: [...selected.item] }, center,
            lastAngle: angle, angle: 0,
          };
        } else if (selected && nearest?.kind === "resize") {
          const handle = handles[nearest.index], anchor = handles[(nearest.index + 4) % 8];
          this.gesture = {
            kind: "resize", before: this.editor.selectedImages.map(image => ({ id: image.id, item: [...image.item] })),
            frame: { ...selected, item: [...selected.item] }, index: nearest.index, anchor,
            vector: { x: handle.x - anchor.x, y: handle.y - anchor.y },
            start: this.worldPoint(p),
          };
        } else {
          if (marquee) {
            const start = this.worldPoint(p);
            this.gesture = { kind: "marquee", start, current: start };
          } else if (modified) {
            if (hit) this.editor.toggleSelection(hit.id);
            this.gesture = { kind: "selection" };
          } else if (hit) {
            if (!this.editor.isSelected(hit.id)) this.editor.select(hit.id);
            if (this.editor.selected) this.pendingFront = hit.id;
            this.gesture = { kind: "move",
              before: this.editor.selectedImages.map(image => ({ id: image.id, item: [...image.item] })),
              start: p, frame: this.selectionGeometry()! };
          }
          else {
            this.editor.select();
            this.gesture = { kind: "camera" };
          }
          this.render();
        }
      } else this.gesture = { kind: "camera" };
      this.pointers.set(event.pointerId, point(event));
      if (this.gesture.kind === "resize" || this.gesture.kind === "rotate") {
        this.transformDiagnostic = {
          kind: this.gesture.kind, pointerMoves: 0, drawCalls: 0, renderedFrames: 0,
        };
        this.onInteractionDiagnostic(`${this.gesture.kind} gesture started`);
      }
      setGestureCursor();
    }, { signal });
    canvas.addEventListener("pointermove", event => {
      if (!this.pointers.has(event.pointerId)) {
        setHoverCursor(point(event), event.pointerType);
        return;
      }
      event.preventDefault();
      const beforePoints = [...this.pointers.values()];
      this.pointers.set(event.pointerId, point(event));
      if (this.gesture.kind === "resize" || this.gesture.kind === "rotate")
        this.transformDiagnostic && this.transformDiagnostic.pointerMoves++;
      if (this.pointers.size === 1 && this.gesture.kind === "marquee") {
        this.gesture.current = this.worldPoint(point(event));
        this.renderImmediately();
        return;
      }
      if (this.pointers.size === 1 && this.gesture.kind === "move") {
        this.promotePending();
        const p = this.pointers.get(event.pointerId)!;
        const deltaX = (p.x - this.gesture.start.x) / this.camera.scale;
        const deltaY = (p.y - this.gesture.start.y) / this.camera.scale;
        this.editor.setItems(this.gesture.before.map(state => {
          const matrix = [...state.item] as Matrix;
          matrix[4] += deltaX;
          matrix[5] += deltaY;
          return { id: state.id, item: matrix };
        }));
        const frame = this.gesture.frame;
        const item: Matrix = [...frame.item];
        item[4] += deltaX; item[5] += deltaY;
        this.rememberFrame({ ...frame, item });
        this.renderImmediately();
        return;
      }
      if (this.pointers.size === 1 && this.gesture.kind === "resize") {
        const p = this.pointers.get(event.pointerId)!;
        const gesture = this.gesture;
        const current = this.worldPoint(p);
        this.editor.setItems(gesture.before.map(state => ({ id: state.id,
          item: resizeFromHandle(state.item, gesture.anchor, gesture.vector, gesture.start, current) })));
        this.rememberFrame({ ...gesture.frame, item: resizeFromHandle(gesture.frame.item,
          gesture.anchor, gesture.vector, gesture.start, current) });
        setGestureCursor();
        this.renderImmediately();
        return;
      }
      if (this.pointers.size === 1 && this.gesture.kind === "rotate") {
        const p = this.worldPoint(this.pointers.get(event.pointerId)!);
        const angle = Math.atan2(p.y - this.gesture.center.y, p.x - this.gesture.center.x);
        let delta = angle - this.gesture.lastAngle;
        if (delta > Math.PI) delta -= Math.PI * 2;
        else if (delta < -Math.PI) delta += Math.PI * 2;
        this.gesture.lastAngle = angle;
        this.gesture.angle += delta;
        const gesture = this.gesture;
        const states = gesture.before.map(state => ({ id: state.id,
          item: rotateMatrixAboutPoint(state.item, gesture.center, gesture.angle) }));
        const frame = { ...gesture.frame,
          item: rotateMatrixAboutPoint(gesture.frame.item, gesture.center, gesture.angle) };
        this.editor.setItems(states);
        this.rememberFrame(frame);
        this.renderImmediately();
        return;
      }
      if (this.gesture.kind === "selection" && this.pointers.size === 1) return;
      if (this.pointers.size < 2) {
        this.camera.gesture(beforePoints[0], this.pointers.get(event.pointerId)!, 1);
        this.render();
        return;
      }
      const before = gesturePoints(beforePoints);
      const after = gesturePoints([...this.pointers.values()]);
      const factor = before.distance > 0 && after.distance > 0 ? after.distance / before.distance : 1;
      this.camera.gesture(before.center, after.center, factor);
      this.render();
    }, { signal });
    const release = (event: PointerEvent) => {
      if (event.type === "pointerup" && this.pointers.size === 1 &&
        this.pointers.has(event.pointerId) && this.gesture.kind === "marquee") {
        const start = this.gesture.start, end = this.worldPoint(point(event));
        this.editor.selectIds(this.editor.scopeItems.filter(image =>
          intersectsSelection(image, start, end))
          .map(image => image.id));
      }
      if (event.type === "pointerup" && this.pointers.size === 1) this.promotePending();
      else this.pendingFront = undefined;
      if (this.pointers.has(event.pointerId)) this.commitGesture();
      this.pointers.delete(event.pointerId);
      this.render();
      if (this.pointers.size === 1) {
        this.gesture = { kind: "camera" };
        this.render();
      }
      if (this.pointers.size === 0) setHoverCursor(point(event), event.pointerType);
    };
    canvas.addEventListener("pointerup", release, { signal });
    canvas.addEventListener("dblclick", event => {
      if (!this.editing) return;
      const rect = canvas.getBoundingClientRect();
      const hit = this.hitTest({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      if (hit?.group) this.editGroup(hit.id);
    }, { signal });
    canvas.addEventListener("pointercancel", release, { signal });
    canvas.addEventListener("lostpointercapture", release, { signal });
    canvas.addEventListener("wheel", event => {
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
      const p = point(event);
      this.camera.gesture(p, p, Math.exp(Math.max(-2, Math.min(2, -event.deltaY * multiplier * 0.002))));
      this.render();
    }, { passive: false, signal });
    canvas.addEventListener("keydown", event => {
      if (event.target !== canvas) return;
      if (this.editing && !event.ctrlKey && !event.metaKey && !event.altKey &&
        (event.key === "Delete" || event.key === "Backspace")) {
        if (!this.editor.selectedImages.length) return;
        this.removeSelected();
      } else if (this.editing && event.key === "Escape") {
        this.finishPendingEdit();
        if (!this.editor.selectedImages.length && this.editor.editingParent !== -1) this.editor.leaveGroup();
        else this.editor.select();
        this.render();
      } else if (this.editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        if (event.shiftKey) this.redo(); else this.undo();
      } else if (this.editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") this.redo();
      else if (event.key === "0") this.fit();
      else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        this.camera.x += event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0;
        this.camera.y += event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0;
        this.render();
      } else if (["+", "=", "-"].includes(event.key)) this.zoom(event.key === "-" ? 0.8 : 1.25);
      else return;
      event.preventDefault();
    }, { signal });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
    canvas.style.cursor = "grab";
  }

  private resize(): void {
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (this.disposed) return;
    if (!width || !height) {
      this.onState(`waiting for layout; canvas ${width} x ${height}`);
      return;
    }
    // Cap the backing store on high-DPI phones to avoid oversized canvas allocations.
    const ratio = Math.min(this.ownerWindow.devicePixelRatio || 1, 2, 4096 / Math.max(width, height));
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    if (!this.fitted) {
      this.camera.fit(this.bounds, width, height);
      this.fitted = true;
    }
    this.drawFrame();
  }

  fit(): void {
    if (!this.canvas.clientWidth || !this.canvas.clientHeight) return;
    this.camera.fit(boardBounds(this.editor.images), this.canvas.clientWidth, this.canvas.clientHeight);
    this.fitted = true;
    this.render();
  }

  zoom(factor: number): void {
    const center = { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 };
    this.camera.gesture(center, center, factor);
    this.render();
  }

  get canTransformSelected(): boolean { return this.editing && this.editor.selected !== undefined && !this.editor.selected.group?.unsupported; }
  get canRotateSelected(): boolean { return this.editing && this.editor.selectedImages.length > 0 &&
    !this.editor.selectedImages.some(image => image.group?.unsupported); }
  get canRemoveSelected(): boolean { return this.editing && this.editor.selectedImages.length > 0; }
  get canAlignSelected(): boolean { return this.editing && this.editor.selectedImages.length > 1; }
  alignSelected(alignment: Alignment): void {
    if (!this.canAlignSelected) return;
    this.finishPendingEdit();
    try { this.editor.alignSelected(alignment); }
    catch (error) { this.onError(error); }
    this.render();
  }
  get retainedPixels(): number {
    return this.images.reduce((sum, entry) => sum + entry.bitmap.width * entry.bitmap.height, 0);
  }
  get retainedBytes(): number {
    return this.images.reduce((sum, entry) => sum + entry.image.data.length, 0);
  }
  get retainedCount(): number { return this.images.length; }
  insertionPoint(client?: Point): Point {
    const rect = this.canvas.getBoundingClientRect();
    return this.worldPoint(client ? { x: client.x - rect.left, y: client.y - rect.top }
      : { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 });
  }
  addImage(content: Omit<BoardImage, "id" | "z">, bitmap: ImageBitmap): void {
    this.finishPendingEdit();
    const image = this.editor.add(content);
    this.images.push({ image, bitmap });
    this.tieOrder.set(image.id, this.tieOrder.size);
    this.renderImmediately();
  }
  removeSelected(): void {
    if (!this.canRemoveSelected) return;
    this.finishPendingEdit();
    try { this.editor.removeSelected(); } catch (error) { this.onError(error); }
    this.renderImmediately();
  }
  rotateSelected(angle: number): void {
    if (!this.canRotateSelected) return;
    this.finishPendingEdit();
    const frame = this.selectionGeometry()!, center = imageCenter(frame);
    const before = this.editor.selectedImages.map(image => ({ id: image.id, item: [...image.item] as Matrix }));
    const states = before.map(state => ({ id: state.id, item: rotateMatrixAboutPoint(state.item, center, angle) }));
    const rotated = { ...frame, item: rotateMatrixAboutPoint(frame.item, center, angle) };
    this.editor.setItems(states);
    this.rememberFrame(rotated);
    this.editor.commitItems(before);
    this.render();
  }
  flipSelected(axis: "horizontal" | "vertical"): void {
    const image = this.editor.selected;
    if (!this.canTransformSelected || !image) return;
    this.editor.transformItem(image.id, flipItem(image, axis));
    this.render();
  }

  private render(): void {
    if (this.frame || this.disposed) return;
    this.onState(`frame scheduled; canvas ${this.canvas.clientWidth} x ${this.canvas.clientHeight}`);
    this.frame = this.ownerWindow.requestAnimationFrame(() => {
      this.frame = 0;
      this.drawFrame();
    });
  }

  private renderImmediately(): void {
    if (this.disposed) return;
    if (this.frame) {
      this.ownerWindow.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.drawFrame();
  }

  private drawFrame(): void {
    if (this.disposed) return;
    const diagnostic = this.transformDiagnostic;
    if (diagnostic) diagnostic.drawCalls++;
    if (!this.canvas.clientWidth || !this.canvas.clientHeight) {
      this.onState(`waiting for layout; canvas ${this.canvas.clientWidth} x ${this.canvas.clientHeight}`);
      return;
    }
    try {
      const context = this.context;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const ratioX = this.canvas.width / this.canvas.clientWidth;
      const ratioY = this.canvas.height / this.canvas.clientHeight;
      context.scale(ratioX, ratioY);
      drawGrid(context, this.camera, this.canvas.clientWidth, this.canvas.clientHeight);
      this.sortDecodedImages();
      drawBoard(context, this.activeImages(), this.camera, this.editor.images.filter(image => image.group));
      if (this.editing) {
        drawSelection(context, this.selectionGeometry(), this.camera);
        if (this.gesture.kind === "marquee") {
          const { start, current } = this.gesture;
          context.save();
          context.strokeStyle = "#64b5f6";
          context.fillStyle = "rgba(100,181,246,0.12)";
          context.lineWidth = 1;
          context.setLineDash([4, 4]);
          const x = start.x * this.camera.scale + this.camera.x;
          const y = start.y * this.camera.scale + this.camera.y;
          const width = (current.x - start.x) * this.camera.scale;
          const height = (current.y - start.y) * this.camera.scale;
          context.fillRect(x, y, width, height);
          context.strokeRect(x, y, width, height);
          context.restore();
        }
      }
      if (diagnostic) diagnostic.renderedFrames++;
      this.onState(`frame drawn; canvas ${this.canvas.clientWidth} x ${this.canvas.clientHeight}; images ${this.editor.images.length}`);
    } catch (error) {
      if (diagnostic)
        this.onInteractionDiagnostic(`${diagnostic.kind} draw failed: ${error instanceof Error ? error.message : String(error)}`);
      this.onError(error);
    }
  }

  setEditMode(enabled: boolean): void {
    this.finishPendingEdit();
    this.editing = enabled;
    this.canvas.style.cursor = "grab";
    this.render();
  }
  finishPendingEdit(): void {
    this.pendingFront = undefined;
    this.commitGesture();
    this.gesture = { kind: "camera" };
    this.pointers.clear();
  }
  undo(): void { this.finishPendingEdit(); this.editor.undo(); this.render(); }
  editGroup(id = this.editor.selectedId): void {
    if (!this.editing || id === undefined) return;
    this.finishPendingEdit();
    try { this.editor.enterGroup(id); this.render(); } catch (error) { this.onError(error); }
  }
  parentGroup(): void {
    if (!this.editing) return;
    this.finishPendingEdit(); this.editor.leaveGroup(); this.render();
  }
  groupSelected(): void {
    if (!this.editing) return;
    this.finishPendingEdit();
    try { this.editor.groupSelected(); this.render(); } catch (error) { this.onError(error); }
  }
  ungroupSelected(): void {
    if (!this.editing) return;
    this.finishPendingEdit();
    try { this.editor.ungroupSelected(); this.render(); } catch (error) { this.onError(error); }
  }
  groupColor(color: string | null): void {
    if (!this.editing) return;
    this.finishPendingEdit();
    try { this.editor.setGroupColor(color); this.render(); } catch (error) { this.onError(error); }
  }
  redo(): void { this.finishPendingEdit(); this.editor.redo(); this.render(); }
  discardEdits(): void { this.finishPendingEdit(); this.editor.discard(); this.render(); }
  private commitGesture(): void {
    const gesture = this.gesture;
    this.gesture = { kind: "camera" };
    if (gesture.kind === "resize" || gesture.kind === "rotate") {
      const diagnostic = this.transformDiagnostic;
      this.transformDiagnostic = undefined;
      if (diagnostic) {
        const matrix = this.editor.images.find(item => item.id === gesture.before[0]?.id)?.item
          .map(value => Number(value.toFixed(4))).join(",") ?? "missing";
        this.onInteractionDiagnostic(
          `${diagnostic.kind} gesture ended; pointerMoves=${diagnostic.pointerMoves}; ` +
          `drawCalls=${diagnostic.drawCalls}; renderedFrames=${diagnostic.renderedFrames}; item=${matrix}`,
        );
      }
    }
    if (gesture.kind === "move" || gesture.kind === "resize" || gesture.kind === "rotate")
      this.editor.commitItems(gesture.before);
  }
  private promotePending(): void {
    const id = this.pendingFront;
    this.pendingFront = undefined;
    if (id === undefined || !this.frontOnSelect()) return;
    try { this.editor.bringToFront(id); }
    catch (error) { this.onError(error); }
  }
  private sortDecodedImages(): void {
    this.images.sort((a, b) => compareImageStack(a.image, b.image,
      this.tieOrder.get(a.image.id)!, this.tieOrder.get(b.image.id)!));
  }
  private activeImages(): DecodedImage[] {
    const ids = new Set(this.editor.images.map(image => image.id));
    return this.images.filter(entry => ids.has(entry.image.id));
  }
  private worldPoint(point: Point): Point {
    return { x: (point.x - this.camera.x) / this.camera.scale, y: (point.y - this.camera.y) / this.camera.scale };
  }
  private hitTest(screen: Point): BoardImage | undefined {
    this.sortDecodedImages();
    const world = { x: (screen.x - this.camera.x) / this.camera.scale,
      y: (screen.y - this.camera.y) / this.camera.scale };
    const images = this.editor.scopeItems;
    for (let i = images.length - 1; i >= 0; i--) {
      const image = images[i];
      const inverse = invert(multiply(image.item, image.image));
      if (!inverse) continue;
      const local = transform(inverse, world);
      if (local.x >= 0 && local.y >= 0 && local.x <= image.width && local.y <= image.height) return image;
    }
    return undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.events.abort();
    this.observer.disconnect();
    this.pointers.clear();
    if (this.frame) this.ownerWindow.cancelAnimationFrame(this.frame);
    for (const { bitmap } of this.images) bitmap.close();
    this.canvas.width = 1; this.canvas.height = 1;
    this.onState("renderer disposed");
  }
}
