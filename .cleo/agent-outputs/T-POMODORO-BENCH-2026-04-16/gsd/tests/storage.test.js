// tests/storage.test.js — node --test
import test from "node:test";
import assert from "node:assert/strict";
import {
  STORAGE_KEY, DEFAULTS, load, save, clear,
  rolloverDailyTotal, todayISO,
} from "../lib/storage.js";

/** Minimal localStorage polyfill. */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
    _map: map,
  };
}

test("load returns DEFAULTS when storage is empty", () => {
  const s = makeStorage();
  const out = load(s);
  assert.deepEqual(out, DEFAULTS);
  // But must not be same reference as DEFAULTS (no mutation leak)
  assert.notEqual(out, DEFAULTS);
});

test("load returns DEFAULTS when storage is absent/null", () => {
  const out = load(null);
  assert.deepEqual(out, DEFAULTS);
});

test("load returns DEFAULTS when stored JSON is corrupt", () => {
  const s = makeStorage({ [STORAGE_KEY]: "{{not json" });
  const out = load(s);
  assert.deepEqual(out, DEFAULTS);
});

test("save + load round-trip preserves state deeply", () => {
  const s = makeStorage();
  const input = {
    todos: [
      { id: "a", text: "write tests", completed: false, sessionCount: 2, createdAt: 1 },
      { id: "b", text: "ship it",     completed: true,  sessionCount: 0, createdAt: 2 },
    ],
    settings: { work: 20, short: 4, long: 10 },
    counters: { a: 2 },
    dailyTotal: 3,
    dailyTotalDate: "2026-04-15",
    selectedId: "a",
    theme: "dark",
  };
  assert.equal(save(input, s), true);
  const out = load(s);
  assert.deepEqual(out, input);
});

test("save is resilient to throwing storage", () => {
  const throwingStorage = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("quota"); },
    removeItem() { throw new Error("denied"); },
  };
  assert.equal(save({ foo: 1 }, throwingStorage), false);
  assert.deepEqual(load(throwingStorage), DEFAULTS);
});

test("load merges partial settings against defaults", () => {
  const s = makeStorage({
    [STORAGE_KEY]: JSON.stringify({
      todos: [],
      settings: { work: 50 }, // missing short + long
    }),
  });
  const out = load(s);
  assert.equal(out.settings.work, 50);
  assert.equal(out.settings.short, DEFAULTS.settings.short);
  assert.equal(out.settings.long, DEFAULTS.settings.long);
});

test("clear removes the stored state", () => {
  const s = makeStorage();
  save({ foo: 1 }, s);
  clear(s);
  assert.equal(s.getItem(STORAGE_KEY), null);
});

test("todayISO returns YYYY-MM-DD", () => {
  const iso = todayISO(new Date("2026-04-15T10:20:30"));
  assert.equal(iso, "2026-04-15");
});

test("rolloverDailyTotal resets total when date is stale", () => {
  const s = { ...DEFAULTS, dailyTotal: 5, dailyTotalDate: "1999-01-01" };
  const out = rolloverDailyTotal(s, new Date("2026-04-15T12:00"));
  assert.equal(out.dailyTotal, 0);
  assert.equal(out.dailyTotalDate, "2026-04-15");
});

test("rolloverDailyTotal keeps total when date matches today", () => {
  const today = todayISO(new Date("2026-04-15T00:00"));
  const s = { ...DEFAULTS, dailyTotal: 7, dailyTotalDate: today };
  const out = rolloverDailyTotal(s, new Date("2026-04-15T23:00"));
  assert.equal(out.dailyTotal, 7);
  assert.equal(out.dailyTotalDate, today);
});
