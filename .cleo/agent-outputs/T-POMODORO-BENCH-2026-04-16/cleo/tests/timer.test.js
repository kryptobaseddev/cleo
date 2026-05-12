/**
 * Timer engine tests — cover phase durations, long-break cadence, pause/resume.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTimerState, start, pause, toggle, reset, skip,
  tick, computeRemaining, advancePhase, minutesToMs,
  phaseDurationMs, applySettings, formatMs,
} from '../src/timer.js';

const settings = { work: 25, short: 5, long: 15, cadence: 4 };

test('default phases are 25/5/15 minutes', () => {
  assert.equal(phaseDurationMs('work', settings), 25 * 60_000);
  assert.equal(phaseDurationMs('short', settings), 5 * 60_000);
  assert.equal(phaseDurationMs('long', settings), 15 * 60_000);
});

test('initial state is work phase with full duration remaining', () => {
  const s = createTimerState(settings);
  assert.equal(s.phase, 'work');
  assert.equal(s.remainingMs, 25 * 60_000);
  assert.equal(s.running, false);
  assert.equal(s.completedWorkCycles, 0);
});

test('long break occurs every 4th work cycle (cadence=4)', () => {
  let s = createTimerState(settings);
  const phases = [];
  // Advance through 8 work->break cycles and record the break type.
  for (let i = 0; i < 8; i++) {
    s = advancePhase(s, settings); // end of work -> short|long
    phases.push(s.phase);
    s = advancePhase(s, settings); // end of break -> work
  }
  // Expect: short, short, short, long, short, short, short, long
  assert.deepEqual(phases, ['short', 'short', 'short', 'long',
                            'short', 'short', 'short', 'long']);
});

test('custom cadence=3 gives long break every 3rd work cycle', () => {
  const custom = { ...settings, cadence: 3 };
  let s = createTimerState(custom);
  const phases = [];
  for (let i = 0; i < 6; i++) {
    s = advancePhase(s, custom);
    phases.push(s.phase);
    s = advancePhase(s, custom);
  }
  assert.deepEqual(phases, ['short', 'short', 'long', 'short', 'short', 'long']);
});

test('pause preserves remaining time; resume continues from there', () => {
  const t0 = 1_000_000;
  let s = createTimerState(settings);
  s = start(s, t0);
  // 10s elapsed
  s = pause(s, t0 + 10_000);
  assert.equal(s.running, false);
  assert.equal(s.remainingMs, 25 * 60_000 - 10_000);

  // Resume at later wall time
  s = start(s, t0 + 60_000);
  // After 5s more, remaining should be (25*60_000 - 10_000) - 5_000
  assert.equal(computeRemaining(s, t0 + 65_000), 25 * 60_000 - 15_000);
});

test('toggle alternates between start and pause', () => {
  const t0 = 2_000_000;
  let s = createTimerState(settings);
  s = toggle(s, t0);
  assert.equal(s.running, true);
  s = toggle(s, t0 + 1_000);
  assert.equal(s.running, false);
  assert.equal(s.remainingMs, 25 * 60_000 - 1_000);
});

test('tick auto-advances phase and emits phaseEnded event when time elapses', () => {
  const t0 = 3_000_000;
  let s = createTimerState(settings);
  s = start(s, t0);
  // Jump past the work duration
  const result = tick(s, settings, t0 + 25 * 60_000 + 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'phaseEnded');
  assert.equal(result.events[0].endedPhase, 'work');
  assert.equal(result.events[0].nextPhase, 'short');
  assert.equal(result.state.phase, 'short');
  assert.equal(result.state.running, false);
  assert.equal(result.state.completedWorkCycles, 1);
});

test('reset restores full phase duration and pauses', () => {
  const t0 = 4_000_000;
  let s = createTimerState(settings);
  s = start(s, t0);
  s = pause(s, t0 + 30_000);
  s = reset(s, settings);
  assert.equal(s.remainingMs, 25 * 60_000);
  assert.equal(s.running, false);
});

test('skip advances to next phase without waiting', () => {
  let s = createTimerState(settings);
  s = skip(s, settings);
  assert.equal(s.phase, 'short');
  assert.equal(s.remainingMs, 5 * 60_000);
  assert.equal(s.completedWorkCycles, 1);
});

test('applySettings scales remaining time proportionally', () => {
  const t0 = 5_000_000;
  let s = createTimerState(settings);
  s = start(s, t0);
  s = pause(s, t0 + 12 * 60_000 + 30_000); // 12:30 elapsed, 12:30 remaining
  // Change work to 50 minutes — remaining should scale up proportionally.
  s = applySettings(s, { ...settings, work: 50 });
  assert.equal(s.phaseMs, 50 * 60_000);
  // Original ratio was remaining/total = 750_000 / 1_500_000 = 0.5.
  // New remaining = 0.5 * 3_000_000 = 1_500_000.
  assert.equal(s.remainingMs, 1_500_000);
});

test('formatMs renders MM:SS with zero-pad and ceiling', () => {
  assert.equal(formatMs(0), '00:00');
  assert.equal(formatMs(59_999), '01:00'); // ceil
  assert.equal(formatMs(60_000), '01:00');
  assert.equal(formatMs(25 * 60_000), '25:00');
  assert.equal(formatMs(125_000), '02:05');
});

test('minutesToMs converts correctly', () => {
  assert.equal(minutesToMs(1), 60_000);
  assert.equal(minutesToMs(25), 1_500_000);
  assert.equal(minutesToMs(0), 0);
});
