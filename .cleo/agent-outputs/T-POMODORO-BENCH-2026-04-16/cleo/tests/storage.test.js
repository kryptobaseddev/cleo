/**
 * localStorage round-trip tests — serialize/write/read/deserialize/equal.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadState, saveState, defaultState, mergeWithDefaults,
  createMemoryStore, STORAGE_KEY, SCHEMA_VERSION,
} from '../src/storage.js';
import { addTodo, toggleComplete } from '../src/todos.js';

test('loadState returns defaults from an empty store', () => {
  const store = createMemoryStore();
  const state = loadState(store);
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(state.todos, []);
  assert.equal(state.settings.work, 25);
  assert.equal(state.settings.short, 5);
  assert.equal(state.settings.long, 15);
  assert.equal(state.settings.cadence, 4);
  assert.equal(state.counters.dailyCount, 0);
});

test('loadState returns defaults when storage value is malformed', () => {
  const store = createMemoryStore({ [STORAGE_KEY]: 'not json{' });
  const state = loadState(store);
  assert.deepEqual(state.todos, []);
  assert.equal(state.settings.work, 25);
});

test('round-trip: save then load yields equal-shaped state', () => {
  const store = createMemoryStore();
  const original = defaultState();
  original.todos = addTodo(original.todos, 'first');
  original.todos = addTodo(original.todos, 'second');
  original.todos = toggleComplete(original.todos, original.todos[0].id);
  original.settings.work = 30;
  original.settings.short = 7;
  original.counters.dailyCount = 4;
  original.counters.dailyDate = '2026-04-15';
  original.selectedTodoId = original.todos[1].id;
  original.theme = 'dark';

  saveState(store, original);
  const roundTripped = loadState(store);

  assert.deepEqual(roundTripped.todos, original.todos);
  assert.deepEqual(roundTripped.settings, original.settings);
  assert.deepEqual(roundTripped.counters, original.counters);
  assert.equal(roundTripped.selectedTodoId, original.selectedTodoId);
  assert.equal(roundTripped.theme, original.theme);
  assert.equal(roundTripped.schemaVersion, SCHEMA_VERSION);
});

test('saveState persists schemaVersion regardless of input', () => {
  const store = createMemoryStore();
  const state = { ...defaultState(), schemaVersion: 'wrong' };
  saveState(store, state);
  const raw = store.getItem(STORAGE_KEY);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
});

test('mergeWithDefaults fills in missing fields', () => {
  const partial = { todos: [{ id: 'x', title: 't', done: false, sessions: 0, createdAt: 1 }] };
  const merged = mergeWithDefaults(partial);
  assert.equal(merged.settings.work, 25);
  assert.equal(merged.settings.cadence, 4);
  assert.equal(merged.theme, 'auto');
  assert.deepEqual(merged.todos, partial.todos);
});

test('memory store has localStorage-compatible API', () => {
  const store = createMemoryStore();
  assert.equal(store.getItem('missing'), null);
  store.setItem('k', 'v');
  assert.equal(store.getItem('k'), 'v');
  store.removeItem('k');
  assert.equal(store.getItem('k'), null);
  store.setItem('a', '1');
  store.setItem('b', '2');
  assert.equal(store.length, 2);
  store.clear();
  assert.equal(store.length, 0);
});
