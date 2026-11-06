export type TimerHandle = ReturnType<typeof setTimeout>;
export type SetTimer = (callback: () => void, delay: number) => TimerHandle;
export type ClearTimer = (handle: TimerHandle) => void;

const defaultSetTimer: SetTimer = (callback, delay) => globalThis.setTimeout(callback, delay);
const defaultClearTimer: ClearTimer = handle => globalThis.clearTimeout(handle);

export class IdleAutosave {
  private timer?: TimerHandle;
  private paused = false;
  private disposed = false;
  private pending = false;
  private delayMs: number;

  constructor(
    private readonly save: () => void,
    delayMs = 3000,
    private readonly setTimer: SetTimer = defaultSetTimer,
    private readonly clearTimer: ClearTimer = defaultClearTimer,
  ) {
    this.validateDelay(delayMs);
    this.delayMs = delayMs;
  }

  setDelay(delayMs: number): void {
    this.validateDelay(delayMs);
    this.delayMs = delayMs;
    if (this.pending && !this.paused && !this.disposed) this.schedule();
  }

  changed(dirty: boolean): void {
    if (this.disposed) return;
    this.pending = dirty;
    if (!dirty) {
      this.clearScheduled();
      return;
    }
    if (!this.paused) this.schedule();
  }

  pause(): void {
    this.paused = true;
    this.pending = false;
    this.clearScheduled();
  }

  resume(dirty: boolean, force = false): void {
    if (this.disposed) return;
    this.paused = false;
    if (!dirty) {
      this.pending = false;
      this.clearScheduled();
    } else if (this.pending || force) {
      this.pending = true;
      this.schedule();
    }
  }

  cancel(): void {
    this.pending = false;
    this.clearScheduled();
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private schedule(): void {
    this.clearScheduled();
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (this.disposed || this.paused || !this.pending) return;
      this.paused = true;
      this.pending = false;
      this.save();
    }, this.delayMs);
  }

  private clearScheduled(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private validateDelay(delayMs: number): void {
    if (!Number.isSafeInteger(delayMs) || delayMs < 1)
      throw new RangeError("Autosave delay must be a positive safe integer");
  }
}
