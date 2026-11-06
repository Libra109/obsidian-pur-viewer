import { Bounds, Point } from "./board";

export class Camera {
  scale = 1;
  x = 0;
  y = 0;

  fit(bounds: Bounds, width: number, height: number): void {
    this.scale = Math.min(64, Math.max(0.000001,
      Math.min(Math.max(1, width - 48) / bounds.width, Math.max(1, height - 48) / bounds.height)));
    this.x = width / 2 - (bounds.x + bounds.width / 2) * this.scale;
    this.y = height / 2 - (bounds.y + bounds.height / 2) * this.scale;
  }

  gesture(from: Point, to: Point, factor: number): void {
    const scale = Math.min(64, Math.max(0.000001, this.scale * factor));
    const ratio = scale / this.scale;
    this.x = to.x - (from.x - this.x) * ratio;
    this.y = to.y - (from.y - this.y) * ratio;
    this.scale = scale;
  }
}

export function gesturePoints(points: Point[]): { center: Point; distance: number } {
  const [a, b = a] = points;
  return {
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    distance: Math.hypot(a.x - b.x, a.y - b.y),
  };
}
