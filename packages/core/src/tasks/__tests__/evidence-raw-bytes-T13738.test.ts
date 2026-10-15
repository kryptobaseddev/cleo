/**
 * T13738: `files:` evidence read from git must hash the raw blob bytes.
 *
 * The git readers decoded stdout as UTF-8 and re-encoded it with
 * `Buffer.from(s, 'binary')`, so every non-ASCII or invalid-UTF-8 file got a
 * wrong sha256. Each case asserts the atom hash equals sha256 of the
 * `git cat-file blob` bytes.
 *
 * @task T13738
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeGateEvidence, revalidateEvidence, validateAtom } from '../evidence.js';

const FILES: Record<string, Buffer> = {
  'utf8.txt': Buffer.from('café ✓\n', 'utf-8'),
  'invalid.txt': Buffer.from([0x61, 0xff, 0xfe, 0xc3, 0x28, 0x0a]),
  'blob.bin': Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x80, 0xff]),
};

function git(dir: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd: dir });
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('files: evidence hashes raw git blob bytes (T13738)', () => {
  let dir: string;
  let commitSha: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evidence-raw-bytes-'));
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.name', 'Test']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    for (const [name, bytes] of Object.entries(FILES)) writeFileSync(join(dir, name), bytes);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'add']);
    commitSha = git(dir, ['rev-parse', 'HEAD']).toString().trim();
    // Absent from disk, so every read goes through git.
    for (const name of Object.keys(FILES)) unlinkSync(join(dir, name));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const blobHash = (name: string): string =>
    sha256(git(dir, ['cat-file', 'blob', `${commitSha}:${name}`]));

  it('hashes the commit-tree blob (git cat-file path)', async () => {
    const r = await validateAtom(
      { kind: 'files', paths: Object.keys(FILES) },
      dir,
      undefined,
      commitSha,
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.atom.kind !== 'files') return;
    for (const f of r.atom.files) expect(f.sha256, f.path).toBe(blobHash(f.path));
  });

  it('hashes the branch fallback blob (git show path)', async () => {
    const r = await validateAtom({ kind: 'files', paths: Object.keys(FILES) }, dir, 'T13738');
    expect(r.ok).toBe(true);
    if (!r.ok || r.atom.kind !== 'files') return;
    for (const f of r.atom.files) expect(f.sha256, f.path).toBe(blobHash(f.path));
  });

  it('names the encoding bug, not a modification, for a hash recorded by a buggy build', async () => {
    const lossy = sha256(Buffer.from(FILES['utf8.txt'].toString('utf-8'), 'binary'));
    const evidence = composeGateEvidence(
      [
        { kind: 'commit', sha: commitSha, shortSha: commitSha.slice(0, 7) },
        { kind: 'files', files: [{ path: 'utf8.txt', sha256: lossy }] },
      ],
      'test',
    );
    const r = await revalidateEvidence(evidence, dir);
    expect(r.stillValid).toBe(false);
    expect(r.failedAtoms[0]?.reason).toMatch(
      /likely came from.*T13738.*check the file, then re-run `cleo verify`/,
    );
  });
});
