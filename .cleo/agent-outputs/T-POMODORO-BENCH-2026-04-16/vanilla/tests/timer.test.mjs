import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTimer, nextPhase, phaseDuration, PHASES, DEFAULT_SETTINGS,
} from '../src/timer.js';

/** Build a fake clock + scheduler we can tick manually. */
function makeHarness() {
  let nowMs = 0;
  /** @type {{ at: number, fn: () => void, id: number }[]} */
  const tasks = [];
  let nextId = 1;
  return {
    now: () => nowMs,
    setT: (fn, ms) => {
      const id = nextId++;
      tasks.push({ at: nowMs + ms, fn, id });
      return id;
    },
    clearT: (id) => {
      const i = tasks.findIndex(t => t.id === id);
      if (i >= 0) tasks.splice(i, 1);
    },
    advance(ms) {
      const target = nowMs + ms;
      // Drain all tasks due by `target`, in order, advancing the clock between.
      tasks.sort((a, b) => a.at - b.at);
      while (tasks.length && tasks[0].at <= target) {
        const t = tasks.shift();
        nowMs = t.at;
        t.fn();
        tasks.sort((a, b) => a.at - b.at);
      }
      nowMs = target;
    },
  };
}

test('phaseDuration respects settings', () => {
  const s = { workMin: 30, shortMin: 6, longMin: 20, longEvery: 4, chime: true };
  assert.equal(phaseDuration(PHASES.WORK, s), 1800);
  assert.equal(phaseDuration(PHASES.SHORT, s), 360);
  assert.equal(phaseDuration(PHASES.LONG, s), 1200);
});

test('phaseDuration clamps work/short/long to minimum 1 minute', () => {
  const s = { workMin: 0, shortMin: -1, longMin: 0, longEvery: 4, chime: false };
  assert.equal(phaseDuration(PHASES.WORK, s), 60);
  assert.equal(phaseDuration(PHASES.SHORT, s), 60);
  assert.equal(phaseDuration(PHASES.LONG, s), 60);
});

test('nextPhase: work → short_break, short_break/long_break → work', () => {
  const s = DEFAULT_SETTINGS;
  assert.equal(nextPhase(PHASES.WORK,  0, s), PHASES.SHORT);
  assert.equal(nextPhase(PHASES.SHORT, 1, s), PHASES.WORK);
  assert.equal(nextPhase(PHASES.LONG,  4, s), PHASES.WORK);
});

test('nextPhase: every 4th work triggers LONG break', () => {
  const s = DEFAULT_SETTINGS; // longEvery=4
  // completedWorkCount BEFORE this completion
  assert.equal(nextPhase(PHASES.WORK, 0, s), PHASES.SHORT); // 1st work → short
  assert.equal(nextPhase(PHASES.WORK, 1, s), PHASES.SHORT); // 2nd work → short
  assert.equal(nextPhase(PHASES.WORK, 2, s), PHASES.SHORT); // 3rd work → short
  assert.equal(nextPhase(PHASES.WORK, 3, s), PHASES.LONG);  // 4th work → long
  assert.equal(nextPhase(PHASES.WORK, 4, s), PHASES.SHORT); // 5th work → short
  assert.equal(nextPhase(PHASES.WORK, 7, s), PHASES.LONG);  // 8th work → long
});

test('createTimer: default state is Work phase, not running, full duration', () => {
  const h = makeHarness();
  const timer = createTimer({ now: h.now, setT: h.setT, clearT: h.clearT });
  const s = timer.getState();
  assert.equal(s.phase, PHASES.WORK);
  assert.equal(s.running, false);
  assert.equal(s.remainingSec, 25 * 60);
  assert.equal(s.durationSec, 25 * 60);
});

test('createTimer: running drains remainingSec', () => {
  const h = makeHarness();
  const timer = createTimer({
    settings: { ...DEFAULT_SETTINGS, workMin: 1 },
    now: h.now, setT: h.setT, clearT: h.clearT,
  });
  timer.start();
  h.advance(30_000); // 30 seconds in
  assert.equal(timer.getState().remainingSec, 30);
  h.advance(20_000); // 50s total
  assert.equal(timer.getState().remainingSec, 10);
});

test('createTimer: pause freezes remaining, resume continues', () => {
  const h = makeHarness();
  const timer = createTimer({
    settings: { ...DEFAULT_SETTINGS, workMin: 1 },
    now: h.now, setT: h.setT, clearT: h.clearT,
  });
  timer.start();
  h.advance(20_000);
  timer.pause();
  const paused = timer.getState().remainingSec;
  assert.equal(paused, 40);
  // Time passes while paused — state must NOT change
  h.advance(10_000);
  assert.equal(timer.getState().remainingSec, 40);
  timer.start();
  h.advance(30_000);
  assert.equal(timer.getState().remainingSec, 10);
});

test('createTimer: phase end fires callback and advances to SHORT break', () => {
  const h = makeHarness();
  const ends = [];
  const timer = createTimer({
    settings: { ...DEFAULT_SETTINGS, workMin: 1 },
    now: h.now, setT: h.setT, clearT: h.clearT,
    onPhaseEnd: (c, n) => ends.push({ c, n }),
  });
  timer.start();
  h.advance(60_000); // exactly 1 minute
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0], { c: PHASES.WORK, n: PHASES.SHORT });
  assert.equal(timer.getState().phase, PHASES.SHORT);
  assert.equal(timer.getState().running, false); // auto-pause between
});

test('createTimer: long break every 4th work completion', () => {
  const h = makeHarness();
  const ends = [];
  const timer = createTimer({
    settings: { workMin: 1, shortMin: 1, longMin: 1, longEvery: 4, chime: false },
    now: h.now, setT: h.setT, clearT: h.clearT,
    onPhaseEnd: (c, n) => ends.push({ c, n }),
  });

  // Run through 4 work phases + 3 short breaks + final long break
  const sequence = [
    // work1 → short1
    { run: 60_000, expect: { c: PHASES.WORK,  n: PHASES.SHORT } },
    // short1 → work2
    { run: 60_000, expect: { c: PHASES.SHORT, n: PHASES.WORK  } },
    // work2 → short2
    { run: 60_000, expect: { c: PHASES.WORK,  n: PHASES.SHORT } },
    // short2 → work3
    { run: 60_000, expect: { c: PHASES.SHORT, n: PHASES.WORK  } },
    // work3 → short3
    { run: 60_000, expect: { c: PHASES.WORK,  n: PHASES.SHORT } },
    // short3 → work4
    { run: 60_000, expect: { c: PHASES.SHORT, n: PHASES.WORK  } },
    // work4 → long1  ← every 4th
    { run: 60_000, expect: { c: PHASES.WORK,  n: PHASES.LONG  } },
    // long1 → work5
    { run: 60_000, expect: { c: PHASES.LONG,  n: PHASES.WORK  } },
  ];
  for (const step of sequence) {
    timer.start();
    h.advance(step.run);
  }
  assert.equal(ends.length, sequence.length);
  for (let i = 0; i < sequence.length; i++) {
    assert.deepEqual(ends[i], sequence[i].expect,
      `step ${i}: expected ${JSON.stringify(sequence[i].expect)}, got ${JSON.stringify(ends[i])}`);
  }
  // 4 work phases completed (the 8th transition is LONG→WORK starting a 5th work)
  assert.equal(timer.getState().completedWork, 4);
});

test('createTimer: reset restores current phase to full duration and stops', () => {
  const h = makeHarness();
  const timer = createTimer({
    settings: { ...DEFAULT_SETTINGS, workMin: 1 },
    now: h.now, setT: h.setT, clearT: h.clearT,
  });
  timer.start();
  h.advance(30_000);
  assert.equal(timer.getState().remainingSec, 30);
  timer.reset();
  assert.equal(timer.getState().remainingSec, 60);
  assert.equal(timer.getState().running, false);
});

test('createTimer: skip advances phase without counting extra time', () => {
  const h = makeHarness();
  const ends = [];
  const timer = createTimer({
    settings: { ...DEFAULT_SETTINGS, workMin: 1 },
    now: h.now, setT: h.setT, clearT: h.clearT,
    onPhaseEnd: (c, n) => ends.push({ c, n }),
  });
  timer.skip();
  assert.equal(timer.getState().phase, PHASES.SHORT);
  assert.equal(ends.length, 1);
});

test('createTimer: updateSettings while paused re-applies duration', () => {
  const h = makeHarness();
  const timer = createTimer({
    settings: { ...DEFAULT_SETTINGS, workMin: 25 },
    now: h.now, setT: h.setT, clearT: h.clearT,
  });
  assert.equal(timer.getState().remainingSec, 25 * 60);
  timer.updateSettings({ workMin: 10 });
  assert.equal(timer.getState().remainingSec, 10 * 60);
});
