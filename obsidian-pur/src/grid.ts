import { Camera } from "./camera";

export function gridLines(camera: Camera, width: number, height: number): { x: number[]; y: number[] } {
  const empty = { x: [], y: [] };
  if (![camera.scale, camera.x, camera.y, width, height].every(Number.isFinite) ||
    camera.scale <= 0 || width <= 0 || height <= 0) return empty;
  const exponent = Math.ceil(Math.log2(48) - Math.log2(100) - Math.log2(camera.scale));
  const step = 2 ** (Math.log2(100) + Math.log2(camera.scale) + exponent);
  if (!Number.isFinite(step) || step <= 0) return empty;
  const axis = (offset: number, extent: number) => {
    const first = ((offset % step) + step) % step;
    const count = Math.min(256, Math.ceil(extent / step));
    return Array.from({ length: count }, (_, i) => first + i * step).filter(value => value <= extent);
  };
  return { x: axis(camera.x, width), y: axis(camera.y, height) };
}

export function drawGrid(context: CanvasRenderingContext2D, camera: Camera, width: number, height: number): void {
  const lines = gridLines(camera, width, height);
  context.save();
  context.strokeStyle = "rgba(170, 180, 195, 0.18)";
  context.lineWidth = 1;
  context.beginPath();
  for (const x of lines.x) { context.moveTo(x, 0); context.lineTo(x, height); }
  for (const y of lines.y) { context.moveTo(0, y); context.lineTo(width, y); }
  context.stroke();
  context.restore();
}
