/**
 * `cleo goal status` (T13821): reads each goal's contract and run state from
 * the goal runtime's files, read-only; reports a broken file instead of
 * failing; filters by task.
 *
 * @task T13821
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { goalStatus } from '../status.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-goal-status-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function goal(slug: string, yaml: string, run?: string): void {
  const dir = join(root, '.opencode', 'goals', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'goal.yaml'), yaml);
  if (run !== undefined) writeFileSync(join(dir, 'run.json'), run);
}

describe('goalStatus (T13821)', () => {
  it('lists each goal with its tasks (cleo.tasks + proves) and run summary, read-only', () => {
    goal(
      'ship-a',
      [
        'schema: goal/v1',
        'id: ship-a',
        'title: Ship A',
        'cleo: {tasks: [T1, {id: T2}]}',
        'criteria:',
        '  - {id: C1, statement: s, essential: true, check: {kind: verifier, ask: q}, proves: ["T3#AC1", "T1#AC2"]}',
        '',
      ].join('\n'),
      JSON.stringify({
        status: 'running',
        turn: 4,
        updatedAt: 1700000000000,
        criteria: { C1: { status: 'pass' }, C2: { status: 'claimed' }, C3: { status: 'unknown' } },
      }),
    );
    goal('not-started', 'schema: goal/v1\nid: not-started\ntitle: Later\ncleo: {tasks: [T9]}\n');
    const before = readdirSync(join(root, '.opencode', 'goals', 'ship-a')).map((f) => [
      f,
      statSync(join(root, '.opencode', 'goals', 'ship-a', f)).mtimeMs,
    ]);

    expect(goalStatus({ projectRoot: root })).toEqual([
      { slug: 'not-started', title: 'Later', tasks: ['T9'], run: null },
      {
        slug: 'ship-a',
        title: 'Ship A',
        tasks: ['T1', 'T2', 'T3'],
        run: {
          status: 'running',
          turn: 4,
          updatedAt: 1700000000000,
          criteria: { pass: 1, fail: 0, claimed: 1, unknown: 1 },
        },
      },
    ]);
    expect(goalStatus({ projectRoot: root, taskId: 'T3' }).map((g) => g.slug)).toEqual(['ship-a']);
    // Read-only: nothing written or touched.
    const after = readdirSync(join(root, '.opencode', 'goals', 'ship-a')).map((f) => [
      f,
      statSync(join(root, '.opencode', 'goals', 'ship-a', f)).mtimeMs,
    ]);
    expect(after).toEqual(before);
  });

  it('reports a file that does not parse, and is empty with no goals directory', () => {
    expect(goalStatus({ projectRoot: root })).toEqual([]);
    goal('broken', 'schema: goal/v1\nid: broken\n', '{not json');
    const [entry] = goalStatus({ projectRoot: root });
    expect(entry?.run).toBeNull();
    expect(entry?.problem).toMatch(/run.json does not parse/);
  });
});
