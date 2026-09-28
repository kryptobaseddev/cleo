/**
 * T12606 — temp-path detection on Windows and macOS layouts.
 *
 * The prod-DB guard, doctor temp classification and portable-bundle export
 * filter each matched `'/tmp/'` substrings or fell back to a literal `/tmp`.
 * A Windows `%TEMP%` path never matched, and macOS `os.tmpdir()` lives under
 * `/var/folders`, which physically resolves to `/private/var/folders`. All
 * three now route through {@link isEphemeralPath}.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTempProject } from '../../validation/doctor/utils.js';
import { isEphemeralPath } from '../registry-hygiene.js';

const WIN_TEMP = 'C:\\Users\\me\\AppData\\Local\\Temp';
const win = { platform: 'win32' as const, tmpdir: WIN_TEMP };

describe('isEphemeralPath with Windows-style paths', () => {
  it('classifies a %TEMP% descendant, case-insensitively', () => {
    expect(isEphemeralPath(`${WIN_TEMP}\\vitest-abc\\.cleo\\cleo.db`, win)).toBe(true);
    expect(isEphemeralPath('c:\\users\\ME\\appdata\\local\\temp\\x', win)).toBe(true);
  });

  it('rejects a sibling that merely shares a prefix, and real projects', () => {
    expect(isEphemeralPath(`${WIN_TEMP}2\\x`, win)).toBe(false);
    expect(isEphemeralPath('C:\\Users\\me\\projects\\app', win)).toBe(false);
  });

  it("the old '/'-only doctor patterns miss a %TEMP% path (red-on-broken)", () => {
    const p = `${WIN_TEMP}\\fixture`;
    expect(['/.temp/', '/tmp/', '/.tmp/'].some((pat) => p.includes(pat))).toBe(false);
  });
});

describe('isEphemeralPath with macOS /private/var paths', () => {
  const mac = { platform: 'darwin' as const, tmpdir: '/var/folders/ab/xyz/T' };

  it('classifies the lexical /var/folders form and /tmp', () => {
    expect(isEphemeralPath('/var/folders/ab/xyz/T/fixture', mac)).toBe(true);
    expect(isEphemeralPath('/tmp/x', mac)).toBe(true);
    expect(isEphemeralPath('/tmpfoo/x', mac)).toBe(false);
  });

  it('classifies the physical /private form of the real host temp dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eph-'));
    try {
      expect(isEphemeralPath(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isTempProject folds Windows separators (T12606)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('matches backslash forms of the temp patterns', () => {
    expect(isTempProject('C:\\Users\\me\\.temp\\proj')).toBe(true);
    expect(isTempProject('D:\\ci\\bats-run-123\\x')).toBe(true);
    expect(isTempProject('C:\\Users\\me\\projects\\app')).toBe(false);
  });

  it('matches the host os.tmpdir() even without a /tmp/ substring', () => {
    dir = mkdtempSync(join(tmpdir(), 'proj-'));
    expect(isTempProject(dir)).toBe(true);
  });
});
