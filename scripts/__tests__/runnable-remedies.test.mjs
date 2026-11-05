/**
 * T14300 — every remedy these refusals name runs as written.
 *
 * Each entry is a fix command a refusal emits, with the placeholder its
 * source fills in (`${taskId}`, `${epicId}`) and the file that emits it. The
 * test asserts the source still emits it, and that the command resolves
 * against the CLI command manifest with declared flags, using gate 14's own
 * registry and flag checker.
 *
 * @task T14300
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findFlagViolations,
  findViolations,
  loadRegistry,
  makeFlagChecker,
} from '../lint-injection-commands.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A template-literal placeholder as the source spells it (`${name}`). */
const slot = (name) => `$${'{'}${name}}`;

/** Refusal, the file that emits its fix, the fix as written there, and a runnable instance. */
const REMEDIES = [
  {
    code: 'review: no recorded author',
    file: 'packages/core/src/tasks/review-verdict.ts',
    source: `cleo claim ${slot('input.taskId')}`,
    command: 'cleo claim T100',
  },
  {
    code: 'E_LIFECYCLE_GATE_FAILED (no child blocks the advance)',
    file: 'packages/core/src/tasks/epic-enforcement.ts',
    source: `cleo update ${slot('epicId')} --pipeline-stage implementation`,
    command: 'cleo update T100 --pipeline-stage implementation',
  },
  {
    code: 'E_LIFECYCLE_GATE_FAILED (children block the advance)',
    file: 'packages/core/src/tasks/epic-enforcement.ts',
    source: `cleo show ${slot('epicId')}`,
    command: 'cleo show T100',
  },
  {
    code: 'E_HAS_CHILDREN (cancel)',
    file: 'packages/core/src/tasks/engine-wrap.ts',
    source: `cleo cancel ${slot('taskId')} --children cascade`,
    command: 'cleo cancel T100 --children cascade',
  },
  {
    code: 'E_HAS_CHILDREN (reparent)',
    file: 'packages/core/src/tasks/engine-wrap.ts',
    source: `cleo cancel ${slot('taskId')} --children reparent --to <epicId>`,
    command: 'cleo cancel T100 --children reparent --to T200',
  },
  {
    code: 'E_CASCADE_THRESHOLD_EXCEEDED',
    file: 'packages/core/src/tasks/engine-wrap.ts',
    source: `cleo cancel ${slot('taskId')} --children cascade --force`,
    command: 'cleo cancel T100 --children cascade --force',
  },
  {
    code: 'E_WT_IDENTITY_MISMATCH',
    file: 'packages/worktree/src/worktree-create.ts',
    source: `cleo doctor project-identity --resolve --dry-run`,
    command: 'cleo doctor project-identity --resolve --dry-run',
  },
];

describe('runnable remedies (T14300)', () => {
  const registry = loadRegistry(new Set(['doctor']), REPO_ROOT);
  const checker = makeFlagChecker(REPO_ROOT);

  for (const r of REMEDIES) {
    it(`${r.code}: ${r.command}`, () => {
      expect(readFileSync(path.join(REPO_ROOT, r.file), 'utf8')).toContain(r.source);
      expect(findViolations(r.command, registry)).toEqual([]);
      expect(findFlagViolations(r.command, checker)).toEqual([]);
    });
  }

  it('no refusal names the dispatch-param or delete syntax that cleo has no flag for', () => {
    for (const file of [
      'packages/core/src/tasks/engine-wrap.ts',
      'packages/core/src/tasks/delete-preview.ts',
    ]) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source, file).not.toMatch(/children='cascade'|--children=cascade|pass force=true/);
    }
  });

  it('the checker rejects a flag cleo cancel lacks, so the tests above can fail', () => {
    expect(findFlagViolations('cleo cancel T100 --reparentTo T200', checker)).not.toEqual([]);
  });
});
