/**
 * Tests for scripts/lint-agent-outputs-registration.mjs.
 *
 * Strategy:
 *   - Build an isolated `cwd` under tmpdir with a fake `.cleo/agent-outputs/`
 *     and stub `cleo` binaries that return canned JSON envelopes for
 *     `cleo docs list --json` and `cleo memory find <q> --json`.
 *   - Drive the linter via `--cleo-bin <stub>` and `--cwd <tmpdir>`.
 *
 * Coverage:
 *   1. File with @no-cleo-register marker → passes (opt-out)
 *   2. File without any registration → violation
 *   3. File with `cleo docs list` entry → passes (docs)
 *   4. File with `cleo memory find` hit → passes (memory)
 *   5. --severity error exits 1 on violation
 *   6. --severity warn exits 0 on violation
 *   7. --since only checks added files (git diff --diff-filter=A)
 *   8. --ignore skips matching paths
 *   9. --json output shape contains violations[] + registered[] + summary
 *  10. Project-agnostic — runs in non-cleocode tmpdir
 *  11. @no-cleo-register marker beyond line 40 does NOT opt out
 *  12. Empty reports dir → OK exit 0
 *
 * @task T1617
 * @epic T1611
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Also import pure functions directly for unit tests
import {
  extractTaskIdFromFilename,
  hasOptOutMarker,
  parseArgs,
} from '../lint-agent-outputs-registration.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lint-agent-outputs-registration.mjs');

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a fake `cleo` stub that handles `docs list --json` and
 * `memory find <q> --json`. Returns canned responses controlled by
 * `docsFiles` (list of file paths that appear in docs) and
 * `memoryPaths` (list of file paths mentioned in memory bodies).
 *
 * @param {string} dir - Directory to write the stub into.
 * @param {{ docsFiles?: string[], memoryPaths?: string[] }} opts
 * @returns {string} Absolute path to the stub executable.
 */
function makeFakeCleo(dir, { docsFiles = [], memoryPaths = [] } = {}) {
  const path = join(dir, 'fake-cleo.mjs');
  const body = `#!/usr/bin/env node
const docsFiles = ${JSON.stringify(docsFiles)};
const memoryPaths = ${JSON.stringify(memoryPaths)};

const args = process.argv.slice(2);
const cmd = args[0];

// Handle: cleo docs list --task <id> --json
if (cmd === 'docs' && args[1] === 'list') {
  // Return docs list — each entry has a "path" field
  process.stdout.write(JSON.stringify({
    success: true,
    data: {
      docs: docsFiles.map((f, i) => ({ id: 'doc-' + i, path: f, url: f })),
    },
  }) + '\\n');
  process.exit(0);
}

// Handle: cleo memory find <query> --json
if (cmd === 'memory' && args[1] === 'find') {
  const query = args[2] || '';
  // Return memory observations whose body mentions any memoryPath
  const memories = memoryPaths
    .filter(p => p.includes(query) || query.includes(p.split('/').pop()))
    .map((p, i) => ({ id: 'mem-' + i, body: 'Observation: ' + p }));
  process.stdout.write(JSON.stringify({
    success: true,
    data: { memories },
  }) + '\\n');
  process.exit(0);
}

// Fallback: unsupported command
process.stderr.write('fake-cleo: unsupported: ' + args.join(' ') + '\\n');
process.exit(99);
`;
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

/**
 * Run the lint script as a child process with given argv.
 *
 * @param {string[]} extraArgs
 * @param {{ cwd?: string }} [opts]
 * @returns {{ stdout: string, stderr: string, status: number | null }}
 */
function runLint(extraArgs, { cwd = process.cwd() } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...extraArgs], { cwd, encoding: 'utf8' });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? null,
  };
}

/** Create a temp directory and return its path. */
function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'lint-agent-outputs-test-'));
}

/** Write a .md file under <tmpDir>/.cleo/agent-outputs/<name>. */
function writeAgentOutput(tmpDir, name, content) {
  const dir = join(tmpDir, '.cleo', 'agent-outputs');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ============================================================================
// Test setup / teardown
// ============================================================================

/** @type {string} */
let tmpDir;
/** @type {string} */
let fakeCleo;

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ============================================================================
// Tests
// ============================================================================

// ============================================================================
// Unit tests (pure functions — no subprocess)
// ============================================================================

describe('extractTaskIdFromFilename', () => {
  it('extracts T1617 from T1617-foo-bar.md', () => {
    expect(extractTaskIdFromFilename('T1617-foo-bar.md')).toBe('T1617');
  });

  it('extracts T100 from T100.md', () => {
    expect(extractTaskIdFromFilename('T100.md')).toBe('T100');
  });

  it('extracts T-CAP-001 style IDs', () => {
    expect(extractTaskIdFromFilename('T-CAP-001-report.md')).toBe('T-CAP-001');
  });

  it('returns null for non-task filenames', () => {
    expect(extractTaskIdFromFilename('MANIFEST.md')).toBeNull();
    expect(extractTaskIdFromFilename('README.md')).toBeNull();
    expect(extractTaskIdFromFilename('session-notes.md')).toBeNull();
  });
});

describe('parseArgs', () => {
  it('defaults to severity=warn', () => {
    expect(parseArgs([]).severity).toBe('warn');
  });

  it('parses --severity error', () => {
    expect(parseArgs(['--severity', 'error']).severity).toBe('error');
  });

  it('parses --since main', () => {
    expect(parseArgs(['--since', 'main']).since).toBe('main');
  });

  it('parses --json flag', () => {
    expect(parseArgs(['--json']).json).toBe(true);
  });

  it('parses --ignore with commas', () => {
    expect(parseArgs(['--ignore', 'foo,bar']).ignore).toEqual(['foo', 'bar']);
  });

  it('throws on unknown argument', () => {
    expect(() => parseArgs(['--unknown'])).toThrow('Unknown argument');
  });

  it('throws on invalid severity', () => {
    expect(() => parseArgs(['--severity', 'fatal'])).toThrow('--severity');
  });
});

describe('hasOptOutMarker', () => {
  it('detects marker on line 1', () => {
    const path = join(tmpdir(), 'marker-test-' + Date.now() + '.md');
    writeFileSync(path, '@no-cleo-register\n# Title\n');
    expect(hasOptOutMarker(path)).toBe(true);
    rmSync(path, { force: true });
  });

  it('returns false when marker is absent', () => {
    const path = join(tmpdir(), 'no-marker-test-' + Date.now() + '.md');
    writeFileSync(path, '# Title\n\nContent.\n');
    expect(hasOptOutMarker(path)).toBe(false);
    rmSync(path, { force: true });
  });
});

// ============================================================================
// Integration tests (subprocess)
// ============================================================================

describe('lint-agent-outputs-registration', () => {
  it('passes when reports dir does not exist (no files to check)', () => {
    fakeCleo = makeFakeCleo(tmpDir);
    const { stdout, status } = runLint([
      '--cleo-bin',
      fakeCleo,
      '--cwd',
      tmpDir,
      '--severity',
      'error',
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('OK');
  });

  it('passes when reports dir is empty (no .md files)', () => {
    mkdirSync(join(tmpDir, '.cleo', 'agent-outputs'), { recursive: true });
    fakeCleo = makeFakeCleo(tmpDir);
    const { stdout, status } = runLint([
      '--cleo-bin',
      fakeCleo,
      '--cwd',
      tmpDir,
      '--severity',
      'error',
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('OK');
  });

  it('fails with exit 1 when a file has no registration (--severity error)', () => {
    writeAgentOutput(tmpDir, 'T999-report.md', '# Report\n\nSome content.\n');
    fakeCleo = makeFakeCleo(tmpDir, { docsFiles: [], memoryPaths: [] });
    const { stdout, status } = runLint([
      '--cleo-bin',
      fakeCleo,
      '--cwd',
      tmpDir,
      '--severity',
      'error',
    ]);
    expect(status).toBe(1);
    expect(stdout).toContain('T999-report.md');
    expect(stdout).toContain('unregistered');
  });

  it('exits 0 when --severity warn even with violations', () => {
    writeAgentOutput(tmpDir, 'T999-report.md', '# Report\n\nSome content.\n');
    fakeCleo = makeFakeCleo(tmpDir, { docsFiles: [], memoryPaths: [] });
    const { status } = runLint(['--cleo-bin', fakeCleo, '--cwd', tmpDir, '--severity', 'warn']);
    expect(status).toBe(0);
  });

  it('passes when file has @no-cleo-register marker in frontmatter', () => {
    writeAgentOutput(
      tmpDir,
      'T100-ephemeral.md',
      '---\n@no-cleo-register\ntitle: Ephemeral\n---\n\n# Content\n',
    );
    fakeCleo = makeFakeCleo(tmpDir);
    const { stdout, status } = runLint([
      '--cleo-bin',
      fakeCleo,
      '--cwd',
      tmpDir,
      '--severity',
      'error',
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('OK');
  });

  it('does NOT pass when @no-cleo-register appears after line 40', () => {
    // Build a file where the marker is on line 45
    const lines = Array.from({ length: 44 }, (_, i) => `line ${i + 1}`);
    lines.push('@no-cleo-register');
    writeAgentOutput(tmpDir, 'T101-late-marker.md', lines.join('\n') + '\n');
    fakeCleo = makeFakeCleo(tmpDir, { docsFiles: [], memoryPaths: [] });
    const { stdout, status } = runLint([
      '--cleo-bin',
      fakeCleo,
      '--cwd',
      tmpDir,
      '--severity',
      'error',
    ]);
    // Should be a violation — marker was too late
    expect(status).toBe(1);
    expect(stdout).toContain('T101-late-marker.md');
  });

  it('passes when file is registered via cleo docs add', () => {
    writeAgentOutput(tmpDir, 'T200-research.md', '# Research\n\nFindings.\n');
    const relPath = '.cleo/agent-outputs/T200-research.md';
    fakeCleo = makeFakeCleo(tmpDir, { docsFiles: [relPath] });
    const { stdout, status } = runLint([
      '--cleo-bin',
      fakeCleo,
      '--cwd',
      tmpDir,
      '--severity',
      'error',
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('OK');
  });

  it('passes when file is registered via cleo memory observe', () => {
    writeAgentOutput(tmpDir, 'T300-spec.md', '# Spec\n\nDetails.\n');
    const relPath = '.cleo/agent-outputs/T300-spec.md';
    fakeCleo = makeFakeCleo(tmpDir, { memoryPaths: [relPath] });
    const { stdout, status } = runLint([
      '--cleo-bin',
      fakeCleo,
      '--cwd',
      tmpDir,
      '--severity',
      'error',
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('OK');
  });

  it('--json output has correct shape', () => {
    writeAgentOutput(tmpDir, 'T400-orphan.md', '# Orphan\n\nNo registration.\n');
    fakeCleo = makeFakeCleo(tmpDir);
    const { stdout, status } = runLint(['--cleo-bin', fakeCleo, '--cwd', tmpDir, '--json']);
    expect(status).toBe(0); // default severity=warn
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('generatedAt');
    expect(parsed).toHaveProperty('summary');
    expect(parsed.summary).toHaveProperty('filesScanned');
    expect(parsed.summary).toHaveProperty('violations');
    expect(parsed.summary).toHaveProperty('registered');
    expect(parsed).toHaveProperty('violations');
    expect(Array.isArray(parsed.violations)).toBe(true);
    expect(parsed).toHaveProperty('registered');
    expect(Array.isArray(parsed.registered)).toBe(true);
    expect(parsed.violations.length).toBe(1);
    expect(parsed.violations[0].relPath).toContain('T400-orphan.md');
  });

  it('--ignore skips matching file paths', () => {
    writeAgentOutput(tmpDir, 'T500-skip-me.md', '# Skip\n\nContent.\n');
    fakeCleo = makeFakeCleo(tmpDir);
    const { stdout, status } = runLint([
      '--cleo-bin',
      fakeCleo,
      '--cwd',
      tmpDir,
      '--ignore',
      'T500-skip-me',
      '--severity',
      'error',
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('OK');
  });

  it('prints fix instructions in human output for violations', () => {
    writeAgentOutput(tmpDir, 'T600-no-reg.md', '# No registration\n');
    fakeCleo = makeFakeCleo(tmpDir);
    const { stdout } = runLint(['--cleo-bin', fakeCleo, '--cwd', tmpDir, '--severity', 'warn']);
    expect(stdout).toContain('cleo docs add');
    expect(stdout).toContain('cleo memory observe');
    expect(stdout).toContain('@no-cleo-register');
  });

  it('--help exits 0 and prints usage', () => {
    const { stdout, status } = runLint(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('--severity');
    expect(stdout).toContain('@no-cleo-register');
  });

  it('project-agnostic: runs correctly in arbitrary non-cleocode tmpdir', () => {
    const otherProject = makeTmpDir();
    try {
      writeAgentOutput(otherProject, 'T700-other.md', '---\n@no-cleo-register\n---\n# ok\n');
      const stub = makeFakeCleo(otherProject);
      const { stdout, status } = runLint([
        '--cleo-bin',
        stub,
        '--cwd',
        otherProject,
        '--severity',
        'error',
      ]);
      expect(status).toBe(0);
      expect(stdout).toContain('OK');
    } finally {
      rmSync(otherProject, { recursive: true, force: true });
    }
  });
});
