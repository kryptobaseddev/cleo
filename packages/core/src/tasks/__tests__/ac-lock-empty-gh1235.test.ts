/**
 * Regression tests for gh#1235 item 1 — "a write can report success and do
 * nothing: empty-task AC lock".
 *
 * `enforceAcceptanceImmutability` had four early-returns and no case for "the
 * existing acceptance list is empty". So a task that reached a locked pipeline
 * stage with no acceptance criteria was locked against ever gaining any — and
 * the error told the operator that "reframing AC after implementation is
 * anti-pattern" about criteria that did not exist.
 *
 * The guard exists to stop criteria being REFRAMED once you know what you
 * built. A task with no criteria has no goalposts to move, so supplying them
 * for the first time is what the acceptance model wants, not what it protects
 * against. Without the empty case the guard inverted its own purpose.
 *
 * The only escape was `--reason`, which writes an audit record asserting a
 * deliberate override of a protection that was never protecting anything —
 * accruing audit entries that mean nothing, which is how an audit trail stops
 * being read.
 *
 * @task T12153 (gh#1235)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enforceAcceptanceImmutability } from '../ac-immutability.js';

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'gh1235-ac-'));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/** A task in a LOCKED pipeline stage, with whatever acceptance is given. */
function lockedTask(acceptance: unknown): Task {
  return {
    id: 'T001',
    title: 'locked task',
    pipelineStage: 'implementation',
    acceptance,
  } as unknown as Task;
}

describe('gh#1235 — a task with NO acceptance criteria can gain its first', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty array', []],
    ['blank strings only', ['', '   ']],
  ])('does not throw when the existing acceptance is %s', (_label, existing) => {
    // THE regression test. Before the fix every one of these threw
    // ExitCode.AC_LOCKED, demanding --reason to justify overriding a
    // protection that had nothing to protect.
    expect(() =>
      enforceAcceptanceImmutability({
        task: lockedTask(existing),
        newAcceptance: ['first criterion', 'second criterion'],
        projectRoot,
      }),
    ).not.toThrow();
  });
});

describe('gh#1235 — the guard still protects criteria that EXIST', () => {
  it('throws without a reason when real criteria would be reframed', () => {
    // Guards against over-correcting: the whole point of the guard must
    // survive. A task WITH criteria in a locked stage still cannot have them
    // rewritten silently.
    expect(() =>
      enforceAcceptanceImmutability({
        task: lockedTask(['the original criterion']),
        newAcceptance: ['a different criterion'],
        projectRoot,
      }),
    ).toThrow(/locked/i);
  });

  it('still accepts an explicit --reason override on a non-empty task', () => {
    expect(() =>
      enforceAcceptanceImmutability({
        task: lockedTask(['the original criterion']),
        newAcceptance: ['a different criterion'],
        reason: 'scope corrected with owner approval',
        projectRoot,
      }),
    ).not.toThrow();
  });

  it('a structured gate is never treated as blank', () => {
    // An AcceptanceGate object carries kind + payload; only a whitespace-only
    // STRING is an absent criterion. Otherwise a task whose criteria are all
    // structured gates would lose the guard entirely.
    expect(() =>
      enforceAcceptanceImmutability({
        task: lockedTask([{ kind: 'test', expect: 'pass' }]),
        newAcceptance: ['replaced with prose'],
        projectRoot,
      }),
    ).toThrow(/locked/i);
  });
});
