/**
 * T14134 — the remaining blob readers resolve the project store from a CLEO
 * worktree, as the writers do (follow-up to T14127).
 *
 * `checkBlobFilesystem` (docs inconsistency detector), `repairAttachmentStore`
 * (its manifest check) and `consolidateBlobs` (its present-blob scan) each
 * joined `<root>/.cleo` literally, so from a worktree they looked in the
 * worktree's seeded `.cleo/` and misreported which blobs exist.
 *
 * @task T14134
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkBlobFilesystem } from '../../docs/docs-inconsistency-detector.js';
import { repairAttachmentStore } from '../attachment-repair.js';
import { resetDbState } from '../sqlite.js';

const fixtures: string[] = [];
let prevCwd: string;

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'ignore' });
}

/** An initialised parent project and one linked worktree carrying a seeded `.cleo/`. */
function makeFixture(): { parent: string; worktree: string } {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t14134-')));
  fixtures.push(tmp);
  const parent = join(tmp, 'parent');
  const worktree = join(tmp, 'xdg', 'cleo', 'worktrees', 'hash', 'T14134');
  mkdirSync(join(parent, '.cleo'), { recursive: true });
  const info = JSON.stringify({ projectId: 'proj-t14134', projectHash: 'hash-t14134' });
  writeFileSync(join(parent, '.cleo', 'project-info.json'), info);
  writeFileSync(join(parent, 'README.md'), '# parent\n');
  git(parent, ['init', '-b', 'main']);
  git(parent, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'README.md']);
  git(parent, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'initial']);
  git(parent, ['worktree', 'add', '-b', 'task/T14134', worktree, 'main']);
  mkdirSync(join(worktree, '.cleo'), { recursive: true });
  writeFileSync(join(worktree, '.cleo', 'project-info.json'), info);
  return { parent, worktree };
}

/** Put bytes where the writers put them: the parent's blob store (and, optionally, the legacy tree). */
function seedBlob(parent: string, text: string, legacy: boolean): string {
  const body = Buffer.from(text);
  const sha = createHash('sha256').update(body).digest('hex');
  mkdirSync(join(parent, '.cleo', 'blobs', 'blobs'), { recursive: true });
  writeFileSync(join(parent, '.cleo', 'blobs', 'blobs', sha), body);
  if (legacy) {
    const dir = join(parent, '.cleo', 'attachments', 'sha256', sha.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sha.slice(2)}.md`), body);
  }
  return sha;
}

beforeEach(() => {
  prevCwd = process.cwd();
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_PROJECT_ROOT', undefined);
  vi.stubEnv('CLEO_WORKTREE_ROOT', undefined);
  resetDbState();
});

afterEach(() => {
  process.chdir(prevCwd);
  resetDbState();
  vi.unstubAllEnvs();
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('T14134 — blob readers from a worktree', () => {
  it('the docs inconsistency detector sees the same blobs from the worktree as from the root', () => {
    const { parent, worktree } = makeFixture();
    const present = seedBlob(parent, '# present\n', false);
    const legacyOnly = createHash('sha256').update('legacy only').digest('hex');
    const legacyDir = join(parent, '.cleo', 'attachments', 'sha256', legacyOnly.slice(0, 2));
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, `${legacyOnly.slice(2)}.md`), 'legacy only');
    const shas = new Set([present, legacyOnly]);

    const fromRoot = checkBlobFilesystem(parent, shas);
    const fromWorktree = checkBlobFilesystem(worktree, shas);
    expect(fromWorktree).toEqual(fromRoot);
    expect(fromWorktree).toEqual({ missing: [], legacy: [legacyOnly], new: [present] });
  });

  it('attachment repair reports a legacy blob as held by the blob store from the worktree too', async () => {
    const { parent, worktree } = makeFixture();
    const sha = seedBlob(parent, '# orphan legacy bytes also in the blob store\n', true);
    writeFileSync(join(parent, '.cleo', 'docs-publications.json'), '[]');

    const fromRoot = await repairAttachmentStore({ cwd: parent, dryRun: true });
    resetDbState();
    const fromWorktree = await repairAttachmentStore({ cwd: worktree, dryRun: true });
    const reasonFor = (r: Awaited<ReturnType<typeof repairAttachmentStore>>) =>
      r.actions.find((a) => 'sha256' in a && a.sha256 === sha && 'reason' in a)?.reason;
    expect(reasonFor(fromRoot)).toBe('Referenced in blobs/manifest.db');
    expect(reasonFor(fromWorktree)).toBe(reasonFor(fromRoot));
    expect(existsSync(join(worktree, '.cleo', 'blobs'))).toBe(false);
  });
});
