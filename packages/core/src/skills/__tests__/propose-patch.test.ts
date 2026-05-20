/**
 * Unit tests for {@link proposeCanonicalPatch} — covers the three
 * branches called out in T9749 acceptance criteria:
 *
 *   1. happy-path (live mode) — runs the full git/gh sequence via the
 *      injected runner and returns the PR URL.
 *   2. empty diff             — returns `E_PATCH_EMPTY`.
 *   3. gh missing             — returns `E_GH_UNAVAILABLE` when the
 *      `gh --version` probe throws.
 *
 * Plus two extra cases for robustness:
 *   - missing diff file       — returns `E_NOT_FOUND`.
 *   - dry-run                 — returns the planned step list and never
 *     calls the runner with anything other than `gh --version` (which is
 *     skipped in dry-run mode altogether).
 *
 * @task T9749
 * @epic T9740
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CommandRunner, proposeCanonicalPatch } from '../propose-patch.js';

describe('proposeCanonicalPatch', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'propose-patch-'));
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('happy-path: returns ok with the gh-emitted PR URL', async () => {
    const diffPath = join(tmp, 'patch.diff');
    writeFileSync(diffPath, 'diff --git a/foo b/foo\n', 'utf8');

    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const run: CommandRunner = (file, args) => {
      calls.push({ file, args: [...args] });
      if (file === 'gh' && args[0] === '--version') return 'gh version 2.x\n';
      if (file === 'gh' && args[0] === 'pr') return 'https://github.com/cleo/cleo/pull/999\n';
      return '';
    };

    const result = await proposeCanonicalPatch({
      skillName: 'ct-orchestrator',
      diffPath,
      cwd: tmp,
      run,
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.prUrl).toBe('https://github.com/cleo/cleo/pull/999');
    expect(result.skillName).toBe('ct-orchestrator');
    expect(result.base).toBe('main');
    expect(result.branchName).toMatch(/^propose-patch\/skill-ct-orchestrator-/);

    // Verify the call sequence: gh --version probe, then the git sequence,
    // then the gh pr create.
    expect(calls[0]).toEqual({ file: 'gh', args: ['--version'] });
    const fileSequence = calls.map((c) => c.file);
    expect(fileSequence).toEqual(['gh', 'git', 'git', 'git', 'git', 'git', 'gh']);

    const prCreate = calls[calls.length - 1];
    expect(prCreate?.file).toBe('gh');
    expect(prCreate?.args.slice(0, 4)).toEqual(['pr', 'create', '--base', 'main']);
  });

  it('returns E_PATCH_EMPTY when the diff file exists but is zero bytes', async () => {
    const diffPath = join(tmp, 'empty.diff');
    writeFileSync(diffPath, '', 'utf8');
    const run: CommandRunner = vi.fn(() => '');

    const result = await proposeCanonicalPatch({
      skillName: 'ct-orchestrator',
      diffPath,
      cwd: tmp,
      run,
    });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.code).toBe('E_PATCH_EMPTY');
    expect(run).not.toHaveBeenCalled();
  });

  it('returns E_GH_UNAVAILABLE when the gh --version probe throws', async () => {
    const diffPath = join(tmp, 'patch.diff');
    writeFileSync(diffPath, 'diff --git a/foo b/foo\n', 'utf8');

    const run: CommandRunner = (file) => {
      if (file === 'gh') {
        throw new Error('command not found: gh');
      }
      return '';
    };

    const result = await proposeCanonicalPatch({
      skillName: 'ct-orchestrator',
      diffPath,
      cwd: tmp,
      run,
    });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.code).toBe('E_GH_UNAVAILABLE');
    expect(result.message).toMatch(/gh CLI not found/);
  });

  it('returns E_NOT_FOUND when the diff file does not exist', async () => {
    const diffPath = join(tmp, 'missing.diff');
    const run: CommandRunner = vi.fn(() => '');

    const result = await proposeCanonicalPatch({
      skillName: 'ct-orchestrator',
      diffPath,
      cwd: tmp,
      run,
    });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.code).toBe('E_NOT_FOUND');
    expect(run).not.toHaveBeenCalled();
  });

  it('dry-run returns planned steps without invoking the runner', async () => {
    const diffPath = join(tmp, 'patch.diff');
    writeFileSync(diffPath, 'diff --git a/foo b/foo\n', 'utf8');
    const run: CommandRunner = vi.fn(() => '');

    const result = await proposeCanonicalPatch({
      skillName: 'ct-orchestrator',
      diffPath,
      cwd: tmp,
      dryRun: true,
      run,
    });

    expect(result.kind).toBe('dry-run');
    if (result.kind !== 'dry-run') throw new Error('unreachable');
    expect(result.steps.length).toBe(6);
    expect(result.steps[0]).toMatch(/^git checkout -b propose-patch\/skill-ct-orchestrator-/);
    expect(run).not.toHaveBeenCalled();
  });
});
