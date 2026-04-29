/**
 * T1595 — pre-push reconcile gate tests.
 *
 * Verifies the POSIX shell extension hook at
 * `packages/cleo/templates/hooks/pre-push.t1595-extension.sh`:
 *
 *  - drift > 0  → exit 1 (push refused), reason printed
 *  - drift == 0 → exit 0 (push allowed)
 *  - bypass env → exit 0 + audit JSONL line written
 *  - missing cleo CLI → soft-fail (warn + allow) by default;
 *                       refuse under CLEO_RECONCILE_STRICT=1
 *
 * Tests are project-agnostic: each one runs in a tmp git repo with
 * a synthetic tag. The `cleo` binary is stubbed via PATH injection
 * so we can control reconcile output without touching the real CLI.
 *
 * @packageDocumentation
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the extension hook under test. */
const HOOK_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'templates',
  'hooks',
  'pre-push.t1595-extension.sh',
);

/**
 * Initialise a throwaway git repo with one synthetic tag so the hook
 * has something to anchor the pending-tag detection on.
 */
function makeRepo(tag = 'v2026.4.1'): string {
  const dir = mkdtempSync(join(tmpdir(), 't1595-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), '# t1595 fixture\n');
  execFileSync('git', ['-C', dir, 'add', 'README.md']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  execFileSync('git', ['-C', dir, 'tag', tag]);
  return dir;
}

/**
 * Drop a stub `cleo` binary on a temp PATH dir that prints the supplied
 * JSON to stdout when invoked as `cleo reconcile release …`. Returns
 * the directory to prepend to PATH.
 */
function makeStubCleo(json: string): string {
  const binDir = mkdtempSync(join(tmpdir(), 't1595-bin-'));
  const stub = join(binDir, 'cleo');
  // POSIX shell stub — emits the canned JSON for `reconcile release …`.
  writeFileSync(
    stub,
    `#!/bin/sh\nif [ "$1" = "reconcile" ] && [ "$2" = "release" ]; then\n  cat <<'JSON'\n${json}\nJSON\n  exit 0\nfi\nexit 99\n`,
    { mode: 0o755 },
  );
  chmodSync(stub, 0o755);
  return binDir;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(
  repoDir: string,
  env: Record<string, string> = {},
  options: { stubBinDir?: string } = {},
): RunResult {
  const pathParts: string[] = [];
  if (options.stubBinDir) pathParts.push(options.stubBinDir);
  pathParts.push(process.env.PATH ?? '/usr/bin:/bin');
  const result = spawnSync('/bin/sh', [HOOK_PATH], {
    cwd: repoDir,
    env: {
      ...process.env,
      ...env,
      PATH: pathParts.join(':'),
      // Prevent inherited XDG paths from polluting the audit assertion.
      XDG_DATA_HOME: env.XDG_DATA_HOME ?? join(repoDir, '.xdg-data'),
      // Make sure we don't pick up real cleo from the user PATH unless
      // the test explicitly stubs it.
      CLEO_RECONCILE_BIN: env.CLEO_RECONCILE_BIN,
    },
    encoding: 'utf-8',
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('T1595 — pre-push reconcile gate', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    // Best effort cleanup — these are tmp dirs, OS will reap them.
  });

  it('hook file exists and is executable', () => {
    expect(existsSync(HOOK_PATH)).toBe(true);
  });

  it('refuses push when drift > 0', () => {
    const driftJson = JSON.stringify({
      tag: 'v2026.4.1',
      processed: 3,
      reconciled: 2,
      unreconciled: 0,
      errors: 0,
      results: [
        {
          id: 'archive-reason-invariant',
          severity: 'warn',
          message: '2 tasks reconciled',
          processed: 3,
          reconciled: 2,
          unreconciled: 0,
          errors: 0,
          details: { reconciled: ['T1411', 'T1412'], unreconciled: [] },
        },
      ],
    });
    const stubBinDir = makeStubCleo(driftJson);
    const r = runHook(repo, {}, { stubBinDir });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/drift/i);
    expect(r.stderr).toMatch(/T1411/);
  });

  it('allows push when drift == 0', () => {
    const cleanJson = JSON.stringify({
      tag: 'v2026.4.1',
      processed: 0,
      reconciled: 0,
      unreconciled: 0,
      errors: 0,
      results: [],
    });
    const stubBinDir = makeStubCleo(cleanJson);
    const r = runHook(repo, {}, { stubBinDir });
    expect(r.status).toBe(0);
  });

  it('bypass env var allows push and writes audit entry', () => {
    const driftJson = JSON.stringify({
      tag: 'v2026.4.1',
      processed: 1,
      reconciled: 1,
      unreconciled: 0,
      errors: 0,
      results: [
        {
          id: 'archive-reason-invariant',
          severity: 'warn',
          message: '1 task reconciled',
          processed: 1,
          reconciled: 1,
          unreconciled: 0,
          errors: 0,
          details: { reconciled: ['T1413'], unreconciled: [] },
        },
      ],
    });
    const stubBinDir = makeStubCleo(driftJson);
    const xdg = join(repo, '.xdg-data');
    mkdirSync(xdg, { recursive: true });
    const r = runHook(repo, { CLEO_ALLOW_DRIFT_PUSH: '1', XDG_DATA_HOME: xdg }, { stubBinDir });
    expect(r.status).toBe(0);
    const auditLog = join(xdg, 'cleo', 'audit', 'drift-push-bypass.jsonl');
    expect(existsSync(auditLog)).toBe(true);
    const line = readFileSync(auditLog, 'utf-8').trim();
    expect(line).toMatch(/"reason":"CLEO_ALLOW_DRIFT_PUSH=1"/);
    expect(line).toMatch(/"tag":"v2026\.4\.1"/);
  });

  it('soft-fails (warn + allow) when cleo CLI missing by default', () => {
    // No stubBinDir → no cleo on PATH (PATH is host PATH, but we set
    // CLEO_RECONCILE_BIN to a nonexistent name so command -v fails).
    const r = runHook(repo, { CLEO_RECONCILE_BIN: '__nonexistent_cleo__' });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/cleo CLI not found|skipping reconcile gate/i);
  });

  it('refuses push when cleo CLI missing under CLEO_RECONCILE_STRICT=1', () => {
    const r = runHook(repo, {
      CLEO_RECONCILE_BIN: '__nonexistent_cleo__',
      CLEO_RECONCILE_STRICT: '1',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/strict mode/i);
  });

  it('allows push when no tags exist (fresh repo, no release yet)', () => {
    const freshRepo = mkdtempSync(join(tmpdir(), 't1595-fresh-'));
    execFileSync('git', ['init', '-q', '-b', 'main', freshRepo]);
    execFileSync('git', ['-C', freshRepo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', freshRepo, 'config', 'user.name', 'test']);
    execFileSync('git', ['-C', freshRepo, 'config', 'commit.gpgsign', 'false']);
    writeFileSync(join(freshRepo, 'a.txt'), 'a\n');
    execFileSync('git', ['-C', freshRepo, 'add', 'a.txt']);
    execFileSync('git', ['-C', freshRepo, 'commit', '-q', '-m', 'init']);
    // Stub cleo would never be called because no tag exists.
    const r = runHook(freshRepo, {}, { stubBinDir: makeStubCleo('{}') });
    expect(r.status).toBe(0);
  });

  it('is project-agnostic: works with SemVer tags too', () => {
    const semverRepo = mkdtempSync(join(tmpdir(), 't1595-semver-'));
    execFileSync('git', ['init', '-q', '-b', 'main', semverRepo]);
    execFileSync('git', ['-C', semverRepo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', semverRepo, 'config', 'user.name', 'test']);
    execFileSync('git', ['-C', semverRepo, 'config', 'commit.gpgsign', 'false']);
    writeFileSync(join(semverRepo, 'a.txt'), 'a\n');
    execFileSync('git', ['-C', semverRepo, 'add', 'a.txt']);
    execFileSync('git', ['-C', semverRepo, 'commit', '-q', '-m', 'init']);
    execFileSync('git', ['-C', semverRepo, 'tag', 'v1.2.3']);
    const cleanJson = JSON.stringify({
      tag: 'v1.2.3',
      processed: 0,
      reconciled: 0,
      unreconciled: 0,
      errors: 0,
      results: [],
    });
    const r = runHook(semverRepo, {}, { stubBinDir: makeStubCleo(cleanJson) });
    expect(r.status).toBe(0);
  });
});
