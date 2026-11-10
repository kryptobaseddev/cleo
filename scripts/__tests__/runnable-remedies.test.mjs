/**
 * T14300 / T14299 — every remedy these refusals name runs as written.
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
  // T14299: every code in the durability plan's F-autonomy §E table.
  {
    code: 'E_LIFECYCLE_GATE_FAILED (stage progress)',
    file: 'packages/core/src/lifecycle/engine-ops.ts',
    source: `cleo lifecycle complete ${slot('taskId')} ${slot('blocking')}`,
    command: 'cleo lifecycle complete T100 research',
  },
  {
    code: 'E_LIFECYCLE_GATE_FAILED (stage progress, skip)',
    file: 'packages/core/src/lifecycle/engine-ops.ts',
    source: `cleo lifecycle skip ${slot('taskId')} ${slot('blocking')} --reason "<why>"`,
    command: 'cleo lifecycle skip T100 research --reason "not needed"',
  },
  {
    code: 'E_EVIDENCE_TESTS_FAILED and every verify refusal',
    file: 'packages/core/src/validation/engine-ops.ts',
    source: `cleo done ${slot('taskId')} --plan`,
    command: 'cleo done T100 --plan',
  },
  // T14434: the sweep names the commands that close the task, never
  // `cleo done --plan`, which offered the refused ci:<pr> again.
  {
    code: 'merge-sweep refusal (failed merge-commit CI): testsPassed',
    file: 'packages/core/src/tasks/merge-close.ts',
    source: `cleo verify ${slot('taskId')} --gate testsPassed --evidence tool:test-affected`,
    command: 'cleo verify T100 --gate testsPassed --evidence tool:test-affected',
  },
  {
    code: 'merge-sweep refusal (failed merge-commit CI): qaPassed',
    file: 'packages/core/src/tasks/merge-close.ts',
    source: `cleo verify ${slot('taskId')} --gate qaPassed --evidence "tool:lint;tool:typecheck"`,
    command: 'cleo verify T100 --gate qaPassed --evidence "tool:lint;tool:typecheck"',
  },
  {
    code: 'merge-sweep refusal (failed merge-commit CI): complete',
    file: 'packages/core/src/tasks/merge-close.ts',
    source: `cleo complete ${slot('taskId')}`,
    command: 'cleo complete T100',
  },
  {
    code: 'merge-sweep wait (a green head run will stand in)',
    file: 'packages/core/src/tasks/merge-close.ts',
    source: `cleo done --from-merge ${slot('pr.number')}`,
    command: 'cleo done --from-merge 42',
  },
  {
    code: 'E_EVIDENCE_CONTENT_MISMATCH (criterion names no file)',
    file: 'packages/core/src/tasks/evidence.ts',
    source: `cleo review packet ${slot('prNumber')} --task ${slot('id')}`,
    command: 'cleo review packet 42 --task T100',
  },
  {
    code: 'E_SLUG_RESERVED',
    file: 'packages/cleo/src/dispatch/domains/docs.ts',
    source: `cleo docs update ${slot("slug ?? '<slug>'")} --file <your-file>`,
    command: 'cleo docs update my-doc --file notes.md',
  },
  {
    code: 'E_DOC_DUPLICATE',
    file: 'packages/core/src/docs/duplicate-check.ts',
    source: `cleo docs fetch ${slot('match.slug')} && cleo docs update ${slot('match.slug')}`,
    command: 'cleo docs fetch my-doc && cleo docs update my-doc',
  },
  {
    code: 'E_OVERRIDE_NOT_OWNER / E_OVERRIDE_FORBIDDEN_AGENT_ROLE',
    file: 'packages/core/src/security/owner-override-authority.ts',
    source: 'cleo relates add <id> T<n> duplicates',
    command: 'cleo relates add T100 T200 duplicates "covered by T200"',
  },
  {
    code: 'E_DONE_BLOCKED (dependency unresolved)',
    file: 'packages/core/src/tasks/done-plan.ts',
    source: `cleo complete ${slot('task.id')} --waive-depends "<reason>"`,
    command: 'cleo complete T100 --waive-depends "stale edge"',
  },
  {
    code: 'E_DONE_BLOCKED (epic with a cancelled child)',
    file: 'packages/core/src/tasks/done-plan.ts',
    source: `cleo done ${slot('task.id')} --waive-cancelled-children "<reason>"`,
    command: 'cleo done T100 --waive-cancelled-children "replaced by T200"',
  },
  {
    code: 'E_RESOURCE_DEFERRED',
    file: 'packages/core/src/resources/run-admission.ts',
    source: 'cleo run --wait -- <command>',
    command: 'cleo run --wait -- pnpm test',
  },
  {
    code: 'E_INTERNAL (failed store write on cancel)',
    file: 'packages/core/src/tasks/engine-wrap.ts',
    source: "'cleo doctor type-matrix'",
    command: 'cleo doctor type-matrix',
  },
];

describe('runnable remedies (T14300)', () => {
  const registry = loadRegistry(
    new Set(['backup', 'brain', 'docs', 'doctor', 'lifecycle', 'nexus', 'relates', 'review']),
    REPO_ROOT,
  );
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

  it('every command db-substrate names, suggested fixes included, exists with its flags (T14395)', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'packages/core/src/doctor/db-substrate.ts'),
      'utf8',
    );
    expect(findViolations(source, registry)).toEqual([]);
    expect(findFlagViolations(source, checker)).toEqual([]);
    // The retired fixes fail the same checks, so the two above can fail.
    expect(findViolations('Run `cleo nexus reset-project-id`', registry)).not.toEqual([]);
    expect(findFlagViolations('`cleo memory observe --task <taskId>`', checker)).not.toEqual([]);
  });

  it('the checker rejects a flag cleo cancel lacks, so the tests above can fail', () => {
    expect(findFlagViolations('cleo cancel T100 --reparentTo T200', checker)).not.toEqual([]);
  });
});
