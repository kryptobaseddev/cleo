// tests/todos.test.js — node --test
import test from "node:test";
import assert from "node:assert/strict";
import {
  createTodo, addTodo, editTodo, deleteTodo,
  toggleTodo, incrementSession, findTodo,
} from "../lib/todos.js";

test("createTodo returns a fresh todo with required fields", () => {
  const t = createTodo("Write tests");
  assert.ok(t.id && typeof t.id === "string");
  assert.equal(t.text, "Write tests");
  assert.equal(t.completed, false);
  assert.equal(t.sessionCount, 0);
  assert.ok(Number.isFinite(t.createdAt));
});

test("createTodo trims whitespace", () => {
  const t = createTodo("  trim me   ");
  assert.equal(t.text, "trim me");
});

test("addTodo appends and returns a new array (immutable)", () => {
  const before = [];
  const after = addTodo(before, "A");
  assert.notEqual(after, before);
  assert.equal(after.length, 1);
  assert.equal(after[0].text, "A");
});

test("addTodo ignores empty input", () => {
  const list = addTodo([], "   ");
  assert.equal(list.length, 0);
});

test("editTodo changes text but preserves id, sessionCount, completed", () => {
  let list = addTodo([], "old");
  const id = list[0].id;
  list[0].sessionCount = 3;
  list[0].completed = true;
  const edited = editTodo(list, id, "new");
  assert.equal(edited[0].text, "new");
  assert.equal(edited[0].id, id);
  assert.equal(edited[0].sessionCount, 3);
  assert.equal(edited[0].completed, true);
  // immutability: original unchanged
  assert.equal(list[0].text, "old");
});

test("editTodo with empty value is a no-op", () => {
  const list = addTodo([], "keep");
  const id = list[0].id;
  const result = editTodo(list, id, "   ");
  assert.equal(result[0].text, "keep");
});

test("deleteTodo removes by id; unrelated todos unaffected", () => {
  let list = addTodo([], "A");
  list = addTodo(list, "B");
  list = addTodo(list, "C");
  const idB = list[1].id;
  const after = deleteTodo(list, idB);
  assert.equal(after.length, 2);
  assert.equal(after.find(t => t.id === idB), undefined);
  // Original list unchanged (immutable)
  assert.equal(list.length, 3);
});

test("toggleTodo flips completed and preserves other fields", () => {
  let list = addTodo([], "A");
  const id = list[0].id;
  let after = toggleTodo(list, id);
  assert.equal(after[0].completed, true);
  after = toggleTodo(after, id);
  assert.equal(after[0].completed, false);
});

test("incrementSession adds 1 to sessionCount of target todo only", () => {
  let list = addTodo([], "A");
  list = addTodo(list, "B");
  const idA = list[0].id;
  const after = incrementSession(list, idA);
  assert.equal(after[0].sessionCount, 1);
  assert.equal(after[1].sessionCount, 0);
});

test("findTodo returns the matching todo or undefined", () => {
  const list = addTodo([], "one");
  assert.equal(findTodo(list, list[0].id).text, "one");
  assert.equal(findTodo(list, "no-such-id"), undefined);
});

test("unknown id is a no-op across all mutators", () => {
  const list = addTodo([], "A");
  assert.equal(editTodo(list, "nope", "X")[0].text, "A");
  assert.equal(toggleTodo(list, "nope")[0].completed, false);
  assert.equal(deleteTodo(list, "nope").length, 1);
  assert.equal(incrementSession(list, "nope")[0].sessionCount, 0);
});
