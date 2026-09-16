/**
 * The evidence cache key must rotate when the CONTENT of a dirty tracked file
 * changes — not merely when the SET of dirty paths changes (gh#1452).
 *
 * ## The defect
 *
 * `captureDirtyFingerprint` hashed `git status --porcelain=v1`. That output
 * reports WHICH paths are dirty and never WHAT is in them:
 *
 * ```
 * broken edit to a tracked file →  " M src.ts"  → 644d2d03288f0fd73a4659ab3f070cd0
 * fixed  edit to the SAME file  →  " M src.ts"  → 644d2d03288f0fd73a4659ab3f070cd0
 * ```
 *
 * Identical. So fixing the cause of a failure could not rotate the cache key,
 * and the stale FAILED entry was served indefinitely. Reported symptom: the
 * identical error text with `(cached)`, in ~700 ms, across four different task
 * ids, after the offending file had been fixed and `pnpm typecheck` verified
 * green. The only cure was deleting the cache file by hand.
 *
 * Because `tool:typecheck` runs in the SHARED working tree, one uncompilable
 * file made `qaPassed` unsettable for every agent on the repo — and the cache
 * then kept it unsettable after the cause was gone.
 *
 * ## `--raw` is not the fix, though it looks like one
 *
 * `git diff HEAD --raw` reports the destination blob as `0000000` for an
 * UNSTAGED edit, so `:100644 100644 4b48dee 0000000 M\tsrc.ts` is byte-identical
 * before and after the fix. It is the same summary defect one layer down. Only
 * the diff CONTENT distinguishes them.
 *
 * ## Why the fingerprint does not go through `spawnCmd`
 *
 * `spawnCmd` accumulates stdout in a `TailBuffer` capped at 64 KiB and keeps
 * only the TAIL. Hashing a diff through it would ignore every change beyond the
 * last 64 KiB. Measured: 200 small changed files produce ~30 KB of diff, so a
 * shared tree reaches the cap at roughly 430 — exactly the large-dirty-tree
 * case this bug was reported from. The last test below pins that.
 *
 * @task T12218 (gh#1452)
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureDirtyFingerprint } from '../tool-cache.js';

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dirty-fp-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(dir, 'src.ts'), 'export const x: number = 1;\n');
  git(dir, ['add', 'src.ts']);
  git(dir, ['commit', '-q', '-m', 'first']);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('captureDirtyFingerprint (gh#1452)', () => {
  it('ROTATES when a dirty tracked file changes content', async () => {
    // The minimal reproduction. Both states leave git status reading " M src.ts",
    // so a path-level fingerprint cannot tell them apart — which is what served
    // a stale FAILED result after its cause was fixed.
    writeFileSync(join(dir, 'src.ts'), 'export const x: string = 1; // broken\n');
    const broken = await captureDirtyFingerprint(dir);

    writeFileSync(join(dir, 'src.ts'), 'export const x: number = 42; // fixed\n');
    const fixed = await captureDirtyFingerprint(dir);

    expect(broken).not.toBeNull();
    expect(fixed).not.toBeNull();
    expect(fixed).not.toBe(broken);
  });

  it('is STABLE when nothing changed — a fingerprint that always rotates is no key at all', async () => {
    writeFileSync(join(dir, 'src.ts'), 'export const x: number = 7;\n');
    const a = await captureDirtyFingerprint(dir);
    const b = await captureDirtyFingerprint(dir);
    expect(a).toBe(b);
  });

  it('distinguishes a clean tree from a dirty one', async () => {
    const clean = await captureDirtyFingerprint(dir);
    writeFileSync(join(dir, 'src.ts'), 'export const x: number = 2;\n');
    const dirtyFp = await captureDirtyFingerprint(dir);
    expect(dirtyFp).not.toBe(clean);
  });

  it('does NOT rotate for an untracked file — the gh#1221 tradeoff is deliberate', async () => {
    // Guarding a decision, not a mechanism. Untracked files are a tool's own
    // output as often as they are an operator's input, and including them made
    // every tool invalidate its own cache entry. The documented escape hatch is
    // CLEO_EVIDENCE_FRESH=1. Anyone "fixing" gh#1452 by widening the fingerprint
    // to untracked content re-breaks gh#1221 for every project whose tools
    // write into the tree.
    const before = await captureDirtyFingerprint(dir);
    writeFileSync(join(dir, 'brand-new.ts'), 'export const junk = true;\n');
    const after = await captureDirtyFingerprint(dir);
    expect(after).toBe(before);
  });

  it('sees a change at the START of a diff larger than the 64 KiB stream cap', async () => {
    // Pins the reason this does not use `spawnCmd`, whose TailBuffer keeps only
    // the last 64 KiB. `aaa-first.ts` sorts first, so its hunk sits at the head
    // of the diff; if the fingerprint were hashed from a tail-capped buffer,
    // editing it would not move the key while ~100 KB of other changes filled
    // the window.
    // `git diff` emits CHANGED lines plus context, not whole files — so a big
    // diff needs big CHANGES, not big files. Every line is rewritten below.
    const before = 'export const pad = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n'.repeat(60);
    const after = 'export const pad = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";\n'.repeat(60);
    writeFileSync(join(dir, 'aaa-first.ts'), 'export const first = 0;\n');
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `zz-${i}.ts`), before);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'bulk']);

    // Rewrite every line of every filler file: the diff carries both sides.
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `zz-${i}.ts`), after);
    // `aaa-first.ts` must ALREADY be dirty before the first capture. Otherwise
    // the later edit takes it clean -> dirty, which changes the PATH SET and so
    // rotates even a path-level fingerprint — the test would then pass against
    // the very mechanism it exists to reject.
    writeFileSync(join(dir, 'aaa-first.ts'), 'export const first = 1;\n');
    const diffBytes = execFileSync('git', ['diff', 'HEAD', '--', '.'], {
      cwd: dir,
      encoding: 'utf-8',
    }).length;
    expect(diffBytes).toBeGreaterThan(64 * 1024);

    const fpBefore = await captureDirtyFingerprint(dir);
    // Now change ONLY the file whose hunk is at the head of the diff.
    writeFileSync(join(dir, 'aaa-first.ts'), 'export const first = 999;\n');
    const fpAfter = await captureDirtyFingerprint(dir);

    expect(fpAfter).not.toBe(fpBefore);
  });
});
