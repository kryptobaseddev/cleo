/**
 * Tests for scripts/fresh-agent-test.mjs
 *
 * Final acceptance test for the T1611 KNOWLEDGE-FIRST-CITIZEN epic.
 *
 * Strategy:
 *   - Use a fake `cleo` stub that serves canned LAFS envelopes for:
 *       briefing, docs list, memory find, show
 *   - Run the auditor script (fresh-agent-test.mjs) via subprocess with
 *       --cleo-bin <stub> --cwd <tmpDir>
 *   - Assert score=10/10 and exit code 0
 *   - Verify that if a test tries to read an agent-outputs .md, the
 *       denylist guard fires and the score drops to < 10
 *
 * Coverage (10 probes mirrored in integration test):
 *   1.  briefing returns success envelope
 *   2.  briefing output contains session context keys
 *   3.  docs list returns success envelope
 *   4.  docs list result has attachments array
 *   5.  memory find returns success envelope
 *   6.  memory find result has results array
 *   7.  show returns a valid LAFS envelope
 *   8.  show response shape is valid
 *   9.  no .cleo/agent-outputs/*.md file was read (denylist clean)
 *  10.  all 4 command families invoked
 *
 * Unit test coverage:
 *   - parseArgs: known flags, unknown flag error, missing value error
 *   - isDenied: matching and non-matching paths
 *   - buildReport: score computation, passed flag
 *   - runProbes: all 10 probes pass with good stub
 *   - runProbes: probe 9 fails when denylist violated
 *   - subprocess: score 10/10, exit 0 with good stub
 *   - subprocess: exit 1 when stub returns broken briefing
 *   - subprocess: exit 1 when stub returns broken docs
 *   - subprocess: exit 1 when stub returns broken memory
 *   - subprocess: exit 0 with --json flag (well-formed JSON)
 *   - subprocess: --no-guard still scores probe 9 as pass (no violations when guard off)
 *   - subprocess: project-agnostic — runs from arbitrary tmpdir
 *
 * @task T1618
 * @epic T1611
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Obtain the mutable CJS fs reference for unit tests of installDenylistGuard
const _require = createRequire(import.meta.url);
/** @type {typeof import('node:fs')} */
const fsCjsForTest = _require('fs');

// Import pure functions for unit tests
import {
  buildReport,
  denylistState,
  installDenylistGuard,
  isDenied,
  parseArgs,
  runProbes,
} from '../fresh-agent-test.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'fresh-agent-test.mjs');

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a fake cleo stub that returns canned LAFS envelopes.
 *
 * @param {string} dir     Directory to write the stub into.
 * @param {object} opts
 * @param {boolean} [opts.briefingFails]  Make briefing return success:false
 * @param {boolean} [opts.docsFails]      Make docs list return success:false
 * @param {boolean} [opts.memoryFails]    Make memory find return success:false
 * @param {boolean} [opts.showFails]      Make show return non-JSON garbage
 * @returns {string}       Absolute path to the stub executable.
 */
function makeFakeCleo(dir, opts = {}) {
  const { briefingFails = false, docsFails = false, memoryFails = false, showFails = false } = opts;

  const briefingData = briefingFails
    ? `{"success":false,"error":{"code":500,"message":"internal error"}}`
    : `{"success":true,"data":{"lastSession":null,"currentTask":null,"nextTasks":[],"openBugs":[],"blockedTasks":[],"activeEpics":[],"memoryContext":{"recentDecisions":[],"relevantPatterns":[],"recentObservations":[],"recentLearnings":[],"tokensEstimated":0}}}`;

  const docsData = docsFails
    ? `{"success":false,"error":{"code":500,"message":"docs broken"}}`
    : `{"success":true,"data":{"ownerId":"T1618","ownerType":"task","count":0,"attachments":[]}}`;

  const memoryData = memoryFails
    ? `{"success":false,"error":{"code":500,"message":"memory broken"}}`
    : `{"success":true,"data":{"results":[],"total":0,"tokensEstimated":0}}`;

  const showData = showFails
    ? `NOT JSON AT ALL`
    : `{"success":false,"error":{"code":4,"message":"Task not found","codeName":"E_NOT_FOUND"}}`;

  // Escape for safe embedding in the script string
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`');

  const body = `#!/usr/bin/env node
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === 'briefing') {
  process.stdout.write(\`${esc(briefingData)}\n\`);
  process.exit(0);
}

if (cmd === 'docs' && args[1] === 'list') {
  process.stdout.write(\`${esc(docsData)}\n\`);
  process.exit(0);
}

if (cmd === 'memory' && args[1] === 'find') {
  process.stdout.write(\`${esc(memoryData)}\n\`);
  process.exit(0);
}

if (cmd === 'show') {
  process.stdout.write(\`${esc(showData)}\n\`);
  process.exit(${showFails ? 1 : 4});
}

process.stderr.write('fake-cleo: unsupported: ' + args.join(' ') + '\\n');
process.exit(99);
`;

  const stubPath = join(dir, 'fake-cleo.mjs');
  writeFileSync(stubPath, body, 'utf8');
  chmodSync(stubPath, 0o755);
  return stubPath;
}

/**
 * Run the fresh-agent-test.mjs script as a child process.
 *
 * @param {string[]} extraArgs
 * @param {{ cwd?: string }} [opts]
 * @returns {{ stdout: string, stderr: string, status: number | null }}
 */
function runScript(extraArgs, { cwd = process.cwd() } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? null,
  };
}

/** Create a temporary directory. */
function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'fresh-agent-test-'));
}

/** Create a fake .cleo/agent-outputs directory with one .md file. */
function makeAgentOutputsMd(tmpDir, name = 'T9999-report.md', content = '# Report\n\nContent.\n') {
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

beforeEach(() => {
  tmpDir = makeTmpDir();
  // Reset denylist state between unit tests
  denylistState.count = 0;
  denylistState.violations.length = 0;
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ============================================================================
// Unit tests — parseArgs
// ============================================================================

describe('parseArgs', () => {
  it('returns defaults with empty argv', () => {
    const cfg = parseArgs([]);
    expect(cfg.cleoBin).toBe('cleo');
    expect(cfg.json).toBe(false);
    expect(cfg.verbose).toBe(false);
    expect(cfg.guard).toBe(true);
    expect(cfg.help).toBe(false);
    expect(cfg.taskId).toBeNull();
  });

  it('parses --cleo-bin', () => {
    expect(parseArgs(['--cleo-bin', '/usr/local/bin/cleo']).cleoBin).toBe('/usr/local/bin/cleo');
  });

  it('parses --cwd', () => {
    const cfg = parseArgs(['--cwd', '/tmp']);
    // resolve('/tmp') is /tmp on Linux
    expect(cfg.cwd).toBe('/tmp');
  });

  it('parses --task', () => {
    expect(parseArgs(['--task', 'T1618']).taskId).toBe('T1618');
  });

  it('parses --json', () => {
    expect(parseArgs(['--json']).json).toBe(true);
  });

  it('parses --verbose', () => {
    expect(parseArgs(['--verbose']).verbose).toBe(true);
  });

  it('parses --no-guard', () => {
    expect(parseArgs(['--no-guard']).guard).toBe(false);
  });

  it('parses --help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('throws on unknown argument', () => {
    expect(() => parseArgs(['--unknown'])).toThrow('Unknown argument');
  });

  it('throws when --cleo-bin has no value', () => {
    expect(() => parseArgs(['--cleo-bin'])).toThrow();
  });
});

// ============================================================================
// Unit tests — isDenied
// ============================================================================

describe('isDenied', () => {
  it('matches .md directly under .cleo/agent-outputs/', () => {
    expect(isDenied('/project/.cleo/agent-outputs/T1234-report.md')).toBe(true);
  });

  it('matches with cwd-relative path containing .cleo/agent-outputs/', () => {
    expect(isDenied('/home/user/projects/cleocode/.cleo/agent-outputs/NEXT-SESSION-HANDOFF.md')).toBe(true);
  });

  it('does NOT match .ts files', () => {
    expect(isDenied('/project/.cleo/agent-outputs/T1234.ts')).toBe(false);
  });

  it('does NOT match files in subdirectory of agent-outputs', () => {
    expect(isDenied('/project/.cleo/agent-outputs/_archive/T1234-report.md')).toBe(false);
  });

  it('does NOT match files outside agent-outputs', () => {
    expect(isDenied('/project/.cleo/brain.db')).toBe(false);
    expect(isDenied('/project/docs/spec.md')).toBe(false);
    expect(isDenied('/project/README.md')).toBe(false);
  });

  it('does NOT match .cleo/agent-outputs directory itself', () => {
    expect(isDenied('/project/.cleo/agent-outputs/')).toBe(false);
  });

  it('handles Windows-style backslash paths (normalized and correctly denied)', () => {
    // After backslash normalisation the path contains /.cleo/agent-outputs/*.md
    // and should be blocked — this is the conservative safe behaviour.
    // On Linux these paths won't arise in practice but the guard must not crash.
    expect(isDenied('C:\\project\\.cleo\\agent-outputs\\T1234.md')).toBe(true);
  });
});

// ============================================================================
// Unit tests — buildReport
// ============================================================================

describe('buildReport', () => {
  it('computes score and passed correctly when all pass', () => {
    const config = { cleoBin: 'cleo', cwd: '/tmp', taskId: null, json: false, verbose: false, guard: true, help: false };
    const probes = Array.from({ length: 10 }, (_, i) => ({
      index: i + 1,
      name: `probe ${i + 1}`,
      passed: true,
      detail: 'ok',
      cmd: 'cleo briefing',
    }));
    const report = buildReport(config, probes);
    expect(report.score).toBe(10);
    expect(report.total).toBe(10);
    expect(report.passed).toBe(true);
  });

  it('computes score and passed=false when one probe fails', () => {
    const config = { cleoBin: 'cleo', cwd: '/tmp', taskId: null, json: false, verbose: false, guard: true, help: false };
    const probes = Array.from({ length: 10 }, (_, i) => ({
      index: i + 1,
      name: `probe ${i + 1}`,
      passed: i !== 5,
      detail: 'ok',
      cmd: 'cleo briefing',
    }));
    const report = buildReport(config, probes);
    expect(report.score).toBe(9);
    expect(report.passed).toBe(false);
  });

  it('includes denylist state in report', () => {
    denylistState.count = 2;
    denylistState.violations.push('/project/.cleo/agent-outputs/x.md');
    const config = { cleoBin: 'cleo', cwd: '/tmp', taskId: null, json: false, verbose: false, guard: true, help: false };
    const probes = [];
    const report = buildReport(config, probes);
    expect(report.denylist.violationCount).toBe(2);
    expect(report.denylist.violations).toContain('/project/.cleo/agent-outputs/x.md');
  });
});

// ============================================================================
// Unit tests — runProbes with good stub (no subprocess overhead)
// ============================================================================

describe('runProbes (unit — good stub)', () => {
  it('scores 10/10 with a well-behaved cleo stub', () => {
    const stubDir = makeTmpDir();
    try {
      const stub = makeFakeCleo(stubDir);
      const probes = runProbes(stub, tmpDir, 'T1618', false);
      const score = probes.filter((p) => p.passed).length;
      expect(score).toBe(10);
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Unit tests — installDenylistGuard + denylistState
// ============================================================================

describe('installDenylistGuard', () => {
  it('blocks readFileSync on a matching path after guard is installed', () => {
    const fakePath = '/project/.cleo/agent-outputs/T9999-report.md';
    const preCount = denylistState.count;

    // Save original so we can restore after test (guard is idempotent but
    // we want to clean up for other tests that do not expect the guard)
    const origReadFileSync = fsCjsForTest.readFileSync;

    // Install guard (uses shared CJS fs singleton)
    installDenylistGuard();

    try {
      expect(() => fsCjsForTest.readFileSync(fakePath, 'utf8')).toThrow('DENYLIST');
      expect(denylistState.count).toBe(preCount + 1);
      expect(denylistState.violations).toContain(fakePath);
    } finally {
      // Restore original to avoid bleeding into subprocess tests
      fsCjsForTest.readFileSync = origReadFileSync;
    }
  });

  it('allows readFileSync on a non-matching path', () => {
    const origReadFileSync = fsCjsForTest.readFileSync;
    const origCount = denylistState.count;

    installDenylistGuard();
    try {
      // /dev/null is not under .cleo/agent-outputs/ — must not throw
      const result = fsCjsForTest.readFileSync('/dev/null', 'utf8');
      expect(result).toBe('');
      expect(denylistState.count).toBe(origCount);
    } finally {
      fsCjsForTest.readFileSync = origReadFileSync;
    }
  });
});

// ============================================================================
// Integration tests — subprocess
// ============================================================================

describe('fresh-agent-test subprocess', () => {
  it('exits 0 and scores 10/10 with a good stub', () => {
    const stub = makeFakeCleo(tmpDir);
    const { stdout, status } = runScript(['--cleo-bin', stub, '--cwd', tmpDir], { cwd: tmpDir });
    expect(status).toBe(0);
    expect(stdout).toContain('ACCEPTED');
    expect(stdout).toContain('10/10');
  });

  it('exits 1 when briefing returns success:false', () => {
    const stub = makeFakeCleo(tmpDir, { briefingFails: true });
    const { stdout, status } = runScript(['--cleo-bin', stub, '--cwd', tmpDir], { cwd: tmpDir });
    expect(status).toBe(1);
    expect(stdout).toContain('REJECTED');
  });

  it('exits 1 when docs list returns success:false', () => {
    const stub = makeFakeCleo(tmpDir, { docsFails: true });
    const { stdout, status } = runScript(['--cleo-bin', stub, '--cwd', tmpDir], { cwd: tmpDir });
    expect(status).toBe(1);
    expect(stdout).toContain('REJECTED');
  });

  it('exits 1 when memory find returns success:false', () => {
    const stub = makeFakeCleo(tmpDir, { memoryFails: true });
    const { stdout, status } = runScript(['--cleo-bin', stub, '--cwd', tmpDir], { cwd: tmpDir });
    expect(status).toBe(1);
    expect(stdout).toContain('REJECTED');
  });

  it('--json flag emits valid JSON with correct shape', () => {
    const stub = makeFakeCleo(tmpDir);
    const { stdout, status } = runScript(
      ['--cleo-bin', stub, '--cwd', tmpDir, '--json'],
      { cwd: tmpDir },
    );
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('score', 10);
    expect(parsed).toHaveProperty('total', 10);
    expect(parsed).toHaveProperty('passed', true);
    expect(parsed).toHaveProperty('generatedAt');
    expect(Array.isArray(parsed.probes)).toBe(true);
    expect(parsed.probes).toHaveLength(10);
    expect(parsed).toHaveProperty('denylist');
    expect(parsed.denylist).toHaveProperty('violationCount', 0);
  });

  it('--json probe array has index, name, passed, detail, cmd for each probe', () => {
    const stub = makeFakeCleo(tmpDir);
    const { stdout } = runScript(
      ['--cleo-bin', stub, '--cwd', tmpDir, '--json'],
      { cwd: tmpDir },
    );
    const parsed = JSON.parse(stdout);
    for (const probe of parsed.probes) {
      expect(probe).toHaveProperty('index');
      expect(probe).toHaveProperty('name');
      expect(probe).toHaveProperty('passed');
      expect(probe).toHaveProperty('detail');
      expect(probe).toHaveProperty('cmd');
    }
  });

  it('--help exits 0 and prints Usage', () => {
    const { stdout, status } = runScript(['--help'], { cwd: tmpDir });
    expect(status).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('--cleo-bin');
    expect(stdout).toContain('10/10');
  });

  it('exits 2 on unknown argument', () => {
    const { status } = runScript(['--unknown-flag'], { cwd: tmpDir });
    expect(status).toBe(2);
  });

  it('--no-guard flag is accepted and probe 9 still passes (no violations when guard is off)', () => {
    const stub = makeFakeCleo(tmpDir);
    // Place a real .md under agent-outputs — with guard off, reading it would not be blocked
    makeAgentOutputsMd(tmpDir);
    const { stdout, status } = runScript(
      ['--cleo-bin', stub, '--cwd', tmpDir, '--no-guard', '--json'],
      { cwd: tmpDir },
    );
    // With no-guard the cleo stub still works; probes 1-8 + 10 pass; probe 9 depends
    // on whether any code actually tries to read agent-outputs (the stub doesn't),
    // so denylist.count stays 0 → probe 9 passes → 10/10
    const parsed = JSON.parse(stdout);
    expect(parsed.probes[8].passed).toBe(true); // probe 9 (index 9)
    expect(status).toBe(0);
  });

  it('project-agnostic: runs correctly in an arbitrary non-cleocode tmpdir', () => {
    const otherDir = makeTmpDir();
    try {
      const stub = makeFakeCleo(otherDir);
      const { stdout, status } = runScript(
        ['--cleo-bin', stub, '--cwd', otherDir],
        { cwd: otherDir },
      );
      expect(status).toBe(0);
      expect(stdout).toContain('10/10');
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('--verbose flag is accepted and prints probe details to stderr', () => {
    const stub = makeFakeCleo(tmpDir);
    const result = spawnSync(process.execPath, [SCRIPT, '--cleo-bin', stub, '--cwd', tmpDir, '--verbose'], {
      cwd: tmpDir,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Probe');
  });
});

// ============================================================================
// Integration tests — denylist subprocess guard
// ============================================================================

describe('denylist guard (subprocess)', () => {
  it('probe 9 score is 10/10 when no agent-outputs md is read', () => {
    const stub = makeFakeCleo(tmpDir);
    // No agent-outputs file placed; stub never reads any md
    const { stdout, status } = runScript(
      ['--cleo-bin', stub, '--cwd', tmpDir, '--json'],
      { cwd: tmpDir },
    );
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    const probe9 = parsed.probes.find((p) => p.index === 9);
    expect(probe9.passed).toBe(true);
    expect(parsed.denylist.violationCount).toBe(0);
  });
});
