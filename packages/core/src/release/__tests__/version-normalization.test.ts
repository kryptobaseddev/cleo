/**
 * Version normalisation + provenance diagnostics (gh#1440).
 *
 * Two defects found cutting v2026.9.4, neither of which blocked the release —
 * which is exactly why they went unnoticed: provenance was simply never
 * backfilled, silently.
 *
 * 1. `cleo release plan 2026.9.4` normalised and wrote
 *    `.cleo/release/v2026.9.4.plan.json`; `cleo release reconcile 2026.9.4`
 *    took its argument verbatim and looked for `2026.9.4.plan.json`. The
 *    resulting `fix` told the operator to run the plan command that had just
 *    succeeded and produced the file reconcile could not see.
 * 2. With the plan found, the insert failed with an EMPTY `fix` and a message
 *    that truncated before the driver's reason.
 *
 * @task gh#1440
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { causeChainMessages, releaseReconcileV2 } from '../reconcile.js';
import { normalizeVersion } from '../version.js';

describe('normalizeVersion (gh#1440)', () => {
  it('adds the v prefix to a bare version', () => {
    expect(normalizeVersion('2026.9.4')).toBe('v2026.9.4');
  });

  it('is idempotent — an already-prefixed version is unchanged', () => {
    expect(normalizeVersion('v2026.9.4')).toBe('v2026.9.4');
  });

  it('normalises both operator spellings to the same string', () => {
    // The whole defect in one assertion: `plan` and `reconcile` must agree
    // about what file a version names.
    expect(normalizeVersion('2026.9.4')).toBe(normalizeVersion('v2026.9.4'));
  });
});

describe('release reconcile resolves a bare version to the v-prefixed plan (gh#1440)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /**
   * A project root with a `.cleo/release/` dir and no plan files.
   *
   * The `git init` is load-bearing: `resolveCleoDir` requires a `.cleo`
   * directory WITH a sibling `.git`, and rejects the root outright otherwise.
   * Without it the fixture fails at project resolution with
   * `E_INVALID_PROJECT_ROOT` — before reconcile reaches the normalisation these
   * tests exist to check, so the assertions would fail for a reason that has
   * nothing to do with what is under test.
   */
  function emptyProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'reconcile-version-'));
    dirs.push(root);
    mkdirSync(join(root, '.cleo', 'release'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    return root;
  }

  it('looks for the v-prefixed filename when given a bare version', async () => {
    const root = emptyProject();
    const res = await releaseReconcileV2('9999.1.1', { projectRoot: root });

    expect(res.success).toBe(false);
    if (res.success) return;
    // The assertion that would have caught the defect: the path the reader
    // reports must be the path the writer produces.
    expect(res.error.message).toContain('v9999.1.1.plan.json');
    expect(res.error.message).not.toContain('/9999.1.1.plan.json');
  });

  it('treats both spellings as the same release', async () => {
    const root = emptyProject();
    const bare = await releaseReconcileV2('9999.1.1', { projectRoot: root });
    const prefixed = await releaseReconcileV2('v9999.1.1', { projectRoot: root });

    expect(bare.success).toBe(false);
    expect(prefixed.success).toBe(false);
    if (bare.success || prefixed.success) return;
    expect(bare.error.message).toBe(prefixed.error.message);
  });

  it('does not leave the caller a fix that loops', async () => {
    const root = emptyProject();
    const res = await releaseReconcileV2('9999.1.1', { projectRoot: root });
    expect(res.success).toBe(false);
    if (res.success) return;
    // The fix must name the same spelling the reader will look for next time.
    // Previously it said `plan 2026.9.4`, which wrote the v-prefixed name and
    // left reconcile looking for the bare one — forever.
    const fix = String(res.error.fix ?? '');
    if (fix.length > 0) expect(fix).toContain('v9999.1.1');
  });

  it('the fixture is resolvable AND genuinely has no plan file — the control', () => {
    // Two separate properties, both required. The first is what CI caught: a
    // fixture missing `.git` is rejected at project resolution, so every
    // assertion above would fail for a reason unrelated to versions.
    const root = emptyProject();
    expect(existsSync(join(root, '.git'))).toBe(true);
    expect(existsSync(join(root, '.cleo'))).toBe(true);
    expect(existsSync(join(root, '.cleo', 'release', 'v9999.1.1.plan.json'))).toBe(false);
    expect(existsSync(join(root, '.cleo', 'release', '9999.1.1.plan.json'))).toBe(false);
  });
});

describe('causeChainMessages — the driver reason must reach the envelope (gh#1440)', () => {
  it('walks nested causes outermost-first', () => {
    const root = new Error('NOT NULL constraint failed: tasks_releases.merge_commit_sha');
    const mid = new Error('Failed query: insert into "tasks_releases" (...)', { cause: root });
    const outer = new Error('transaction aborted', { cause: mid });

    expect(causeChainMessages(outer)).toEqual([
      'transaction aborted',
      'Failed query: insert into "tasks_releases" (...)',
      'NOT NULL constraint failed: tasks_releases.merge_commit_sha',
    ]);
  });

  it('keeps the driver reason last, where the caller reads it as the root', () => {
    // The reported symptom: the outer message is 31 column names and a
    // parameter blob, and the one sentence saying what was wrong was dropped.
    const root = new Error('CHECK constraint failed');
    const outer = new Error('Failed query: insert into ... params: a,b,c', { cause: root });
    const chain = causeChainMessages(outer);
    expect(chain[chain.length - 1]).toBe('CHECK constraint failed');
  });

  it('handles a single error with no cause', () => {
    expect(causeChainMessages(new Error('solo'))).toEqual(['solo']);
  });

  it('handles a non-Error throw', () => {
    expect(causeChainMessages('a string')).toEqual(['a string']);
  });

  it('de-duplicates identical messages in the chain', () => {
    const inner = new Error('same');
    const outer = new Error('same', { cause: inner });
    expect(causeChainMessages(outer)).toEqual(['same']);
  });

  it('terminates on a cyclic cause rather than hanging', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(causeChainMessages(a)).toEqual(['a', 'b']);
  });

  it('respects the depth limit', () => {
    let err = new Error('depth-0');
    for (let i = 1; i < 20; i++) err = new Error(`depth-${i}`, { cause: err });
    expect(causeChainMessages(err, 3)).toHaveLength(3);
  });
});
