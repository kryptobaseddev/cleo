/**
 * T13554 — `evidence.runtimePaths`: tracked files a harness rewrites during a
 * run stay out of the evidence tree hash, so the run cannot stale its own
 * receipt, while a protected input (goal.yaml, an oracle, a typed gate input)
 * can never be declared away.
 *
 * Receipt freshness is tree equality: `cleo complete` refuses a test-run atom
 * once `captureTreeHash` no longer equals its recorded `treeHash`.
 *
 * @task T13554
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureTree, captureTreeHash, E_EVIDENCE_RUNTIME_PATH_PROTECTED } from '../tool-cache.js';

const RUN = '.opencode/goals/g1/run.json';
const LEDGER = '.opencode/goals/g1/ledger.jsonl';
const GOAL = '.opencode/goals/g1/goal.yaml';

let root: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' });
}

function put(rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** A repo whose default branch (origin/main) declares `runtimePaths`. */
function repo(runtimePaths: readonly string[] | null): void {
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  put(
    '.cleo/project-context.json',
    JSON.stringify(runtimePaths === null ? {} : { evidence: { runtimePaths } }),
  );
  put(RUN, '{"step":0}\n');
  put(LEDGER, '');
  put(GOAL, 'goal: one\n');
  put('src/a.ts', 'export const a = 1;\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime-paths-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('evidence.runtimePaths in the tree hash (T13554)', () => {
  it('a rewritten declared runtime file keeps the tree; goal.yaml and source still move it', async () => {
    repo(['.opencode/goals/*/run.json', '.opencode/goals/*/ledger.jsonl']);
    const before = await captureTreeHash(root);
    put(RUN, '{"step":7}\n');
    put(LEDGER, '{"event":"pass"}\n');
    const during = await captureTree(root);
    expect(during.tree).toBe(before);
    expect([...during.runtimeExcluded].sort()).toEqual([LEDGER, RUN]);
    // An untracked file under a declared glob is runtime too.
    put('.opencode/goals/g2/run.json', '{}\n');
    expect(await captureTreeHash(root)).toBe(before);

    put(GOAL, 'goal: two\n');
    expect(await captureTreeHash(root)).not.toBe(before);
    put(GOAL, 'goal: one\n');
    put('src/a.ts', 'export const a = 2;\n');
    expect(await captureTreeHash(root)).not.toBe(before);
  });

  it('declares nothing by default: every tracked edit counts', async () => {
    repo(null);
    const before = await captureTreeHash(root);
    put(RUN, '{"step":7}\n');
    const after = await captureTree(root);
    expect(after.tree).not.toBe(before);
    expect(after.runtimeExcluded).toEqual([]);
    expect(after.refusal).toBeUndefined();
  });

  it('a declaration only in the working copy (not on the default branch) is not applied', async () => {
    repo(null);
    const before = await captureTreeHash(root);
    put(
      '.cleo/project-context.json',
      JSON.stringify({ evidence: { runtimePaths: ['.opencode/goals/*/run.json'] } }),
    );
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'declare on the branch only']);
    const declared = await captureTreeHash(root);
    put(RUN, '{"step":7}\n');
    expect(await captureTreeHash(root)).not.toBe(declared);
    expect(declared).not.toBe(before);
  });

  it('refuses a glob covering goal.yaml, and then leaves nothing out', async () => {
    repo(['.opencode/goals/**']);
    const before = await captureTreeHash(root);
    put(RUN, '{"step":7}\n');
    const capture = await captureTree(root);
    expect(capture.refusal?.codeName).toBe(E_EVIDENCE_RUNTIME_PATH_PROTECTED);
    expect(capture.refusal?.reason).toContain(GOAL);
    expect(capture.runtimeExcluded).toEqual([]);
    expect(capture.tree).not.toBe(before);
  });

  it('refuses a glob covering an oracle or a typed gate input', async () => {
    repo(['.opencode/goals/*/run.json', 'checks/*']);
    put('checks/oracle.mjs', 'process.exit(0);\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'oracle']);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    expect((await captureTree(root)).refusal?.reason).toContain('checks/oracle.mjs');

    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'runtime-paths-'));
    repo(['.opencode/goals/*/run.json']);
    const refused = await captureTree(root, [RUN]);
    expect(refused.refusal?.codeName).toBe(E_EVIDENCE_RUNTIME_PATH_PROTECTED);
    expect(refused.refusal?.reason).toContain(RUN);
  });
});
