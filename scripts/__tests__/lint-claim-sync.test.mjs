/**
 * Tests for scripts/lint-claim-sync.mjs.
 *
 * Strategy:
 *   - Build an isolated `cwd` under tmpdir with a fake `.cleo/agent-outputs/`
 *     and a stub `cleo` binary on PATH that returns canned `cleo show <id>
 *     --json` envelopes for known IDs.
 *   - Drive the linter via `--cleo-bin <path-to-stub>` so we exercise the real
 *     spawn path without depending on the global cleo install.
 *
 * Coverage:
 *   1. "T1244 shipped" claim + cleo says status=done → no mismatch
 *   2. "T1568 complete" claim + cleo says status=pending → mismatch + exit 1
 *      under `--severity error`
 *   3. "predecessor claimed T1492 done" → uncertainty marker, no mismatch
 *   4. "T1700 done — ⚠ UNVERIFIED" → uncertainty tag, no mismatch
 *   5. Project-agnostic — runs against a fixture in non-cleocode tmp dir
 *   6. JSON output shape contains `mismatches[]` + `summary`
 *   7. `--severity warn` exits 0 even with mismatches
 *   8. Quoted lines (`> T123 done`) and table rows (`| T123 done |`) skipped
 *
 * @task T1598
 * @epic T1586
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lint-claim-sync.mjs');

/**
 * Build a fake `cleo` shell script that reads `cleo show <id> --json` and
 * emits the JSON envelope from the supplied state map. Unknown IDs receive a
 * not-found error envelope (success=false).
 *
 * @param {string} cwd
 * @param {Record<string, { status: string, verificationPassed?: boolean }>} states
 * @returns {string} absolute path to the executable stub
 */
function makeFakeCleo(cwd, states) {
  const path = join(cwd, 'fake-cleo.mjs');
  const body = `#!/usr/bin/env node
const states = ${JSON.stringify(states)};
const args = process.argv.slice(2);
if (args[0] !== 'show') {
  process.stderr.write('fake-cleo only implements show\\n');
  process.exit(99);
}
const id = args[1];
const state = states[id];
if (!state) {
  process.stdout.write(JSON.stringify({
    success: false,
    error: { code: 'E_NOT_FOUND', message: 'task ' + id + ' not found' },
    data: null,
  }) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  success: true,
  data: {
    task: {
      id,
      status: state.status,
      verification: { passed: !!state.verificationPassed },
    },
  },
}) + '\\n');
process.exit(0);
`;
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

/**
 * Run the linter under a temp cwd. Returns {status, stdout, stderr}.
 *
 * @param {{
 *   cwd: string,
 *   args?: string[],
 *   cleoBin: string,
 * }} opts
 */
function runLinter(opts) {
  const argv = [SCRIPT, '--cleo-bin', opts.cleoBin, '--cwd', opts.cwd, ...(opts.args ?? [])];
  const result = spawnSync(process.execPath, argv, {
    encoding: 'utf8',
    cwd: opts.cwd,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Write a markdown report under `<cwd>/.cleo/agent-outputs/<rel>`.
 *
 * @param {string} cwd
 * @param {string} rel
 * @param {string} content
 */
function writeReport(cwd, rel, content) {
  const full = join(cwd, '.cleo', 'agent-outputs', rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

describe('lint-claim-sync.mjs', () => {
  /** @type {string[]} */
  let dirs;

  beforeEach(() => {
    dirs = [];
  });

  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function makeCwd() {
    const dir = mkdtempSync(join(tmpdir(), 'cleo-claim-sync-'));
    dirs.push(dir);
    return dir;
  }

  it('reports zero mismatches when claim agrees with cleo state (status=done)', () => {
    const cwd = makeCwd();
    writeReport(cwd, 'good.md', '# report\n\nT1244 shipped in v2026.4.150.\n');
    const cleo = makeFakeCleo(cwd, { T1244: { status: 'done', verificationPassed: true } });
    const r = runLinter({ cwd, cleoBin: cleo });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/claim-sync: OK/);
  });

  it('flags a mismatch when claim says complete but cleo says pending', () => {
    const cwd = makeCwd();
    writeReport(cwd, 'bad.md', '## summary\n\nT1568 complete — engine migrated.\n');
    const cleo = makeFakeCleo(cwd, { T1568: { status: 'pending', verificationPassed: false } });
    const r = runLinter({ cwd, cleoBin: cleo, args: ['--severity', 'error'] });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/T1568/);
    expect(r.stdout).toMatch(/mismatch/i);
  });

  it('warn-only severity exits 0 even with mismatches', () => {
    const cwd = makeCwd();
    writeReport(cwd, 'bad.md', 'T1568 complete — engine migrated.\n');
    const cleo = makeFakeCleo(cwd, { T1568: { status: 'pending' } });
    const r = runLinter({ cwd, cleoBin: cleo, args: ['--severity', 'warn'] });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/T1568/);
  });

  it('skips lines with uncertainty markers ("predecessor claimed")', () => {
    const cwd = makeCwd();
    writeReport(cwd, 'hedged.md', '> note: predecessor claimed T1492 done — needs audit.\n');
    const cleo = makeFakeCleo(cwd, { T1492: { status: 'pending' } });
    const r = runLinter({ cwd, cleoBin: cleo, args: ['--severity', 'error'] });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/claim-sync: OK/);
  });

  it('skips lines tagged with ⚠ UNVERIFIED', () => {
    const cwd = makeCwd();
    writeReport(cwd, 'unverified.md', 'T1700 done — ⚠ UNVERIFIED, awaiting confirmation.\n');
    const cleo = makeFakeCleo(cwd, { T1700: { status: 'pending' } });
    const r = runLinter({ cwd, cleoBin: cleo, args: ['--severity', 'error'] });
    expect(r.status).toBe(0);
  });

  it('skips quoted/table-prefixed lines', () => {
    const cwd = makeCwd();
    writeReport(
      cwd,
      'quoted.md',
      [
        '# table',
        '',
        '| Task | Status |',
        '| --- | --- |',
        '| T2000 done | shipped |',
        '',
        '> T2001 complete (per old handoff)',
        '',
      ].join('\n'),
    );
    const cleo = makeFakeCleo(cwd, {
      T2000: { status: 'pending' },
      T2001: { status: 'pending' },
    });
    const r = runLinter({ cwd, cleoBin: cleo, args: ['--severity', 'error'] });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/claim-sync: OK/);
  });

  it('emits structured JSON with summary + mismatches[] under --json', () => {
    const cwd = makeCwd();
    writeReport(cwd, 'mixed.md', 'T100 shipped\nT200 done\n');
    const cleo = makeFakeCleo(cwd, {
      T100: { status: 'done', verificationPassed: true },
      T200: { status: 'pending' },
    });
    const r = runLinter({ cwd, cleoBin: cleo, args: ['--json'] });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.summary.claims).toBeGreaterThanOrEqual(2);
    expect(parsed.summary.mismatches).toBe(1);
    expect(parsed.mismatches[0].taskId).toBe('T200');
    expect(parsed.mismatches[0].actualStatus).toBe('pending');
  });

  it('treats not-found task IDs as mismatches', () => {
    const cwd = makeCwd();
    writeReport(cwd, 'ghost.md', 'T9999 shipped to prod.\n');
    const cleo = makeFakeCleo(cwd, {});
    const r = runLinter({ cwd, cleoBin: cleo, args: ['--severity', 'error', '--json'] });
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.mismatches[0].actualStatus).toBe('not-found');
  });

  it('honors --ignore to skip files by path substring', () => {
    const cwd = makeCwd();
    writeReport(cwd, 'old/handoff.md', 'T300 complete.\n');
    writeReport(cwd, 'fresh.md', 'T400 complete.\n');
    const cleo = makeFakeCleo(cwd, {
      T300: { status: 'pending' },
      T400: { status: 'done' },
    });
    const r = runLinter({
      cwd,
      cleoBin: cleo,
      args: ['--ignore', 'old/', '--severity', 'error'],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/claim-sync: OK/);
  });

  it('runs project-agnostically in a non-cleocode tmpdir with no other setup', () => {
    const cwd = makeCwd();
    // Sanity: the tmpdir is NOT inside /mnt/projects/cleocode/.
    expect(cwd.startsWith(REPO_ROOT)).toBe(false);
    writeReport(cwd, 'report.md', 'T501 shipped.\n');
    const cleo = makeFakeCleo(cwd, { T501: { status: 'done' } });
    const r = runLinter({ cwd, cleoBin: cleo, args: ['--severity', 'error'] });
    expect(r.status).toBe(0);
  });

  it('handles missing .cleo/agent-outputs/ directory gracefully', () => {
    const cwd = makeCwd();
    const cleo = makeFakeCleo(cwd, {});
    const r = runLinter({ cwd, cleoBin: cleo });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/0 file/);
  });

  it('prints --help and exits 0', () => {
    const cwd = makeCwd();
    const cleo = makeFakeCleo(cwd, {});
    const r = runLinter({ cwd, cleoBin: cleo, args: ['--help'] });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: lint-claim-sync/);
  });
});
