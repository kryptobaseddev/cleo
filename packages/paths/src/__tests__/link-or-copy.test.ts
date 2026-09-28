/**
 * `linkOrCopy` — junction/symlink with verified copy fallback (T12607).
 *
 * @task T12607
 */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _setSymlinkImplForTests, LinkOccupiedError, linkOrCopy } from '../link-or-copy.js';

let base: string;
let dirTarget: string;
let fileTarget: string;

const eperm = () => {
  throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'link-or-copy-'));
  dirTarget = join(base, 'target-dir');
  mkdirSync(dirTarget);
  writeFileSync(join(dirTarget, 'SKILL.md'), 'dir content');
  fileTarget = join(base, '1-models.json');
  writeFileSync(fileTarget, 'file content');
});

afterEach(() => {
  _setSymlinkImplForTests();
  rmSync(base, { recursive: true, force: true });
});

describe('linkOrCopy', () => {
  it('links a directory and a relative file target where links work', () => {
    const dir = linkOrCopy(dirTarget, join(base, 'dir-link'), 'dir', { platform: 'linux' });
    expect(dir.mode).toBe('symlink');
    expect(readFileSync(join(base, 'dir-link', 'SKILL.md'), 'utf-8')).toBe('dir content');
    const file = linkOrCopy('1-models.json', join(base, 'latest.json'), 'file');
    expect(file.mode).toBe('symlink');
    expect(readlinkSync(join(base, 'latest.json'))).toBe('1-models.json'); // stays relative
  });

  it('uses an absolute junction for directories on win32', () => {
    const calls: Array<[string, string, string | undefined]> = [];
    _setSymlinkImplForTests((target, path, type) => {
      calls.push([target, path, type]);
      symlinkSync(target, path); // stand-in for the junction on this host
    });
    const result = linkOrCopy('target-dir', join(base, 'win-link'), 'dir', { platform: 'win32' });
    expect(result.mode).toBe('junction');
    expect(calls).toEqual([[dirTarget, join(base, 'win-link'), 'junction']]);
  });

  it.each([
    ['dir', () => dirTarget, 'SKILL.md', 'dir content'],
    ['file', () => fileTarget, null, 'file content'],
  ] as const)('copies a %s when linking throws (Windows without Developer Mode)', (kind, target, inner, content) => {
    _setSymlinkImplForTests(eperm);
    const link = join(base, `copied-${kind}`);
    const result = linkOrCopy(target(), link, kind);
    expect(result.mode).toBe('copy');
    expect(result.fallbackReason).toContain('EPERM');
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(inner ? join(link, inner) : link, 'utf-8')).toBe(content);
  });

  it('copies when the link is created but does not resolve', () => {
    _setSymlinkImplForTests((_t, path) => symlinkSync('/nonexistent-t12607', path));
    const result = linkOrCopy(fileTarget, join(base, 'unresolved'), 'file');
    expect(result.mode).toBe('copy');
    expect(result.fallbackReason).toBe('link was created but does not resolve');
    expect(readFileSync(join(base, 'unresolved'), 'utf-8')).toBe('file content');
  });

  it('replaces a DANGLING link (existsSync reports it absent)', () => {
    const link = join(base, 'latest.json');
    symlinkSync('0-models.json', link);
    expect(linkOrCopy('1-models.json', link, 'file').mode).toBe('symlink');
    expect(readFileSync(link, 'utf-8')).toBe('file content');
  });

  it('refuses a real entry unless overwrite is set', () => {
    const occupied = join(base, 'occupied');
    writeFileSync(occupied, 'user data');
    expect(() => linkOrCopy(fileTarget, occupied, 'file')).toThrow(LinkOccupiedError);
    expect(readFileSync(occupied, 'utf-8')).toBe('user data');
    linkOrCopy(fileTarget, occupied, 'file', { overwrite: true });
    expect(readFileSync(occupied, 'utf-8')).toBe('file content');
  });

  it('restores the previous link when neither a link nor a copy can be made; leaves no staging', () => {
    _setSymlinkImplForTests(eperm);
    const link = join(base, 'latest.json');
    symlinkSync('0-models.json', link); // previous (dangling) link
    expect(() => linkOrCopy(join(base, 'missing.json'), link, 'file')).toThrow(/ENOENT/);
    expect(readlinkSync(link)).toBe('0-models.json');
    expect(readdirSync(base).filter((n) => n.includes('link-or-copy-'))).toEqual([]);
  });

  it('restores an overwritten real entry when the replacement fails', () => {
    _setSymlinkImplForTests(eperm);
    const occupied = join(base, 'occupied');
    writeFileSync(occupied, 'user data');
    expect(() =>
      linkOrCopy(join(base, 'missing.json'), occupied, 'file', { overwrite: true }),
    ).toThrow(/ENOENT/);
    expect(readFileSync(occupied, 'utf-8')).toBe('user data');
    expect(readdirSync(base).filter((n) => n.includes('link-or-copy-'))).toEqual([]);
  });

  it('with fallback "none" throws instead of copying', () => {
    _setSymlinkImplForTests(eperm);
    expect(() => linkOrCopy(dirTarget, join(base, 'no-copy'), 'dir', { fallback: 'none' })).toThrow(
      /could not link/,
    );
  });
});
