/**
 * `cleo goal status` (T13821): drafted goals come from their goal.yaml; the
 * live run comes only from `cleo-goal status --json` (an unknown schema
 * version is refused); a missing bin reports `not-installed` with the install
 * commands; runtime internals such as run.json are never read.
 *
 * @task T13821
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { draftedGoals, goalStatus } from '../status.js';

let base: string;
let root: string;
let bin: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cleo-goal-status-'));
  root = join(base, 'project');
  bin = join(base, 'bin');
  mkdirSync(root, { recursive: true });
  mkdirSync(bin, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function goal(slug: string, yaml: string): void {
  const dir = join(root, '.opencode', 'goals', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'goal.yaml'), yaml);
  // A runtime-internal file CLEO must never read.
  writeFileSync(join(dir, 'run.json'), '{"status":"from-run-json"}');
}

/** A fake `cleo-goal` bin answering `status --json` with `body`. */
function fakeBin(body: object): void {
  const path = join(bin, 'cleo-goal');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(body)}'\n`);
  chmodSync(path, 0o755);
}

const LIVE = {
  schemaVersion: 1,
  goal: 'ship-a',
  runId: 'r1',
  title: 'Ship A',
  status: 'running',
  turn: 4,
  reason: null,
  criteria: [],
  proven: 1,
  total: 3,
  budget: { ratio: 0.2, parts: [] },
  verdict: null,
  blocker: null,
  updatedAt: 1700000000000,
};

describe('goalStatus (T13821)', () => {
  beforeEach(() => {
    goal(
      'ship-a',
      [
        'schema: goal/v1',
        'id: ship-a',
        'title: Ship A',
        'cleo: {tasks: [T1, {id: T2}]}',
        'criteria:',
        '  - {id: C1, statement: s, essential: true, check: {kind: verifier, ask: q}, proves: ["T3#AC1"]}',
        '',
      ].join('\n'),
    );
    goal('later', 'schema: goal/v1\nid: later\ntitle: Later\ncleo: {tasks: [T9]}\n');
  });

  it('drafted goals list the tasks from cleo.tasks and proves', () => {
    expect(draftedGoals(root)).toEqual([
      { slug: 'later', title: 'Later', tasks: ['T9'] },
      { slug: 'ship-a', title: 'Ship A', tasks: ['T1', 'T2', 'T3'] },
    ]);
  });

  it('reads the live run only through cleo-goal status --json; --task scopes it', () => {
    fakeBin(LIVE);
    const r = goalStatus({ projectRoot: root, env: { PATH: bin } });
    if (!r.success) throw new Error(r.error.message);
    expect(r.data.runtime).toBe('installed');
    expect(r.data.live).toEqual(LIVE);
    expect(JSON.stringify(r.data)).not.toContain('from-run-json');
    const scoped = goalStatus({ projectRoot: root, taskId: 'T9', env: { PATH: bin } });
    if (!scoped.success) throw new Error(scoped.error.message);
    expect(scoped.data.goals.map((g) => g.slug)).toEqual(['later']);
    expect(scoped.data.live).toBeNull();
  });

  it('refuses a status schema version it does not recognise', () => {
    fakeBin({ ...LIVE, schemaVersion: 2 });
    const r = goalStatus({ projectRoot: root, env: { PATH: bin } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('E_GOAL_RUNTIME_SCHEMA');
  });

  it('a missing bin reports not-installed with the install commands', () => {
    const r = goalStatus({ projectRoot: root, env: { PATH: bin } });
    if (!r.success) throw new Error(r.error.message);
    expect(r.data).toMatchObject({
      runtime: 'not-installed',
      install: ['npm i -g @cleocode/goal@latest', 'cleo goal install --harness opencode'],
      live: null,
    });
    expect(r.data.goals).toHaveLength(2);
  });
});
