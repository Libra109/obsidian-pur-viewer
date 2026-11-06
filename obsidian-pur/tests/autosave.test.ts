import assert from "node:assert/strict";
import { test } from "node:test";
import { IdleAutosave, TimerHandle } from "../src/autosave";

class FakeTimers {
  private next = 0;
  readonly callbacks = new Map<number, () => void>();
  readonly active = new Set<number>();
  readonly delays = new Map<number, number>();
  set = (callback: () => void, delay: number): TimerHandle => {
    const id = ++this.next;
    this.callbacks.set(id, callback);
    this.active.add(id);
    this.delays.set(id, delay);
    return id as unknown as TimerHandle;
  };
  clear = (timer: TimerHandle): void => { this.active.delete(timer as unknown as number); };
  fire(id: number): void {
    if (!this.active.delete(id)) return;
    this.callbacks.get(id)?.();
  }
  latest(): number { return this.next; }
}

test("idle autosave debounces edits and resets its timer until the idle interval", () => {
  const timers = new FakeTimers();
  let saves = 0;
  const autosave = new IdleAutosave(() => saves++, 3000, timers.set, timers.clear);
  autosave.changed(true);
  const first = timers.latest();
  assert.equal(timers.delays.get(first), 3000);
  autosave.changed(true);
  const second = timers.latest();
  assert.equal(timers.active.has(first), false);
  timers.fire(first);
  assert.equal(saves, 0, "a cleared timer cannot save");
  timers.fire(second);
  assert.equal(saves, 1);
});

test("changing the interval resets a pending timer and uses the new delay", () => {
  const timers = new FakeTimers();
  let saves = 0;
  const autosave = new IdleAutosave(() => saves++, 3000, timers.set, timers.clear);
  autosave.changed(true);
  const oldTimer = timers.latest();
  autosave.setDelay(5000);
  const updatedTimer = timers.latest();
  assert.equal(timers.active.has(oldTimer), false);
  assert.equal(timers.delays.get(updatedTimer), 5000);
  timers.fire(oldTimer);
  assert.equal(saves, 0);
  timers.fire(updatedTimer);
  assert.equal(saves, 1);
});

test("interval changes while saving keep pending edits paused and resume with the new delay", () => {
  const timers = new FakeTimers();
  let saves = 0;
  const autosave = new IdleAutosave(() => saves++, 3000, timers.set, timers.clear);
  autosave.changed(true);
  const initialTimer = timers.latest();
  autosave.pause();
  autosave.changed(true);
  autosave.setDelay(7000);
  assert.equal(timers.active.size, 0, "an interval change must not start a timer while saving");
  timers.fire(initialTimer);
  assert.equal(saves, 0);
  autosave.resume(true);
  const followup = timers.latest();
  assert.equal(timers.delays.get(followup), 7000);
  timers.fire(followup);
  assert.equal(saves, 1);
});

test("autosave rejects zero and unsafe delays", () => {
  const autosave = new IdleAutosave(() => {}, 3000);
  assert.throws(() => autosave.setDelay(0), RangeError);
  assert.throws(() => autosave.setDelay(Number.MAX_SAFE_INTEGER + 1), RangeError);
  autosave.dispose();
});

test("clean state cancels, save pause suppresses timer, and only edits during save reschedule", () => {
  const timers = new FakeTimers();
  let saves = 0;
  const autosave = new IdleAutosave(() => saves++, 3000, timers.set, timers.clear);
  autosave.changed(true);
  const canceledByUndo = timers.latest();
  autosave.changed(false);
  timers.fire(canceledByUndo);
  assert.equal(saves, 0);

  autosave.changed(true);
  const beforeManualSave = timers.latest();
  autosave.pause();
  timers.fire(beforeManualSave);
  assert.equal(saves, 0);
  autosave.resume(true);
  assert.equal(timers.active.size, 0, "a failed save without new edits does not retry in a loop");

  autosave.pause();
  autosave.changed(true);
  autosave.resume(true);
  const afterConcurrentEdit = timers.latest();
  assert.ok(timers.active.has(afterConcurrentEdit));
  timers.fire(afterConcurrentEdit);
  assert.equal(saves, 1, "an edit made during saving receives a new idle interval");

  autosave.pause();
  autosave.changed(true);
  autosave.resume(false);
  assert.equal(timers.active.size, 0, "a successful save that clears dirty cancels the follow-up");
});

test("dispose and explicit cancel prevent pending autosaves from reaching a closed view", () => {
  const timers = new FakeTimers();
  let saves = 0;
  const autosave = new IdleAutosave(() => saves++, 3000, timers.set, timers.clear);
  autosave.changed(true);
  const first = timers.latest();
  autosave.cancel();
  timers.fire(first);
  assert.equal(saves, 0);
  autosave.changed(true);
  const second = timers.latest();
  autosave.dispose();
  timers.fire(second);
  assert.equal(saves, 0);
  autosave.changed(true);
  assert.equal(timers.active.size, 0);
});
