/**
 * Tests for scripts/hooks/commit-msg-release-lint.mjs.
 *
 * Verifies the commit-msg lint rule that mandates T-prefixed task IDs in
 * release commits (subject matches /^(chore|feat)\(release\):/).
 *
 * Coverage:
 *   1. Non-release commit (subject doesn't match pattern) → exit 0
 *   2. Release commit with T<digit>+ in body              → exit 0
 *   3. Release commit without task ID                     → exit 1
 *   4. Release commit + CLEO_OWNER_OVERRIDE=1 + reason    → exit 0 + audit row
 *   5. Release commit + override but missing reason       → exit 1
 *   6. Missing message-file argument                      → exit 2
 *
 * @task T1410
 * @epic T1407
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const HOOK_SCRIPT = join(REPO_ROOT, 'scripts', 'hooks', 'commit-msg-release-lint.mjs');

/**
 * Run the hook in a temp cwd so that `.cleo/audit/force-bypass.jsonl` writes
 * stay isolated from the real repo audit log.
 *
 * @param {string} message - Commit message contents.
 * @param {object} [options] - Spawn options.
 * @param {Record<string, string>} [options.env] - Env vars to add (preserves PATH).
 * @param {string} [options.cwd] - Working directory.
 * @param {string[]} [options.argv] - Override argv (used to test missing-arg path).
 * @returns {{status: number, stdout: string, stderr: string, msgFile: string}}
 */
function runHook(message, options = {}) {
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), 'cleo-hook-test-'));
  const msgFile = join(cwd, 'COMMIT_EDITMSG');
  writeFileSync(msgFile, message, 'utf8');
  const argv = options.argv ?? [HOOK_SCRIPT, msgFile];
  const result = spawnSync(process.execPath, argv, {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    msgFile,
    cwd,
  };
}

describe('commit-msg-release-lint.mjs', () => {
  let tempDirs;

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function makeCwd() {
    const dir = mkdtempSync(join(tmpdir(), 'cleo-hook-test-'));
    tempDirs.push(dir);
    return dir;
  }

  it('exits 0 for non-release commits regardless of task IDs', () => {
    const cwd = makeCwd();
    const r = runHook('fix: random fix\n\nNo task ID at all here.\n', { cwd });
    expect(r.status).toBe(0);
  });

  it('exits 0 for release commit that cites a T<digit>+ task ID', () => {
    const cwd = makeCwd();
    const r = runHook('feat(release): v2026.4.144\n\nRefs: T1407\n', { cwd });
    expect(r.status).toBe(0);
  });

  it('exits 0 for chore(release) commit citing a task ID anywhere in body', () => {
    const cwd = makeCwd();
    const r = runHook(
      'chore(release): v2026.4.144\n\nThis ships behavior tied to T999 and friends.\n',
      { cwd },
    );
    expect(r.status).toBe(0);
  });

  it('exits 1 for release commit without any T<digit>+ reference', () => {
    const cwd = makeCwd();
    const r = runHook('chore(release): v2026.4.144\n\nNo references whatsoever.\n', {
      cwd,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/lacks any T<digit>\+ task reference/);
  });

  it('bypasses with CLEO_OWNER_OVERRIDE=1 + reason; appends audit row', () => {
    const cwd = makeCwd();
    // Pre-create .cleo/audit so we can read it after; the hook also creates it.
    mkdirSync(join(cwd, '.cleo', 'audit'), { recursive: true });
    const r = runHook('chore(release): v2026.4.144\n\nNo task ID, but bypassed.\n', {
      cwd,
      env: {
        CLEO_OWNER_OVERRIDE: '1',
        CLEO_OWNER_OVERRIDE_REASON: 'incident 9999 hotfix',
      },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/BYPASSED/);

    const auditPath = join(cwd, '.cleo', 'audit', 'force-bypass.jsonl');
    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.hook).toBe('commit-msg-release-lint');
    expect(last.reason).toBe('incident 9999 hotfix');
    expect(last.subject).toBe('chore(release): v2026.4.144');
    expect(typeof last.timestamp).toBe('string');
  });

  it('rejects override with missing reason (env var unset)', () => {
    const cwd = makeCwd();
    const r = runHook('chore(release): v2026.4.144\n\nNo task ID; override missing reason.\n', {
      cwd,
      env: {
        CLEO_OWNER_OVERRIDE: '1',
        // CLEO_OWNER_OVERRIDE_REASON intentionally absent
        CLEO_OWNER_OVERRIDE_REASON: '',
      },
    });
    expect(r.status).toBe(1);
  });

  it('exits 2 when invoked without a message file argument', () => {
    const cwd = makeCwd();
    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
      encoding: 'utf8',
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/missing message file argument/);
  });
});
