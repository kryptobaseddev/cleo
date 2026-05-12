import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTimer, PHASES } from '../src/timer.js';
import {
  emptyState, addTodo, selectTodo, incrementSession, save, load, STORAGE_KEY,
} from '../src/store.js';

/** Fake timer harness (same as timer.test.mjs — duplicated for independence). */
function makeHarness() {
  let nowMs = 0;
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

test('end-to-end: completing a work phase increments the selected todo + daily total, and persists', () => {
  // Fake localStorage
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
  };

  // Start state — one todo selected
  let state = addTodo(emptyState(), 'write docs');
  const id = state.todos[0].id;
  state = selectTodo(state, id);
  save(state, storage);

  // Timer with 1-min work for speed
  const h = makeHarness();
  const timer = createTimer({
    settings: { workMin: 1, shortMin: 1, longMin: 1, longEvery: 4, chime: false },
    now: h.now, setT: h.setT, clearT: h.clearT,
    onPhaseEnd: (completed) => {
      if (completed === PHASES.WORK) {
        state = incrementSession(state);
        save(state, storage);
      }
    },
  });

  timer.start();
  h.advance(60_000); // complete work1
  assert.equal(state.todos[0].sessions, 1);
  assert.equal(state.dailyTotal.count, 1);

  // Reload from "disk" and confirm persistence
  const reloaded = load(storage);
  assert.equal(reloaded.todos.length, 1);
  assert.equal(reloaded.todos[0].sessions, 1);
  assert.equal(reloaded.dailyTotal.count, 1);

  // Confirm raw stored JSON contains our stable key
  assert.ok(mem.has(STORAGE_KEY));
});

test('end-to-end: 4 complete work phases record 4 sessions and trigger LONG break', () => {
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
  };
  let state = addTodo(emptyState(), 'study');
  state = selectTodo(state, state.todos[0].id);

  const h = makeHarness();
  const phasesEnded = [];
  const timer = createTimer({
    settings: { workMin: 1, shortMin: 1, longMin: 1, longEvery: 4, chime: false },
    now: h.now, setT: h.setT, clearT: h.clearT,
    onPhaseEnd: (completed, next) => {
      phasesEnded.push({ completed, next });
      if (completed === PHASES.WORK) {
        state = incrementSession(state);
        save(state, storage);
      }
    },
  });

  // Run 4 work phases + interleaved short breaks (4 works, 3 shorts) then long
  for (let i = 0; i < 7; i++) {
    timer.start();
    h.advance(60_000);
  }

  // We expect the 7th phase-end to be WORK→LONG
  const lastWorkEnd = phasesEnded.filter(p => p.completed === PHASES.WORK).pop();
  assert.equal(lastWorkEnd.next, PHASES.LONG);
  assert.equal(state.todos[0].sessions, 4);
  assert.equal(state.dailyTotal.count, 4);
});
