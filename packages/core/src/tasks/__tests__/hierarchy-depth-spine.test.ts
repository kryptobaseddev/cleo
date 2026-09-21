/**
 * The canonical containment spine, asserted by TIER NAME.
 *
 * This file exists because the bug it guards against was invisible to every
 * existing depth test. Those tests asserted arithmetic (`parentDepth + 1 >= 3`)
 * over fixtures built by a `makeTask` helper that sets no `type`, so when
 * ADR-083 §2.5 / ADR-088 made `saga` a real `parent_id` container and pushed
 * every tier down one level, the assertions kept passing while
 * `cleo add --type subtask` became structurally unreachable in every
 * saga-rooted project. 163 `saga → epic → task → subtask` rows in CLEO's own
 * store were shapes the add path could no longer create.
 *
 * The lesson encoded here: a depth test that cannot name the tier it protects
 * cannot notice a tier being inserted above it.
 *
 * @task T12281
 */

import type { Task, TaskType } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { childTypeForParentType, exceedsMaxDepth, getDepth } from '../hierarchy.js';

const DEFAULT_MAX_DEPTH = 3;

/** Canonical spine as (id, type, parent) triples. */
const SPINE: ReadonlyArray<readonly [string, TaskType, string | null]> = [
  ['T001', 'saga', null],
  ['T002', 'epic', 'T001'],
  ['T003', 'task', 'T002'],
  ['T004', 'subtask', 'T003'],
];

function spineTasks(): Task[] {
  const now = new Date().toISOString();
  return SPINE.map(([id, type, parentId], i) => ({
    id,
    title: id,
    description: '',
    type,
    status: 'pending',
    priority: 'medium',
    size: 'medium',
    parentId,
    position: i + 1,
    positionVersion: 0,
    createdAt: now,
    updatedAt: now,
  })) as Task[];
}

describe('canonical spine depths (ADR-083 §2.5)', () => {
  it.each([
    ['saga', 'T001', 0],
    ['epic', 'T002', 1],
    ['task', 'T003', 2],
    ['subtask', 'T004', 3],
  ])('%s sits at depth %s', (_tier, id, expected) => {
    expect(getDepth(id as string, spineTasks())).toBe(expected);
  });

  it('every tier of the spine is placeable under the default cap', () => {
    const tasks = spineTasks();
    // Each node except the saga must have been legal to add under its parent.
    for (const [id, , parentId] of SPINE) {
      if (parentId === null) continue;
      expect(
        exceedsMaxDepth(getDepth(parentId, tasks), DEFAULT_MAX_DEPTH),
        `${id} under ${parentId} must be admissible`,
      ).toBe(false);
    }
  });

  it('refuses a fifth level below the subtask', () => {
    expect(exceedsMaxDepth(getDepth('T004', spineTasks()), DEFAULT_MAX_DEPTH)).toBe(true);
  });
});

describe('exceedsMaxDepth — inclusive semantics', () => {
  it.each([
    [0, false],
    [1, false],
    [2, false], // a subtask at depth 3 is legal — the case that regressed
    [3, true],
    [4, true],
  ])('parentDepth %i → exceeds=%s at maxDepth 3', (parentDepth, expected) => {
    expect(exceedsMaxDepth(parentDepth, DEFAULT_MAX_DEPTH)).toBe(expected);
  });

  it('honours a raised cap from config', () => {
    expect(exceedsMaxDepth(3, 4)).toBe(false);
    expect(exceedsMaxDepth(4, 4)).toBe(true);
  });
});

describe('childTypeForParentType', () => {
  it.each([
    ['saga', 'epic'],
    ['epic', 'task'],
    ['task', 'subtask'],
  ])('a typeless child of a %s is a %s', (parent, expected) => {
    expect(childTypeForParentType(parent as TaskType)).toBe(expected);
  });

  it.each([
    ['saga', 'saga'],
    ['epic', 'epic'],
  ])('%s keeps its tier wherever it is moved', (current, expected) => {
    expect(childTypeForParentType('saga', current as TaskType)).toBe(expected);
  });

  it('does NOT promote an existing task to an epic when reparented under a saga', () => {
    // The saga branch is create-only. Returning 'epic' for a node that already
    // has a tier would satisfy the containment matrix by silently rewriting the
    // node instead of refusing the move.
    expect(childTypeForParentType('saga', 'task')).toBe('task');
  });

  it('demotes a subtask promoted to root back to a task', () => {
    expect(childTypeForParentType(null, 'subtask')).toBe('task');
  });
});
