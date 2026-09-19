/**
 * Vitest global setup — runs once per test fork, before any test file imports
 * library code. Provides a second layer of defense against the production-DB
 * leak vector that introduced T9001…T9020 fixtures into tasks.db on
 * 2026-05-06.
 *
 * The first layer is the path-isolation guard inside `openNativeDatabase`
 * (packages/core/src/store/sqlite-native.ts) — it throws synchronously if
 * any test ever opens a SQLite file outside `os.tmpdir()`. This setup file
 * makes it harder for that guard to fire by pinning every per-fork
 * "global" CLEO root to an ephemeral temp directory.
 *
 * Concretely:
 *   - `CLEO_HOME` is set to a fresh `mkdtempSync` path under `os.tmpdir()`,
 *     scoped per fork. Resolves global signaldock.db, brain global pages,
 *     and worktree storage to throwaway directories.
 *   - `NEXUS_HOME` and `NEXUS_CACHE_DIR` follow `CLEO_HOME` so the global
 *     Nexus database also lives in tmp.
 *   - Inherited runtime roots are always replaced, including HOME and temp
 *     variables. Test fixtures must never walk from a host temp directory
 *     into a real ancestor .cleo directory. Explicit per-test overrides
 *     belong in that test, after this setup has established isolation.
 *
 * Tests that need to override these (e.g. nexus/transfer.test.ts) can still
 * set them in their own `beforeEach` — that mutation lives only inside the
 * fork's process and overrides the default established here.
 */

import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// We must patch the CommonJS `child_process` module object so every importer
// (ESM and CJS) sees the wrapped functions. The ESM namespace object is
// read-only, so we use createRequire to reach the underlying CJS export.
const cjsRequire = createRequire(import.meta.url);
const child_process: Record<string, unknown> = cjsRequire('node:child_process');

// Resolve the platform temp default without inherited host overrides. A TMPDIR
// below the developer's home can make ancestor discovery bind ~/.cleo even
// after HOME is replaced. Never create the test sandbox beneath that path.
for (const name of ['TMPDIR', 'TMP', 'TEMP']) delete process.env[name];
const sandbox = mkdtempSync(join(tmpdir(), 'cleo-vitest-fork-'));
const isolatedRoots = {
  HOME: join(sandbox, 'home'),
  USERPROFILE: join(sandbox, 'home'),
  TMPDIR: join(sandbox, 'tmp'),
  TMP: join(sandbox, 'tmp'),
  TEMP: join(sandbox, 'tmp'),
  XDG_DATA_HOME: join(sandbox, 'data-home'),
  XDG_CONFIG_HOME: join(sandbox, 'config-home'),
  XDG_CACHE_HOME: join(sandbox, 'cache-home'),
  XDG_RUNTIME_DIR: join(sandbox, 'runtime'),
  CLEO_HOME: sandbox,
  CLEO_CONFIG_HOME: join(sandbox, 'cleo-config'),
  CLEO_ROOT: join(sandbox, 'project'),
  CLEO_DIR: join(sandbox, 'project', '.cleo'),
  AGENTS_HOME: join(sandbox, 'agents'),
  NEXUS_HOME: join(sandbox, 'nexus'),
  NEXUS_CACHE_DIR: join(sandbox, 'nexus', 'cache'),
};
for (const [name, directory] of Object.entries(isolatedRoots)) {
  mkdirSync(directory, { recursive: true });
  process.env[name] = directory;
}
// A parent process cannot opt an ordinary unit-test fork into a real store.
// Deliberate integration fixtures may set scoped overrides after setup.
delete process.env.CLEO_TEST_ALLOW_PROJECT_DB;
delete process.env.CLEO_TEST_ALLOWED_DB_ROOTS;
process.env.CLEO_DISABLE_LOCAL_INFERENCE = '1';
// Tests do not need real signaldock peer permission checks.
if (!process.env.NEXUS_SKIP_PERMISSION_CHECK) {
  process.env.NEXUS_SKIP_PERMISSION_CHECK = 'true';
}

// ---------------------------------------------------------------------------
// Identity-pollution guard. Any test that issues
//   `git config <field> <value>`  (no --global / --system / --get / --list)
// against a target outside the system tmpdir is blocked. Historical failure
// mode: a test forgets `cwd: <tmpdir>` or `-C <tmpdir>`, falls through to
// the inherited cwd (the project root), and silently overwrites
// `<project>/.git/config` — pinning the developer's committer identity to
// `Test <test@example.com>` for every subsequent commit until they notice.
// This guard makes that impossible regardless of which test misbehaves.
//
// Read forms (--get / --list / --unset / etc.) and explicitly scoped writes
// (--global / --system / --worktree / --file) are always allowed.
// ---------------------------------------------------------------------------

interface GitConfigCall {
  isLocalWrite: boolean;
  field: string | undefined;
}

function analyzeGitArgs(args: readonly string[] | undefined): GitConfigCall {
  if (!args || args.length === 0) return { isLocalWrite: false, field: undefined };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-C' || a === '-c') {
      i += 2;
      continue;
    }
    if (typeof a === 'string' && a.startsWith('--') && a !== '--') {
      i++;
      continue;
    }
    break;
  }
  if (args[i] !== 'config') return { isLocalWrite: false, field: undefined };

  let scoped = false;
  let isRead = false;
  let field: string | undefined;
  let valueSeen = false;
  for (let j = i + 1; j < args.length; j++) {
    const a = args[j];
    if (typeof a !== 'string') continue;
    switch (a) {
      case '--global':
      case '--system':
      case '--worktree':
      case '--file':
      case '-f':
        scoped = true;
        break;
      case '--get':
      case '--get-all':
      case '--get-regexp':
      case '--get-urlmatch':
      case '--list':
      case '-l':
      case '--unset':
      case '--unset-all':
      case '--remove-section':
      case '--rename-section':
      case '--show-origin':
      case '--show-scope':
      case '-e':
      case '--edit':
        isRead = true;
        break;
      default:
        if (!a.startsWith('-')) {
          if (field === undefined) field = a;
          else valueSeen = true;
        }
        break;
    }
  }
  if (scoped || isRead) return { isLocalWrite: false, field };
  if (field === undefined || !valueSeen) return { isLocalWrite: false, field };
  return { isLocalWrite: true, field };
}

function extractTargetCwd(args: readonly string[] | undefined, opts: unknown): string {
  if (args) {
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-C') return resolve(String(args[i + 1]));
    }
  }
  if (opts && typeof opts === 'object' && 'cwd' in opts) {
    const v = (opts as { cwd?: unknown }).cwd;
    if (typeof v === 'string' && v.length > 0) return resolve(v);
  }
  return resolve(process.cwd());
}

const SYSTEM_TMP = (() => {
  try {
    return realpathSync(tmpdir());
  } catch {
    return tmpdir();
  }
})();
const HOME_TMP = process.env.HOME ? resolve(process.env.HOME, '.temp') : undefined;

function isUnderTmp(target: string): boolean {
  let real = target;
  try {
    real = realpathSync(target);
  } catch {
    // path may not exist yet — fall back to lexical check
  }
  if (real === SYSTEM_TMP || real.startsWith(`${SYSTEM_TMP}/`)) return true;
  if (HOME_TMP && (real === HOME_TMP || real.startsWith(`${HOME_TMP}/`))) return true;
  return false;
}

function isGitCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false;
  if (cmd === 'git') return true;
  return cmd.endsWith('/git') || cmd.endsWith('\\git') || cmd.endsWith('\\git.exe');
}

function guardGitConfig(
  cmd: unknown,
  args: readonly string[] | undefined,
  opts: unknown,
): void {
  if (!isGitCommand(cmd)) return;
  const { isLocalWrite, field } = analyzeGitArgs(args);
  if (!isLocalWrite) return;
  const target = extractTargetCwd(args, opts);
  if (isUnderTmp(target)) return;
  const lines = [
    'git config write blocked by vitest.setup.ts identity-pollution guard.',
    `  field:   ${field}`,
    `  args:    ${(args ?? []).join(' ')}`,
    `  target:  ${target}`,
    `  tmpdir:  ${SYSTEM_TMP}`,
    '',
    'Tests MUST pass `cwd: <tmpdir>` or `-C <tmpdir>` so writes never escape',
    "the system tmpdir. This guard prevents tests from corrupting the host",
    "project's `.git/config` (committer identity, etc.).",
  ];
  throw new Error(lines.join('\n'));
}

type AnyFn = (...a: unknown[]) => unknown;
function wrap(name: string, argIdx: 1, optsIdx: 1 | 2): void {
  const original = child_process[name];
  if (typeof original !== 'function') return;
  const wrapped: AnyFn = (...a: unknown[]) => {
    const cmd = a[0];
    const args = a[argIdx] as readonly string[] | undefined;
    const opts = a[optsIdx];
    guardGitConfig(cmd, args, opts);
    return (original as AnyFn).apply(child_process, a);
  };
  // Preserve any custom promisify behaviour (`execFile` ships a
  // `util.promisify.custom` symbol so `promisify(execFile)` resolves with
  // `{ stdout, stderr }` rather than the raw child process).
  for (const sym of Object.getOwnPropertySymbols(original as object)) {
    const value = (original as unknown as Record<symbol, unknown>)[sym];
    (wrapped as unknown as Record<symbol, unknown>)[sym] = value;
  }
  // Direct property assignment works on the CJS module object (see
  // `createRequire` above). Falls through silently if the property is
  // unexpectedly read-only — the existing implementation still runs.
  try {
    child_process[name] = wrapped;
  } catch {
    /* read-only export; skip wrap */
  }
}

// spawn / spawnSync / execFile / execFileSync all use (command, args, options).
// exec / execSync take a shell-string and aren't used for project git calls.
wrap('spawn', 1, 2);
wrap('spawnSync', 1, 2);
wrap('execFile', 1, 2);
wrap('execFileSync', 1, 2);
