/**
 * Tests for scripts/lint-agent-worktree-isolation.mjs (T9808 / council D009).
 *
 * Strategy:
 *   - Create isolated tmpdir with synthetic transcript files.
 *   - Invoke the script via spawnSync with --dir pointing at the tmpdir.
 *   - Assert stdout/stderr output and exit codes.
 *
 * Positive case (violation detection):
 *   - JSON tool invocation: {"type":"EnterWorktree",...}
 *   - YAML-style: isolation: worktree
 *   - Bare: EnterWorktree in transcript text
 *
 * Negative case (no violation):
 *   - Clean transcript with no EnterWorktree mentions
 *   - Transcript with unrelated tool invocations
 *
 * Flags:
 *   - --fail-on-violations: exits 1 when violations found
 *   - Without flag: exits 0 even with violations (non-blocking warning)
 *   - --dir missing: exits 0 (scan root does not exist)
 *
 * @task T9808
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-agent-worktree-isolation.mjs');

let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-wt-isolation-lint-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Run the lint script with --dir pointing at tmpRoot. */
function runLint(extraArgs = []) {
  return spawnSync('node', [SCRIPT, '--dir', tmpRoot, ...extraArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO_ROOT,
  });
}

// ---------------------------------------------------------------------------
// Clean cases
// ---------------------------------------------------------------------------

describe('lint-agent-worktree-isolation — clean', () => {
  it('exits 0 and prints PASS when no transcript files exist', () => {
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits 0 and prints PASS when transcripts contain no EnterWorktree', () => {
    writeFileSync(join(tmpRoot, 'transcript.md'), '# Agent output\nDid useful work here.\n');
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits 0 on unrelated tool invocations', () => {
    writeFileSync(
      join(tmpRoot, 'clean.json'),
      JSON.stringify({ type: 'ReadFile', path: '/tmp/foo.ts' }),
    );
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });
});

// ---------------------------------------------------------------------------
// Violation cases
// ---------------------------------------------------------------------------

describe('lint-agent-worktree-isolation — violations', () => {
  it('detects JSON {"type":"EnterWorktree",...} and exits 0 (non-blocking)', () => {
    writeFileSync(
      join(tmpRoot, 'bad-transcript.json'),
      JSON.stringify({ type: 'EnterWorktree', taskId: 'T9808', path: '/tmp/wt' }),
    );
    const result = runLint();
    // Non-blocking: exit 0 even on violations.
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('WARN');
    expect(result.stderr).toContain('EnterWorktree');
  });

  it('detects YAML-style isolation: worktree', () => {
    writeFileSync(join(tmpRoot, 'agent-config.md'), '# Config\nisolation: worktree\ntask: T9808\n');
    const result = runLint();
    expect(result.stderr).toContain('WARN');
    expect(result.stderr).toContain('isolation');
  });

  it('detects bare EnterWorktree text in .md transcripts', () => {
    writeFileSync(
      join(tmpRoot, 'output.md'),
      '## Tool calls\nEnterWorktree was invoked with path /tmp/wt-T9999\n',
    );
    const result = runLint();
    expect(result.stderr).toContain('WARN');
  });

  it('--fail-on-violations exits 1 when violations found', () => {
    writeFileSync(
      join(tmpRoot, 'bad.json'),
      JSON.stringify({ type: 'EnterWorktree', path: '/tmp/x' }),
    );
    const result = runLint(['--fail-on-violations']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('WARN');
  });

  it('reports file name and line number in violation output', () => {
    writeFileSync(
      join(tmpRoot, 'violation.md'),
      'line 1\nline 2\n{"type":"EnterWorktree"}\nline 4\n',
    );
    const result = runLint();
    expect(result.stderr).toContain('violation.md:3');
  });
});

// ---------------------------------------------------------------------------
// Missing directory
// ---------------------------------------------------------------------------

describe('lint-agent-worktree-isolation — missing directory', () => {
  it('exits 0 (SKIP) when --dir does not exist', () => {
    const result = spawnSync('node', [SCRIPT, '--dir', '/nonexistent/path/xyz'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SKIP');
  });
});

// ---------------------------------------------------------------------------
// Subdirectory recursion
// ---------------------------------------------------------------------------

describe('lint-agent-worktree-isolation — recursive scan', () => {
  it('scans nested subdirectories', () => {
    const subDir = join(tmpRoot, 'nested', 'deep');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'inner.json'),
      JSON.stringify({ type: 'EnterWorktree', task: 'T9808' }),
    );
    const result = runLint(['--fail-on-violations']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nested');
  });
});
