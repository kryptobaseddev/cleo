/**
 * Tests for scripts/lint-installer-node-floor.mjs (T11981 E6-ONBOARDING).
 *
 * Verifies that the lint script correctly:
 *   1. Parses NODE_FLOOR_MAJOR/MINOR/PATCH from POSIX sh and PowerShell installers.
 *   2. Detects when installer constants drift from root package.json engines.node.
 *   3. Passes on the real repository (install.sh and install.ps1 are in sync).
 *
 * @task T11981
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseShFloor,
  parsePsFloor,
  tripleFrom,
  runLint,
} from '../lint-installer-node-floor.mjs';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Write a minimal package.json with a given engines.node range.
 *
 * @param {string} dir
 * @param {string} nodeRange
 */
function writePkg(dir, nodeRange) {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'root', version: '0.0.0', engines: { node: nodeRange } }, null, 2),
    'utf8',
  );
}

/**
 * Write a minimal install.sh with the given major/minor/patch constants.
 *
 * @param {string} dir
 * @param {number} major
 * @param {number} minor
 * @param {number} patch
 */
function writeInstallSh(dir, major, minor, patch) {
  const scripts = join(dir, 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(
    join(scripts, 'install.sh'),
    [
      '#!/usr/bin/env sh',
      `NODE_FLOOR_MAJOR=${major}`,
      `NODE_FLOOR_MINOR=${minor}`,
      `NODE_FLOOR_PATCH=${patch}`,
      'NODE_FLOOR="${NODE_FLOOR_MAJOR}.${NODE_FLOOR_MINOR}.${NODE_FLOOR_PATCH}"',
    ].join('\n'),
    'utf8',
  );
}

/**
 * Write a minimal install.ps1 with the given major/minor/patch constants.
 *
 * @param {string} dir
 * @param {number} major
 * @param {number} minor
 * @param {number} patch
 */
function writeInstallPs1(dir, major, minor, patch) {
  const scripts = join(dir, 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(
    join(scripts, 'install.ps1'),
    [
      '# install.ps1',
      `$NODE_FLOOR_MAJOR = ${major}`,
      `$NODE_FLOOR_MINOR = ${minor}`,
      `$NODE_FLOOR_PATCH = ${patch}`,
    ].join('\n'),
    'utf8',
  );
}

// ── Unit tests — parse functions ──────────────────────────────────────────────
describe('parseShFloor', () => {
  it('parses matching POSIX constants', () => {
    const src = [
      '#!/usr/bin/env sh',
      'NODE_FLOOR_MAJOR=24',
      'NODE_FLOOR_MINOR=16',
      'NODE_FLOOR_PATCH=0',
    ].join('\n');
    expect(parseShFloor(src)).toEqual({ major: 24, minor: 16, patch: 0 });
  });

  it('returns null when constants are absent', () => {
    expect(parseShFloor('#!/usr/bin/env sh\n# no constants')).toBeNull();
  });

  it('returns null when only some constants are present', () => {
    expect(parseShFloor('NODE_FLOOR_MAJOR=24\nNODE_FLOOR_MINOR=16')).toBeNull();
  });

  it('handles patch = 0', () => {
    const src = 'NODE_FLOOR_MAJOR=24\nNODE_FLOOR_MINOR=16\nNODE_FLOOR_PATCH=0\n';
    expect(parseShFloor(src)).toEqual({ major: 24, minor: 16, patch: 0 });
  });

  it('handles larger patch version', () => {
    const src = 'NODE_FLOOR_MAJOR=22\nNODE_FLOOR_MINOR=4\nNODE_FLOOR_PATCH=15\n';
    expect(parseShFloor(src)).toEqual({ major: 22, minor: 4, patch: 15 });
  });
});

describe('parsePsFloor', () => {
  it('parses matching PowerShell constants', () => {
    const src = [
      '# install.ps1',
      '$NODE_FLOOR_MAJOR = 24',
      '$NODE_FLOOR_MINOR = 16',
      '$NODE_FLOOR_PATCH = 0',
    ].join('\n');
    expect(parsePsFloor(src)).toEqual({ major: 24, minor: 16, patch: 0 });
  });

  it('returns null when constants are absent', () => {
    expect(parsePsFloor('# no constants')).toBeNull();
  });

  it('returns null when only two of three constants are present', () => {
    expect(parsePsFloor('$NODE_FLOOR_MAJOR = 24\n$NODE_FLOOR_MINOR = 16')).toBeNull();
  });

  it('handles various whitespace around the equals sign', () => {
    const src = '$NODE_FLOOR_MAJOR = 24\n$NODE_FLOOR_MINOR = 0\n$NODE_FLOOR_PATCH = 1\n';
    expect(parsePsFloor(src)).toEqual({ major: 24, minor: 0, patch: 1 });
  });
});

describe('tripleFrom', () => {
  it('extracts x.y.z from >=x.y.z range', () => {
    expect(tripleFrom('>=24.16.0')).toEqual({ major: 24, minor: 16, patch: 0 });
  });

  it('extracts x.y.z from bare triple', () => {
    expect(tripleFrom('22.0.0')).toEqual({ major: 22, minor: 0, patch: 0 });
  });

  it('returns null for empty string', () => {
    expect(tripleFrom('')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(tripleFrom(undefined)).toBeNull();
  });
});

// ── Integration tests — runLint with scratch repos ────────────────────────────
describe('runLint (scratch repos)', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-installer-floor-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('passes when both installers match engines.node', () => {
    writePkg(tmpRoot, '>=24.16.0');
    writeInstallSh(tmpRoot, 24, 16, 0);
    writeInstallPs1(tmpRoot, 24, 16, 0);
    const { violations } = runLint(tmpRoot);
    expect(violations).toEqual([]);
  });

  it('fails when install.sh has a mismatched major version', () => {
    writePkg(tmpRoot, '>=24.16.0');
    writeInstallSh(tmpRoot, 22, 16, 0);   // wrong major
    writeInstallPs1(tmpRoot, 24, 16, 0);
    const { violations } = runLint(tmpRoot);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('install.sh');
    expect(violations[0]).toContain('22.16.0');
    expect(violations[0]).toContain('24.16.0');
  });

  it('fails when install.ps1 has a mismatched minor version', () => {
    writePkg(tmpRoot, '>=24.16.0');
    writeInstallSh(tmpRoot, 24, 16, 0);
    writeInstallPs1(tmpRoot, 24, 0, 0);   // wrong minor
    const { violations } = runLint(tmpRoot);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('install.ps1');
  });

  it('fails when both installers are mismatched', () => {
    writePkg(tmpRoot, '>=24.16.0');
    writeInstallSh(tmpRoot, 20, 0, 0);
    writeInstallPs1(tmpRoot, 18, 0, 0);
    const { violations } = runLint(tmpRoot);
    expect(violations).toHaveLength(2);
  });

  it('fails when install.sh is missing constants', () => {
    writePkg(tmpRoot, '>=24.16.0');
    mkdirSync(join(tmpRoot, 'scripts'), { recursive: true });
    writeFileSync(join(tmpRoot, 'scripts', 'install.sh'), '#!/usr/bin/env sh\n# no constants', 'utf8');
    writeInstallPs1(tmpRoot, 24, 16, 0);
    const { violations } = runLint(tmpRoot);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('could not parse');
  });

  it('reports error when package.json is missing engines.node', () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'root', version: '0.0.0' }),
      'utf8',
    );
    const { violations } = runLint(tmpRoot);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('missing engines.node');
  });

  it('reports error when installer file is missing', () => {
    writePkg(tmpRoot, '>=24.16.0');
    // Deliberately do NOT create install.sh or install.ps1
    const { violations } = runLint(tmpRoot);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations.some((v) => v.includes('could not read file'))).toBe(true);
  });
});

// ── Integration test — real repo must always pass ─────────────────────────────
describe('lint-installer-node-floor (real repo)', () => {
  it('passes on the real repository (install.sh and install.ps1 are in sync)', () => {
    const { violations } = runLint(REPO_ROOT);
    expect(violations, `Violations:\n${violations.join('\n')}`).toEqual([]);
  });
});
