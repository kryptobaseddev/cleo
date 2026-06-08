/**
 * Tests for the atomic fs tool primitives (E3 · T11405).
 *
 * @epic T11390
 * @task T11405
 * @saga T11387
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizePath, pathExists, readFileText, readJson, writeFileAtomic } from '../fs.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-fs-tool-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomic + readFileText round-trip', () => {
  it('writes then reads identical content', async () => {
    const path = join(dir, 'a.txt');
    const w = await writeFileAtomic({ path, content: 'hello world' });
    expect(w.path).toBe(path);
    expect(w.bytesWritten).toBe(11);
    const r = await readFileText({ path });
    expect(r.content).toBe('hello world');
    expect(r.path).toBe(path);
  });

  it('creates missing parent directories by default', async () => {
    const path = join(dir, 'nested', 'deep', 'b.txt');
    await writeFileAtomic({ path, content: 'x' });
    expect(readFileSync(path, 'utf8')).toBe('x');
  });

  it('leaves no .tmp sibling after a successful write (atomicity)', async () => {
    const path = join(dir, 'c.txt');
    await writeFileAtomic({ path, content: 'data' });
    const { exists } = await pathExists({ path });
    expect(exists).toBe(true);
    // The temp file is renamed away; only the final file remains.
    const tmp = await pathExists({ path: join(dir, `.${process.pid}-4.tmp`) });
    expect(tmp.exists).toBe(false);
  });
});

describe('readJson', () => {
  it('parses a written JSON file into the asserted type', async () => {
    const path = join(dir, 'd.json');
    await writeFileAtomic({ path, content: JSON.stringify({ n: 42, s: 'ok' }) });
    const parsed = await readJson<{ n: number; s: string }>(path);
    expect(parsed.n).toBe(42);
    expect(parsed.s).toBe('ok');
  });

  it('throws on invalid JSON', async () => {
    const path = join(dir, 'bad.json');
    await writeFileAtomic({ path, content: '{ not json' });
    await expect(readJson(path)).rejects.toThrow();
  });
});

describe('canonicalizePath (symlink-resolving)', () => {
  it('resolves a file symlink to its REAL target', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cleo-fs-outside-'));
    try {
      const realTarget = join(outside, 'secret.txt');
      await writeFileAtomic({ path: realTarget, content: 's' });
      const link = join(dir, 'link.txt');
      symlinkSync(realTarget, link);
      // realpathSync(outside) normalizes /var → /private/var on macOS etc.
      expect(await canonicalizePath(link)).toBe(realpathSync(realTarget));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('resolves a symlinked PARENT for a not-yet-existing child', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cleo-fs-outside-'));
    try {
      const linkedDir = join(dir, 'sub');
      symlinkSync(outside, linkedDir);
      // sub/new.txt does not exist yet; canonicalize must reveal it lands OUTSIDE.
      const resolved = await canonicalizePath(join(linkedDir, 'new.txt'));
      expect(resolved).toBe(join(realpathSync(outside), 'new.txt'));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns the real path of a plain existing dir unchanged (no symlink)', async () => {
    mkdirSync(join(dir, 'plain'));
    expect(await canonicalizePath(join(dir, 'plain'))).toBe(realpathSync(join(dir, 'plain')));
  });
});

describe('pathExists', () => {
  it('reports a file', async () => {
    const path = join(dir, 'f.txt');
    await writeFileAtomic({ path, content: '1' });
    expect(await pathExists({ path })).toEqual({ exists: true, kind: 'file' });
  });

  it('reports a directory', async () => {
    expect(await pathExists({ path: dir })).toEqual({ exists: true, kind: 'directory' });
  });

  it('reports a missing path', async () => {
    expect(await pathExists({ path: join(dir, 'nope') })).toEqual({ exists: false });
  });
});
