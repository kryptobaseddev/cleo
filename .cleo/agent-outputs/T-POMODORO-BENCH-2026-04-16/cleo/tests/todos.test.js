/**
 * Todo CRUD tests — add/edit/delete/complete state transitions.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addTodo, editTodo, deleteTodo, toggleComplete,
  incrementSession, findTodo, newId,
} from '../src/todos.js';

test('newId produces unique values', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(newId());
  assert.equal(ids.size, 50);
});

test('addTodo appends a todo with unique id and default flags', () => {
  let list = [];
  list = addTodo(list, 'Write docs');
  list = addTodo(list, 'Ship build');
  assert.equal(list.length, 2);
  assert.equal(list[0].title, 'Write docs');
  assert.equal(list[0].done, false);
  assert.equal(list[0].sessions, 0);
  assert.notEqual(list[0].id, list[1].id);
});

test('addTodo trims whitespace and ignores empty titles', () => {
  const list = addTodo([], '   ');
  assert.equal(list.length, 0);
  const list2 = addTodo([], '  hello  ');
  assert.equal(list2[0].title, 'hello');
});

test('editTodo updates title immutably (returns new array, originals unchanged)', () => {
  const list = addTodo([], 'old title');
  const id = list[0].id;
  const edited = editTodo(list, id, 'new title');
  assert.equal(edited[0].title, 'new title');
  assert.equal(list[0].title, 'old title'); // original untouched
  assert.notStrictEqual(edited[0], list[0]); // new object ref
});

test('editTodo ignores empty/whitespace titles', () => {
  let list = addTodo([], 'keep me');
  const id = list[0].id;
  list = editTodo(list, id, '   ');
  assert.equal(list[0].title, 'keep me');
});

test('deleteTodo removes by id', () => {
  let list = addTodo([], 'a');
  list = addTodo(list, 'b');
  list = addTodo(list, 'c');
  const middleId = list[1].id;
  list = deleteTodo(list, middleId);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((t) => t.title), ['a', 'c']);
});

test('toggleComplete flips the done flag', () => {
  let list = addTodo([], 'task');
  const id = list[0].id;
  assert.equal(list[0].done, false);
  list = toggleComplete(list, id);
  assert.equal(list[0].done, true);
  list = toggleComplete(list, id);
  assert.equal(list[0].done, false);
});

test('incrementSession increments sessions counter', () => {
  let list = addTodo([], 'focus');
  const id = list[0].id;
  assert.equal(list[0].sessions, 0);
  list = incrementSession(list, id);
  list = incrementSession(list, id);
  list = incrementSession(list, id);
  assert.equal(list[0].sessions, 3);
});

test('incrementSession with unknown id is a no-op', () => {
  const list = addTodo([], 'x');
  const out = incrementSession(list, 'nonexistent');
  assert.deepEqual(out, list);
});

test('findTodo returns undefined for missing ids', () => {
  const list = addTodo([], 'a');
  assert.equal(findTodo(list, 'missing'), undefined);
  assert.equal(findTodo(list, list[0].id).title, 'a');
});

test('Full state transition lifecycle: add -> edit -> complete -> delete', () => {
  let list = addTodo([], 'initial');
  const id = list[0].id;

  list = editTodo(list, id, 'edited');
  assert.equal(list[0].title, 'edited');

  list = toggleComplete(list, id);
  assert.equal(list[0].done, true);

  list = deleteTodo(list, id);
  assert.equal(list.length, 0);
});
