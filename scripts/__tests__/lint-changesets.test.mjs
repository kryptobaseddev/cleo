/**
 * Tests for scripts/lint-changesets.mjs — the CI gate that rejects
 * malformed `.changeset/*.md` entries.
 *
 * Coverage:
 *   1. Empty .changeset/ directory → exit 0
 *   2. Single valid entry          → exit 0
 *   3. Single invalid kind drift   → exit 1, kind-drift message surfaces
 *   4. Multiple invalid entries    → exit 1, ALL failures listed (T9936)
 *   5. Mixed valid + invalid       → exit 1, valid count + failure count
 *
 * The T9936 anchor here is #4: the legacy fail-fast behaviour masked
 * `kind: feature` drift across 4 sibling changesets — surfacing only the
 * first to CI. The rewritten lint script collects EVERY failure so the
 * author fixes the whole batch in one round-trip.
 *
 * @task T9936
 * @saga T9862
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const LINT_SCRIPT = join(REPO_ROOT, 'scripts', 'lint-changesets.mjs');

/**
 * Spawn the lint script with a synthetic repo root containing only the
 * fixtures the test author wrote. The script resolves the repo root from
 * `import.meta.url` so we cannot redirect it via env — instead we shim
 * the env-derived REPO_ROOT by writing fixtures into a temp dir whose
 * `.changeset/` mirror is then swapped via the CLEO_LINT_CHANGESET_DIR
 * env var the script consults at startup (added below).
 *
 * @param {string} changesetDir - Absolute path to the `.changeset/` dir.
 * @returns {{status: number | null, stdout: string, stderr: string}}
 */
function runLint(changesetDir) {
  const result = spawnSync(process.execPath, [LINT_SCRIPT], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLEO_LINT_CHANGESET_DIR: changesetDir,
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Build a synthetic `.changeset/` directory under a fresh temp root.
 *
 * @param {Record<string, string>} files - Map of filename → file contents.
 * @returns {string} Absolute path to the synthetic `.changeset/` directory.
 */
function buildFixture(files) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'lint-changesets-test-'));
  const dir = join(tempRoot, '.changeset');
  mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents, 'utf8');
  }
  return dir;
}

/** Build a valid CLEO-native entry body for a given slug + kind. */
function validEntry(slug, kind = 'feat') {
  return [
    '---',
    `id: ${slug}`,
    'tasks: [T9936]',
    `kind: ${kind}`,
    `summary: probe ${slug}`,
    '---',
    '',
  ].join('\n');
}

/** Build an entry whose kind is invalid (the T9936 drift class). */
function invalidKindEntry(slug, kind) {
  return [
    '---',
    `id: ${slug}`,
    'tasks: [T9936]',
    `kind: ${kind}`,
    `summary: probe ${slug}`,
    '---',
    '',
  ].join('\n');
}

let tempDirs = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

/** Track a created fixture for afterEach cleanup. */
function track(dir) {
  tempDirs.push(dir);
  return dir;
}

describe('scripts/lint-changesets.mjs (T9936)', () => {
  it('exits 0 when no changesets are present', () => {
    const dir = track(buildFixture({}));
    const { status, stdout } = runLint(dir);
    expect(status).toBe(0);
    expect(stdout).toContain('0 entry/entries validated successfully');
  });

  it('exits 0 for a single valid entry', () => {
    const dir = track(
      buildFixture({
        't9936-valid.md': validEntry('t9936-valid', 'feat'),
      }),
    );
    const { status, stdout } = runLint(dir);
    expect(status).toBe(0);
    expect(stdout).toContain('1 entry/entries validated successfully');
  });

  it('exits 1 and surfaces the failing entry for a single kind drift', () => {
    const dir = track(
      buildFixture({
        't9936-bad.md': invalidKindEntry('t9936-bad', 'feature'),
      }),
    );
    const { status, stderr } = runLint(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('FAIL');
    expect(stderr).toContain('t9936-bad.md');
    // Surface the canonical kind set so the author can self-correct.
    expect(stderr).toContain('feat|fix|perf|refactor|docs|test|chore|breaking');
  });

  it('exits 1 and lists EVERY failure when multiple entries drift (T9936 regression guard)', () => {
    // The headline regression case: 4 changesets with `kind: feature`. The
    // legacy fail-fast lint surfaced only the first — masking the other
    // three until release time. The rewritten lint surfaces ALL of them in
    // one CI run.
    const dir = track(
      buildFixture({
        't9936-bad-1.md': invalidKindEntry('t9936-bad-1', 'feature'),
        't9936-bad-2.md': invalidKindEntry('t9936-bad-2', 'feature'),
        't9936-bad-3.md': invalidKindEntry('t9936-bad-3', 'fixes'),
        't9936-bad-4.md': invalidKindEntry('t9936-bad-4', 'improvement'),
      }),
    );
    const { status, stderr } = runLint(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('4 of 4 entries rejected');
    expect(stderr).toContain('t9936-bad-1.md');
    expect(stderr).toContain('t9936-bad-2.md');
    expect(stderr).toContain('t9936-bad-3.md');
    expect(stderr).toContain('t9936-bad-4.md');
  });

  it('exits 1 and reports valid + invalid counts when mixed', () => {
    const dir = track(
      buildFixture({
        't9936-good-1.md': validEntry('t9936-good-1', 'feat'),
        't9936-good-2.md': validEntry('t9936-good-2', 'fix'),
        't9936-bad.md': invalidKindEntry('t9936-bad', 'feature'),
      }),
    );
    const { status, stderr } = runLint(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('1 of 3 entries rejected');
    expect(stderr).toContain('2 valid');
    expect(stderr).toContain('1 invalid');
    // The valid ones should NOT appear in the failure list.
    expect(stderr).not.toContain('✗ t9936-good-1.md');
    expect(stderr).not.toContain('✗ t9936-good-2.md');
  });
});
