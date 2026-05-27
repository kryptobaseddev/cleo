import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyState, addTodo, editTodo, deleteTodo, toggleTodo, selectTodo,
  incrementSession, serialize, deserialize, load, save, todayKey, STORAGE_KEY,
} from '../src/store.js';

test('addTodo inserts a new todo at the top with defaults', () => {
  const s = addTodo(emptyState(), '  Write tests  ');
  assert.equal(s.todos.length, 1);
  assert.equal(s.todos[0].text, 'Write tests');
  assert.equal(s.todos[0].done, false);
  assert.equal(s.todos[0].sessions, 0);
});

test('addTodo ignores empty / whitespace', () => {
  const s0 = emptyState();
  assert.equal(addTodo(s0, '').todos.length, 0);
  assert.equal(addTodo(s0, '   ').todos.length, 0);
});

test('editTodo updates text only when new text is non-empty', () => {
  let s = addTodo(emptyState(), 'a');
  const id = s.todos[0].id;
  s = editTodo(s, id, 'b');
  assert.equal(s.todos[0].text, 'b');
  const afterEmpty = editTodo(s, id, '  ');
  assert.equal(afterEmpty.todos[0].text, 'b'); // unchanged
});

test('deleteTodo removes by id and clears selection when needed', () => {
  let s = addTodo(emptyState(), 'a');
  const id = s.todos[0].id;
  s = selectTodo(s, id);
  assert.equal(s.selectedId, id);
  s = deleteTodo(s, id);
  assert.equal(s.todos.length, 0);
  assert.equal(s.selectedId, null);
});

test('toggleTodo flips done state', () => {
  let s = addTodo(emptyState(), 'a');
  const id = s.todos[0].id;
  assert.equal(s.todos[0].done, false);
  s = toggleTodo(s, id);
  assert.equal(s.todos[0].done, true);
  s = toggleTodo(s, id);
  assert.equal(s.todos[0].done, false);
});

test('selectTodo sets selection and rejects unknown ids', () => {
  let s = addTodo(emptyState(), 'a');
  const id = s.todos[0].id;
  s = selectTodo(s, id);
  assert.equal(s.selectedId, id);
  s = selectTodo(s, 'no-such-id');
  // unknown id leaves state untouched
  assert.equal(s.selectedId, id);
  s = selectTodo(s, null);
  assert.equal(s.selectedId, null);
});

test('incrementSession bumps selected todo sessions + daily total', () => {
  let s = addTodo(emptyState(), 'a');
  const id = s.todos[0].id;
  s = selectTodo(s, id);
  s = incrementSession(s);
  assert.equal(s.todos[0].sessions, 1);
  assert.equal(s.dailyTotal.count, 1);
  s = incrementSession(s);
  assert.equal(s.todos[0].sessions, 2);
  assert.equal(s.dailyTotal.count, 2);
});

test('incrementSession rolls the daily counter on a new date', () => {
  const s0 = emptyState();
  const old = { ...s0, dailyTotal: { date: '1999-01-01', count: 99 } };
  const s1 = incrementSession(old);
  assert.equal(s1.dailyTotal.date, todayKey());
  assert.equal(s1.dailyTotal.count, 1);
});

test('serialize → deserialize round-trips state', () => {
  let s = addTodo(emptyState(), 'one');
  s = addTodo(s, 'two');
  s = selectTodo(s, s.todos[0].id);
  s = toggleTodo(s, s.todos[1].id);
  const out = deserialize(serialize(s));
  assert.deepEqual(out, s);
});

test('deserialize returns empty state on bad input', () => {
  assert.deepEqual(deserialize(null), emptyState());
  assert.deepEqual(deserialize(''), emptyState());
  assert.deepEqual(deserialize('{not json'), emptyState());
});

test('load/save round-trip via in-memory storage stub', () => {
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
  };
  let s = addTodo(emptyState(), 'persist me');
  save(s, storage);
  // Confirm key used
  assert.ok(mem.has(STORAGE_KEY));
  const roundtrip = load(storage);
  assert.equal(roundtrip.todos.length, 1);
  assert.equal(roundtrip.todos[0].text, 'persist me');
});

test('load rolls over daily total on new day', () => {
  const mem = new Map();
  mem.set(STORAGE_KEY, JSON.stringify({
    todos: [], selectedId: null,
    dailyTotal: { date: '1999-01-01', count: 42 },
  }));
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const s = load(storage);
  assert.equal(s.dailyTotal.date, todayKey());
  assert.equal(s.dailyTotal.count, 0);
});
