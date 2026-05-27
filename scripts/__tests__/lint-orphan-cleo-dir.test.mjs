/**
 * Tests for scripts/lint-orphan-cleo-dir.mjs (T10155 / Saga T9862 Wave 5).
 *
 * Strategy:
 *   - Import the pure helpers (isOrphanCleoPath, findOrphanPaths, parseArgs,
 *     runLint with --files) and assert directly — no git shell-out, no
 *     subprocess, fast and deterministic.
 *   - Also exercise the CLI end-to-end via spawnSync with --files so the
 *     argv-parsing + exit-code wiring is covered.
 *
 * Positive cases (orphan detection MUST trigger):
 *   - .claude/worktrees/<id>/.cleo/tasks.db
 *   - .claude/worktrees/<id>/.cleo/audit/foo.jsonl
 *   - paths with task-style session IDs (T9550-foo)
 *
 * Negative cases (MUST NOT trigger):
 *   - Top-level .cleo/* (canonical project root)
 *   - .claude/worktrees/<id>/src/foo.ts (no .cleo segment)
 *   - .claude/agents/foo.json (not under worktrees/)
 *   - .claude/worktrees/.cleo/x (missing session-id segment)
 *
 * @task T10155
 */

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { findOrphanPaths, isOrphanCleoPath, parseArgs, runLint } from '../lint-orphan-cleo-dir.mjs';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-orphan-cleo-dir.mjs');

// ---------------------------------------------------------------------------
// Pure helper — isOrphanCleoPath
// ---------------------------------------------------------------------------

describe('isOrphanCleoPath — positive cases', () => {
  it.each([
    '.claude/worktrees/abc123/.cleo/tasks.db',
    '.claude/worktrees/T9550-foo/.cleo/config.json',
    '.claude/worktrees/sess_42/.cleo/audit/force-bypass.jsonl',
    '.claude/worktrees/x/.cleo/brain.db',
    '.claude/worktrees/0/.cleo', // direct match without trailing slash
  ])('matches %s', (path) => {
    expect(isOrphanCleoPath(path)).toBe(true);
  });
});

describe('isOrphanCleoPath — negative cases', () => {
  it.each([
    // Canonical top-level .cleo/ — the legitimate project root.
    '.cleo/tasks.db',
    '.cleo/config.json',
    // Worktree but no .cleo segment.
    '.claude/worktrees/abc123/src/foo.ts',
    '.claude/worktrees/abc123/README.md',
    // Not under worktrees/ at all.
    '.claude/agents/foo.json',
    '.claude/skills/bar.md',
    // Missing the session-id middle segment — `.cleo` is the direct child
    // of `.claude/worktrees/`, which is not a "worktree" itself.
    '.claude/worktrees/.cleo/tasks.db',
    // Package source paths.
    'packages/core/src/foo.ts',
    'scripts/lint-orphan-cleo-dir.mjs',
    // Empty / pathological.
    '',
    '.claude',
    '.claude/worktrees',
  ])('does not match %s', (path) => {
    expect(isOrphanCleoPath(path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findOrphanPaths
// ---------------------------------------------------------------------------

describe('findOrphanPaths', () => {
  it('returns only the offending paths from a mixed list', () => {
    const input = [
      'packages/core/src/paths.ts',
      '.claude/worktrees/abc/.cleo/tasks.db',
      '.cleo/tasks.db',
      '.claude/worktrees/T9550/.cleo/brain.db',
      'scripts/foo.mjs',
    ];
    expect(findOrphanPaths(input)).toEqual([
      '.claude/worktrees/abc/.cleo/tasks.db',
      '.claude/worktrees/T9550/.cleo/brain.db',
    ]);
  });

  it('returns empty array when no orphans present', () => {
    expect(findOrphanPaths(['.cleo/tasks.db', 'packages/core/src/foo.ts'])).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(findOrphanPaths([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('defaults to origin/main when no --base supplied', () => {
    expect(parseArgs([])).toEqual({
      baseRef: 'origin/main',
      explicitFiles: null,
      help: false,
    });
  });

  it('honours --base origin/release/v1', () => {
    expect(parseArgs(['--base', 'origin/release/v1'])).toMatchObject({
      baseRef: 'origin/release/v1',
    });
  });

  it('accepts --base-ref as an alias', () => {
    expect(parseArgs(['--base-ref', 'HEAD~3'])).toMatchObject({ baseRef: 'HEAD~3' });
  });

  it('captures everything after --files', () => {
    const out = parseArgs(['--files', 'a.ts', 'b/c.ts', '.cleo/tasks.db']);
    expect(out.explicitFiles).toEqual(['a.ts', 'b/c.ts', '.cleo/tasks.db']);
  });

  it('reports --help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('throws on unknown flag', () => {
    expect(() => parseArgs(['--unknown'])).toThrow(/Unknown argument/);
  });

  it('throws when --base is missing its value', () => {
    expect(() => parseArgs(['--base'])).toThrow(/--base requires/);
  });
});

// ---------------------------------------------------------------------------
// runLint (programmatic API, --files bypass)
// ---------------------------------------------------------------------------

describe('runLint — programmatic', () => {
  it('exits 0 on clean file list', () => {
    const result = runLint(
      { baseRef: 'origin/main', explicitFiles: ['.cleo/tasks.db', 'src/foo.ts'], help: false },
      REPO_ROOT,
    );
    expect(result.exitCode).toBe(0);
    expect(result.offenders).toEqual([]);
  });

  it('exits 1 on orphan path', () => {
    const result = runLint(
      {
        baseRef: 'origin/main',
        explicitFiles: ['src/foo.ts', '.claude/worktrees/abc/.cleo/tasks.db'],
        help: false,
      },
      REPO_ROOT,
    );
    expect(result.exitCode).toBe(1);
    expect(result.offenders).toEqual(['.claude/worktrees/abc/.cleo/tasks.db']);
  });
});

// ---------------------------------------------------------------------------
// CLI end-to-end (spawnSync)
// ---------------------------------------------------------------------------

/**
 * Spawn the script with the given args. Captures stdout + stderr + status.
 *
 * @param {string[]} args
 */
function runCli(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO_ROOT,
  });
}

describe('CLI bootstrap', () => {
  it('--help exits 0 and prints usage', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('lint-orphan-cleo-dir.mjs');
    expect(r.stdout).toContain('--base');
    expect(r.stdout).toContain('@task T10155');
  });

  it('exits 0 with OK banner on clean --files list', () => {
    const r = runCli(['--files', 'src/foo.ts', '.cleo/tasks.db']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
  });

  it('exits 1 with FAIL banner when an orphan path is present', () => {
    const r = runCli(['--files', '.claude/worktrees/abc/.cleo/tasks.db']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL');
    expect(r.stderr).toContain('.claude/worktrees/abc/.cleo/tasks.db');
    // The mandated error string from the acceptance criteria — verbatim.
    expect(r.stderr).toContain('Orphan .cleo/ directory creation detected');
    expect(r.stderr).toContain('T9550');
    expect(r.stderr).toContain('T9580');
  });

  it('lists every offender when multiple orphans are added', () => {
    const r = runCli([
      '--files',
      '.claude/worktrees/a/.cleo/x',
      'src/foo.ts',
      '.claude/worktrees/b/.cleo/y',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('.claude/worktrees/a/.cleo/x');
    expect(r.stderr).toContain('.claude/worktrees/b/.cleo/y');
    // The stable banner reports the count.
    expect(r.stderr).toContain('2 orphan path(s)');
  });

  it('exits 2 on unknown flag', () => {
    const r = runCli(['--no-such-flag']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Unknown argument');
  });
});

// ---------------------------------------------------------------------------
// Self-test against the live repo
// ---------------------------------------------------------------------------

describe('self-test against live repo', () => {
  it('finds no orphan paths in the current PR diff against origin/main', () => {
    const r = runCli(['--base', 'origin/main']);
    // We accept exit 0 (clean) OR the git-warning fallback (status 0, stderr
    // notes the no-op). The gate must NEVER report a FAIL on the current repo.
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('FAIL');
  });
});
