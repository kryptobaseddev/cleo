// tests/timer.test.js — node --test
import test from "node:test";
import assert from "node:assert/strict";
import {
  PHASES, createTimer, phaseDuration, nextPhase,
  start, pause, tick, reset, setDurations, formatTime,
} from "../lib/timer.js";

test("createTimer returns idle state with correct default durations", () => {
  const t = createTimer();
  assert.equal(t.phase, PHASES.IDLE);
  assert.equal(t.running, false);
  assert.equal(t.cyclesCompleted, 0);
  assert.deepEqual(t.durations, { work: 25, short: 5, long: 15 });
  assert.equal(t.remainingMs, null);
});

test("phaseDuration converts minutes to ms", () => {
  const t = createTimer({ work: 10, short: 2, long: 6 });
  // idle has no duration
  assert.equal(phaseDuration(t, PHASES.IDLE), 0);
  assert.equal(phaseDuration(t, PHASES.WORK), 10 * 60_000);
  assert.equal(phaseDuration(t, PHASES.SHORT), 2 * 60_000);
  assert.equal(phaseDuration(t, PHASES.LONG), 6 * 60_000);
});

test("nextPhase cycles work→short three times then work→long on 4th", () => {
  let t = createTimer();
  // idle → work
  t = nextPhase(t);
  assert.equal(t.phase, PHASES.WORK);
  assert.equal(t.cyclesCompleted, 0);

  // work 1 ends → short
  t = nextPhase(t);
  assert.equal(t.phase, PHASES.SHORT);
  assert.equal(t.cyclesCompleted, 1);

  // short → work 2
  t = nextPhase(t);
  assert.equal(t.phase, PHASES.WORK);

  // work 2 → short
  t = nextPhase(t);
  assert.equal(t.phase, PHASES.SHORT);
  assert.equal(t.cyclesCompleted, 2);

  // short → work 3
  t = nextPhase(t);
  assert.equal(t.phase, PHASES.WORK);

  // work 3 → short
  t = nextPhase(t);
  assert.equal(t.phase, PHASES.SHORT);
  assert.equal(t.cyclesCompleted, 3);

  // short → work 4
  t = nextPhase(t);
  assert.equal(t.phase, PHASES.WORK);

  // work 4 → LONG break
  t = nextPhase(t);
  assert.equal(t.phase, PHASES.LONG);
  assert.equal(t.cyclesCompleted, 4);

  // long → work 5
  t = nextPhase(t);
  assert.equal(t.phase, PHASES.WORK);
});

test("start advances idle to work with correct remainingMs", () => {
  let t = createTimer({ work: 1, short: 1, long: 1 });
  t = start(t, 0);
  assert.equal(t.phase, PHASES.WORK);
  assert.equal(t.running, true);
  assert.equal(t.remainingMs, 60_000);
  assert.equal(t.startedAt, 0);
});

test("pause then start preserves elapsed time (no drift)", () => {
  let t = createTimer({ work: 1, short: 1, long: 1 });
  t = start(t, 0);
  // 20s in
  const mid = tick(t, 20_000).state;
  assert.equal(mid.remainingMs, 40_000);

  // pause at 20s
  const paused = pause(mid, 20_000);
  assert.equal(paused.running, false);
  assert.equal(paused.accumulatedMs, 20_000);
  assert.equal(paused.remainingMs, 40_000);

  // resume at some later time (30s wall clock)
  const resumed = start(paused, 30_000);
  assert.equal(resumed.running, true);
  // startedAt should be 30_000 - 20_000 = 10_000 so elapsed resumes correctly
  assert.equal(resumed.startedAt, 10_000);

  // after 10 more seconds (40s wall), 30 total elapsed → 30s remaining
  const next = tick(resumed, 40_000).state;
  assert.equal(next.remainingMs, 30_000);
});

test("tick at phase end fires phaseEnd and advances to next phase", () => {
  let t = createTimer({ work: 1, short: 1, long: 1 });
  t = start(t, 0);
  // jump to exactly 60s
  const res = tick(t, 60_000);
  assert.equal(res.fired, "phaseEnd");
  assert.equal(res.state.phase, PHASES.SHORT);
  assert.equal(res.state.cyclesCompleted, 1);
  assert.equal(res.state.running, false);
  assert.equal(res.state.remainingMs, 60_000);
});

test("reset restores full remaining time without changing phase or cycles", () => {
  let t = createTimer({ work: 1, short: 1, long: 1 });
  t = start(t, 0);
  const mid = tick(t, 30_000).state;
  const r = reset(mid);
  assert.equal(r.phase, PHASES.WORK);
  assert.equal(r.running, false);
  assert.equal(r.accumulatedMs, 0);
  assert.equal(r.remainingMs, 60_000);
});

test("setDurations updates durations; remainingMs recomputed when paused", () => {
  let t = createTimer({ work: 25, short: 5, long: 15 });
  t = start(t, 0);
  t = pause(t, 1000);
  const changed = setDurations(t, { work: 10 });
  assert.equal(changed.durations.work, 10);
  assert.equal(changed.remainingMs, 10 * 60_000);
});

test("formatTime pads correctly", () => {
  assert.equal(formatTime(0), "00:00");
  assert.equal(formatTime(59_000), "00:59");
  assert.equal(formatTime(60_000), "01:00");
  assert.equal(formatTime(25 * 60_000), "25:00");
});

test("four full work cycles yield cyclesCompleted=4 and phase=long", () => {
  let t = createTimer({ work: 1, short: 1, long: 1 });
  // Complete 4 work/short alternations, verifying 4th work ends into long
  for (let i = 0; i < 3; i++) {
    t = start(t, 0);
    t = tick(t, 60_000).state; // work → short
    t = tick(t, 0).state; // no-op (not running)
    // Auto-advance simulation: next phase is short, start it
    t = start(t, 0);
    t = tick(t, 60_000).state; // short → work
  }
  // After 3 full cycles, we're starting work #4
  assert.equal(t.phase, PHASES.WORK);
  assert.equal(t.cyclesCompleted, 3);

  t = start(t, 0);
  t = tick(t, 60_000).state; // work 4 → long
  assert.equal(t.phase, PHASES.LONG);
  assert.equal(t.cyclesCompleted, 4);
});
