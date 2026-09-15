/**
 * Unit tests for validate-spawn-readiness hygiene runner (T10451).
 *
 * gh#1367 coverage drives a REAL subprocess through `execSync` rather than
 * mocking it. The defect was that a `timeout` and a non-zero exit were reported
 * with one message, and those two facts are produced by node's process plumbing
 * — a mock would assert the error shape I *believe* execSync throws, which is
 * the same side of the question as the code under test. The fixtures below are
 * a script that sleeps and a script that exits 1; node decides what each throws.
 *
 * @task T10451
 * @task gh#1366 — the readiness result is a value callers can branch on
 * @task gh#1367 — a timeout is not a validation failure
 * @saga T10431
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANGESET_LINT_TIMEOUT_ENV,
  DEFAULT_CHANGESET_LINT_TIMEOUT_MS,
  resolveChangesetLintTimeoutMs,
  runSpawnReadinessHygiene,
  runSpawnReadinessHygieneCli,
} from '../validate-spawn-readiness.js';

describe('runSpawnReadinessHygiene', () => {
  const tmpDir = join(process.cwd(), 'tmp-hygiene-test');

  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns allPassed=false when CHANGELOG.md is missing', async () => {
    const result = await runSpawnReadinessHygiene(tmpDir);
    expect(result.allPassed).toBe(false);
    const changelogGate = result.gates.find((g) => g.name === 'changelog-drift');
    expect(changelogGate?.passed).toBe(false);
  });

  it('returns allPassed=false when CHANGELOG.md has no version header', async () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\nSome text\n');
    const result = await runSpawnReadinessHygiene(tmpDir);
    expect(result.allPassed).toBe(false);
    const changelogGate = result.gates.find((g) => g.name === 'changelog-drift');
    expect(changelogGate?.passed).toBe(false);
  });

  it('passes changelog-drift when CHANGELOG.md has valid header', async () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '## [2026.5.120] (2026-05-24)\n\nChanges\n');
    const result = await runSpawnReadinessHygiene(tmpDir);
    const changelogGate = result.gates.find((g) => g.name === 'changelog-drift');
    expect(changelogGate?.passed).toBe(true);
  });

  it('skips worktree-location gate when no worktreePath provided', async () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '## [2026.5.120] (2026-05-24)\n\nChanges\n');
    const result = await runSpawnReadinessHygiene(tmpDir);
    const worktreeGate = result.gates.find((g) => g.name === 'worktree-location');
    expect(worktreeGate?.passed).toBe(true);
    expect(worktreeGate?.message).toContain('skipping');
  });

  it('fails worktree-location when cwd does not match expected path', async () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '## [2026.5.120] (2026-05-24)\n\nChanges\n');
    const result = await runSpawnReadinessHygiene(tmpDir, '/nonexistent/worktree');
    const worktreeGate = result.gates.find((g) => g.name === 'worktree-location');
    expect(worktreeGate?.passed).toBe(false);
  });

  it('includes checkedAt timestamp', async () => {
    const result = await runSpawnReadinessHygiene(tmpDir);
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gh#1367 — a timeout and a validation failure are different facts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a throwaway project root containing a `scripts/lint-changesets.mjs`
 * with the given body, plus a valid CHANGELOG.md so the changelog gate is not
 * a confound in changeset-gate assertions.
 *
 * @param body - JavaScript source for the fake lint script.
 * @returns Absolute path to the created project root.
 */
function makeProjectWithLintScript(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hygiene-gate-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'lint-changesets.mjs'), body, 'utf-8');
  writeFileSync(join(root, 'CHANGELOG.md'), '## [2026.9.4] (2026-09-14)\n', 'utf-8');
  return root;
}

describe('changeset-lint gate — timeout vs validation (gh#1367)', () => {
  const created: string[] = [];
  const originalEnv = process.env[CHANGESET_LINT_TIMEOUT_ENV];

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env[CHANGESET_LINT_TIMEOUT_ENV];
    else process.env[CHANGESET_LINT_TIMEOUT_ENV] = originalEnv;
  });

  it('reports a TIMEOUT as reason="timeout", never as a lint failure', async () => {
    // A script that cannot finish inside the bound. Real subprocess, real
    // SIGTERM from node's own timeout plumbing.
    const root = makeProjectWithLintScript('setTimeout(() => {}, 30_000);\n');
    created.push(root);
    process.env[CHANGESET_LINT_TIMEOUT_ENV] = '400';

    const result = await runSpawnReadinessHygiene(root);
    const gate = result.gates.find((g) => g.name === 'changeset-lint');

    expect(gate?.passed).toBe(false);
    expect(gate?.reason).toBe('timeout');
    // The exact misdirection from the issue: the operator must NOT be told
    // their changesets are malformed when none were even examined.
    expect(gate?.message).not.toContain('Changeset lint failed');
    expect(gate?.message).toContain('timeout');
    expect(gate?.message).toContain('400');
  });

  it('reports a genuine non-zero exit as reason="validation"', async () => {
    const root = makeProjectWithLintScript(
      'process.stderr.write("bad-entry.md: unknown kind\\n");\nprocess.exit(1);\n',
    );
    created.push(root);

    const result = await runSpawnReadinessHygiene(root);
    const gate = result.gates.find((g) => g.name === 'changeset-lint');

    expect(gate?.passed).toBe(false);
    expect(gate?.reason).toBe('validation');
    expect(gate?.message).toContain('Changeset lint failed');
  });

  it('passes a clean lint run', async () => {
    const root = makeProjectWithLintScript('process.exit(0);\n');
    created.push(root);

    const result = await runSpawnReadinessHygiene(root);
    const gate = result.gates.find((g) => g.name === 'changeset-lint');

    expect(gate?.passed).toBe(true);
    expect(gate?.reason).toBeUndefined();
  });

  it('reports a missing lint script as reason="not-found", not as a lint failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hygiene-gate-'));
    created.push(root);

    const result = await runSpawnReadinessHygiene(root);
    const gate = result.gates.find((g) => g.name === 'changeset-lint');

    expect(gate?.passed).toBe(false);
    expect(gate?.reason).toBe('not-found');
  });
});

describe('resolveChangesetLintTimeoutMs (gh#1367)', () => {
  it('defaults when unset or blank', () => {
    expect(resolveChangesetLintTimeoutMs({})).toEqual({
      ok: true,
      ms: DEFAULT_CHANGESET_LINT_TIMEOUT_MS,
    });
    expect(resolveChangesetLintTimeoutMs({ [CHANGESET_LINT_TIMEOUT_ENV]: '   ' })).toEqual({
      ok: true,
      ms: DEFAULT_CHANGESET_LINT_TIMEOUT_MS,
    });
  });

  it('honours a valid positive integer override', () => {
    expect(resolveChangesetLintTimeoutMs({ [CHANGESET_LINT_TIMEOUT_ENV]: '5000' })).toEqual({
      ok: true,
      ms: 5000,
    });
  });

  it('REJECTS an invalid override instead of silently using the default', () => {
    // Silently substituting the default is how a bound ends up measuring
    // something the operator never asked for.
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const r = resolveChangesetLintTimeoutMs({ [CHANGESET_LINT_TIMEOUT_ENV]: bad });
      expect(r.ok, `expected ${bad} to be rejected`).toBe(false);
    }
  });

  it('keeps the bound TIGHT — a widened bound would spend a real signal', () => {
    // gh#1367 argued for raising this from a 91 s measurement. That number was
    // taken on an ntfs-3g mount and measured the filesystem: re-measured over
    // 315 entries (more than the original 275), the script takes 0.54 s on the
    // canonical btrfs checkout and 1.60 s on a GitHub Actions runner. Against
    // 10 s that is 6-18x of headroom.
    //
    // The 91 s has never been reproduced: the baseline is ~1.1 s locally and
    // 1.6 s on a GitHub Actions runner. This assertion exists to stop a future
    // reader from "fixing" the bound upward on the strength of that number. At 10 s a timeout here
    // means a genuine hang, which is precisely when the operator must not be
    // told their changesets are malformed.
    expect(DEFAULT_CHANGESET_LINT_TIMEOUT_MS).toBe(10_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gh#1366 — the readiness result is a VALUE
// ─────────────────────────────────────────────────────────────────────────────

describe('SpawnReadinessResult — blocking semantics (gh#1366)', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('sets hasBlockingFailure + names the gates when an error-severity gate fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hygiene-gate-'));
    created.push(root);

    const result = await runSpawnReadinessHygiene(root);

    expect(result.hasBlockingFailure).toBe(true);
    expect(result.blockingGates).toContain('changelog-drift');
    expect(result.blockingGates).toContain('changeset-lint');
    // Every named gate must actually be a failed error-severity gate.
    for (const name of result.blockingGates) {
      const gate = result.gates.find((g) => g.name === name);
      expect(gate?.passed).toBe(false);
      expect(gate?.severity).toBe('error');
    }
  });

  it('does not treat a skipped warn-severity gate as blocking', async () => {
    const root = makeProjectWithLintScript('process.exit(0);\n');
    created.push(root);

    const result = await runSpawnReadinessHygiene(root);
    const worktree = result.gates.find((g) => g.name === 'worktree-location');

    expect(worktree?.severity).toBe('warn');
    expect(result.hasBlockingFailure).toBe(false);
    expect(result.blockingGates).toEqual([]);
  });

  it('runSpawnReadinessHygieneCli RETURNS the result rather than only exiting', async () => {
    // This is the whole of gh#1366: the caller in release.ts had no value to
    // branch on, so it ran on past a failed gate under a comment asserting the
    // callee "exits on failure". A void return is what made that comment
    // unfalsifiable at the callsite.
    const root = mkdtempSync(join(tmpdir(), 'hygiene-gate-'));
    created.push(root);
    const previousExitCode = process.exitCode;

    const result = await runSpawnReadinessHygieneCli(root);

    expect(result).toBeDefined();
    expect(result.hasBlockingFailure).toBe(true);
    expect(Array.isArray(result.gates)).toBe(true);
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    process.exitCode = previousExitCode;
  });

  it('does not clobber an existing exitCode on success', async () => {
    // The old implementation forced `process.exitCode = 0` when all gates
    // passed, which would clear a failure set earlier in the same process.
    const root = makeProjectWithLintScript('process.exit(0);\n');
    created.push(root);
    const previousExitCode = process.exitCode;
    process.exitCode = 3;

    await runSpawnReadinessHygieneCli(root);

    expect(process.exitCode).toBe(3);
    process.exitCode = previousExitCode;
  });
});
