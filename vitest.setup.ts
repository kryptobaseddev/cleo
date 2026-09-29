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

import { createRequire, syncBuiltinESMExports } from 'node:module';
import {
  existsSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { afterAll, afterEach, beforeEach, expect } from 'vitest';

// We must patch the CommonJS `child_process` module object so every importer
// (ESM and CJS) sees the wrapped functions. The ESM namespace object is
// read-only, so we use createRequire to reach the underlying CJS export.
const cjsRequire = createRequire(import.meta.url);
const child_process: Record<string, unknown> = cjsRequire('node:child_process');

// ---------------------------------------------------------------------------
// Real data dir, captured BEFORE the sandbox below replaces HOME / CLEO_HOME.
// The write guard at the end of this file refuses every test write under it
// (T12645: caamp tests left 53 skill fixtures in the real
// `~/Library/Application Support/cleo/skills`). This setup can run twice in
// one fork (root config + a package config that names it too); the first
// run's capture is kept, because by the second run HOME is already the
// sandbox.
// ---------------------------------------------------------------------------
const PROTECTED_ROOTS_ENV = 'CLEO_TEST_PROTECTED_DATA_ROOTS';

/**
 * The platform data dir for `cleo`, from the RAW platform rules that
 * `env-paths` applies (`@cleocode/paths` delegates to it).
 *
 * Deliberately NOT `@cleocode/paths` / `env-paths`: env-paths@4 reads
 * `os.homedir()` and `os.tmpdir()` once, at import, and Node caches the
 * module for the life of the fork. Importing it here, before HOME is
 * sandboxed, pinned the REAL home into every later config/cache/log/temp path
 * in the fork (CI: `/home/runner/Library/...` in adapters and cleo-os tests).
 */
function platformCleoDataDir(home: string): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'cleo');
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'cleo', 'Data');
  }
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'cleo');
}

if (!process.env[PROTECTED_ROOTS_ENV]) {
  const home = homedir();
  const inheritedCleoHome = process.env.CLEO_HOME?.trim();
  const roots = new Set<string>([
    // The platform default data dir...
    platformCleoDataDir(home),
    // ...the `~/.cleo` convenience alias that links to it...
    join(home, '.cleo'),
  ]);
  // ...and a data dir the parent shell selected with CLEO_HOME.
  // Same expansion as @cleocode/paths `resolveHomeOverride`: `~` and a
  // relative value both resolve against HOME, never against cwd.
  if (inheritedCleoHome) {
    if (inheritedCleoHome.startsWith('~')) roots.add(join(home, inheritedCleoHome.slice(1)));
    else roots.add(isAbsolute(inheritedCleoHome) ? inheritedCleoHome : join(home, inheritedCleoHome));
  }
  process.env[PROTECTED_ROOTS_ENV] = [...roots].map((r) => resolve(r)).join(delimiter);
}

// Capture the caller's selected filesystem before sanitizing inherited aliases.
// Only choose a physical system-temp base, never the arbitrary inherited
// subdirectory: it may be a host HOME/provider path or an ancestor of .cleo.
const inheritedTemp = tmpdir();
// This fallback project alias must not survive fixture CLEO_ROOT overrides.
delete process.env.CLEO_PROJECT_ROOT;
for (const name of ['TMPDIR', 'TMP', 'TEMP']) delete process.env[name];
// macOS: tmpdir() is `/tmp` or `/var/folders/...`, both symlinks into
// `/private`. Code under test realpaths directories (registry, evidence,
// worktree guards) while fixtures built from the unresolved sandbox path did
// not, so ~350 tests failed on macOS only (T12518). Every sandbox path is
// therefore derived from the physical temp root.
const platformTemp = (() => {
  const t = tmpdir();
  try {
    return realpathSync(t);
  } catch {
    return t;
  }
})();
const sandboxParent = (() => {
  let inheritedPhysical: string;
  try {
    inheritedPhysical = realpathSync(inheritedTemp);
  } catch {
    return platformTemp;
  }
  const permittedBases = process.platform === 'win32' ? [platformTemp] : ['/var/tmp', platformTemp];
  for (const base of permittedBases) {
    let physicalBase: string;
    try {
      physicalBase = realpathSync(base);
    } catch {
      continue;
    }
    if (inheritedPhysical === physicalBase || inheritedPhysical.startsWith(`${physicalBase}${sep}`)) {
      return physicalBase;
    }
  }
  return platformTemp;
})();
const sandbox = mkdtempSync(join(sandboxParent, 'cleo-vitest-fork-'));
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
// T12687: marks every store below the sandbox as a test fixture, so a CLI child
// a test spawns (no VITEST in its env) may still migrate it from a worktree
// build. A temp dir alone is not an exemption: projects can live under /tmp.
writeFileSync(join(sandbox, '.cleo-test-sandbox'), 'vitest fork sandbox (T12687)\n');
// A parent process cannot opt an ordinary unit-test fork into a real store.
// Deliberate integration fixtures may set scoped overrides after setup.
delete process.env.CLEO_TEST_ALLOW_PROJECT_DB;
process.env.CLEO_TEST_ALLOWED_DB_ROOTS = sandbox;
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

// ---------------------------------------------------------------------------
// Real-data-dir write guard (T12645). Every fs mutation whose target lies
// under a root captured in PROTECTED_ROOTS_ENV is refused with
// E_TEST_REAL_DATA_WRITE and recorded; the afterEach below fails the test
// even when the code under test swallowed the error; a hit in a beforeAll /
// afterAll hook is reported by the afterAll below, attributed to the file.
//
// Exempt: the git checkout the run was started in (the nearest ancestor of
// process.cwd() holding `.git`). Agent worktrees live under
// `<dataDir>/worktrees`, so a run inside one writes its own fixtures there —
// but only its OWN checkout is exempt, never a sibling agent's worktree.
//
// A root that contains the sandbox or the system temp dir is dropped, so an
// inherited `CLEO_HOME=/tmp` can never turn every sandbox write into a hit.
//
// Known limits — this is a tripwire for the common leak, not a sandbox:
// - Paths are compared as TEXT after `path.resolve`. A write through a symlink
//   other than `~/.cleo` (e.g. a harness skill link pointing into the data
//   dir) is not resolved and not caught.
// - Only this process's `node:fs` / `node:fs/promises` exports are guarded.
//   Child processes, native addons and SQLite (which has its own path guard in
//   `openNativeDatabase`) write unseen, as do writes to an fd or stream opened
//   before setup ran.
// ---------------------------------------------------------------------------

/** Shared across setup re-runs in one process (see the double-run note above). */
const REAL_DATA_WRITES = Symbol.for('cleo.vitest.realDataWrites');
const FS_GUARD_INSTALLED = Symbol.for('cleo.vitest.realDataGuardInstalled');
/**
 * Describes the running test. Re-bound by every setup run: the fs wrappers are
 * installed once per process, so they must not close over one file's module
 * instance of this setup (isolation re-evaluates it per test file).
 */
const CURRENT_TEST = Symbol.for('cleo.vitest.realDataCurrentTest');
type GuardGlobal = typeof globalThis & {
  [REAL_DATA_WRITES]?: string[];
  [FS_GUARD_INSTALLED]?: boolean;
  [CURRENT_TEST]?: () => string;
};
const guardGlobal = globalThis as GuardGlobal;
guardGlobal[REAL_DATA_WRITES] ??= [];
const realDataWrites = guardGlobal[REAL_DATA_WRITES];

const isWithin = (target: string, root: string): boolean =>
  target === root || target.startsWith(`${root}${sep}`);

/** Nearest ancestor of `start` holding `.git` (dir or worktree file), or null. */
function gitToplevel(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

const ownCheckout = gitToplevel(process.cwd());

const protectedRoots = (process.env[PROTECTED_ROOTS_ENV] ?? '')
  .split(delimiter)
  .filter((root) => root.length > 0)
  .filter((root) => !isWithin(sandbox, root) && !isWithin(sandboxParent, root));

function toPathString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return value.protocol === 'file:' ? decodeURIComponent(value.pathname) : null;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return null;
}

/** The protected root `value` falls under, or null. */
function protectedRootOf(value: unknown): string | null {
  const raw = toPathString(value);
  if (raw === null) return null;
  const target = resolve(raw);
  for (const root of protectedRoots) {
    if (!isWithin(target, root)) continue;
    if (ownCheckout !== null && isWithin(target, ownCheckout)) return null;
    return root;
  }
  return null;
}

/** Flags passed to `open` that can create or modify a file. */
function isWriteFlag(flags: unknown): boolean {
  if (typeof flags === 'number') {
    const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fsConstants;
    return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0;
  }
  return typeof flags === 'string' && /[wa+]/.test(flags);
}

type FsKind = 'sync' | 'callback' | 'promise';
interface FsGuardSpec {
  name: string;
  /** Argument positions holding a path the call writes. */
  pathArgs: readonly number[];
  /** For `open`: only guard when the flags argument (index 1) writes. */
  openFlags?: boolean;
}

const FS_WRITE_SPECS: readonly FsGuardSpec[] = [
  { name: 'mkdir', pathArgs: [0] },
  { name: 'mkdtemp', pathArgs: [0] },
  { name: 'writeFile', pathArgs: [0] },
  { name: 'appendFile', pathArgs: [0] },
  { name: 'copyFile', pathArgs: [1] },
  { name: 'cp', pathArgs: [1] },
  { name: 'rename', pathArgs: [0, 1] },
  { name: 'symlink', pathArgs: [1] },
  { name: 'link', pathArgs: [1] },
  { name: 'rm', pathArgs: [0] },
  { name: 'rmdir', pathArgs: [0] },
  { name: 'unlink', pathArgs: [0] },
  { name: 'truncate', pathArgs: [0] },
  { name: 'open', pathArgs: [0], openFlags: true },
];

function realDataWriteError(fn: string, target: unknown, root: string): Error {
  const message = [
    `E_TEST_REAL_DATA_WRITE: ${fn} targets the REAL CLEO data dir.`,
    `  target: ${toPathString(target)}`,
    `  root:   ${root}`,
    `  sandbox CLEO_HOME: ${process.env.CLEO_HOME}`,
    `  test:   ${guardGlobal[CURRENT_TEST]?.() ?? '(unknown test)'}`,
    '',
    'Tests must resolve cleoHome inside the per-fork sandbox that vitest.setup.ts',
    "creates (a package vitest.config.ts that runs directly must list it in",
    '`setupFiles`), or mock the resolver to a tmpdir.',
  ].join('\n');
  realDataWrites.push(message);
  return Object.assign(new Error(message), { code: 'E_TEST_REAL_DATA_WRITE' });
}

function guardFsFunction(target: Record<string, unknown>, fnName: string, spec: FsGuardSpec, kind: FsKind): void {
  const original = target[fnName];
  if (typeof original !== 'function') return;
  const guarded: AnyFn = function (this: unknown, ...args: unknown[]) {
    if (!spec.openFlags || isWriteFlag(args[1])) {
      for (const index of spec.pathArgs) {
        const root = protectedRootOf(args[index]);
        if (root === null) continue;
        const err = realDataWriteError(fnName, args[index], root);
        if (kind === 'promise') return Promise.reject(err);
        if (kind === 'callback') {
          const callback = args[args.length - 1];
          if (typeof callback === 'function') {
            process.nextTick(() => (callback as AnyFn)(err));
            return undefined;
          }
        }
        throw err;
      }
    }
    return (original as AnyFn).apply(this, args);
  };
  for (const sym of Object.getOwnPropertySymbols(original as object)) {
    (guarded as unknown as Record<symbol, unknown>)[sym] = (original as unknown as Record<symbol, unknown>)[sym];
  }
  try {
    target[fnName] = guarded;
  } catch {
    /* read-only export; skip */
  }
}

if (!guardGlobal[FS_GUARD_INSTALLED] && protectedRoots.length > 0) {
  guardGlobal[FS_GUARD_INSTALLED] = true;
  const cjsFs: Record<string, unknown> = cjsRequire('node:fs');
  const cjsFsPromises: Record<string, unknown> = cjsRequire('node:fs/promises');
  for (const spec of FS_WRITE_SPECS) {
    guardFsFunction(cjsFs, spec.name, spec, 'callback');
    guardFsFunction(cjsFs, `${spec.name}Sync`, spec, 'sync');
    guardFsFunction(cjsFsPromises, spec.name, spec, 'promise');
  }
  guardFsFunction(cjsFs, 'createWriteStream', { name: 'createWriteStream', pathArgs: [0] }, 'sync');
  // Push the wrapped CJS functions into every ESM `import { x } from 'node:fs'`.
  syncBuiltinESMExports();
}

function failOnRealDataWrites(): void {
  if (realDataWrites.length === 0) return;
  const writes = realDataWrites.splice(0);
  throw new Error(`${writes.length} write(s) targeted the real CLEO data dir:\n\n${writes.join('\n\n')}`);
}

// `currentTestName` outlives its test, so a later beforeAll/afterAll hit would
// otherwise be pinned on the previous test.
let inTestBody = false;
guardGlobal[CURRENT_TEST] = () => {
  try {
    const state = expect.getState();
    const name = inTestBody ? state.currentTestName : undefined;
    return `${state.testPath ?? '(unknown file)'} > ${name ?? '(beforeAll/afterAll hook)'}`;
  } catch {
    return '(outside the vitest runner)';
  }
};

/**
 * Hook registration needs a running vitest runner. This file is also imported
 * by plain `node -e` probes (scripts/__tests__/vitest-project-include.test.mjs
 * asserts the sandbox with no runner), where `beforeEach` throws "Vitest
 * failed to find the runner". There the sandbox and fs guard still apply;
 * only the per-test failure reporting is absent.
 */
function registerGuardHooks(): void {
  // Registered first: this beforeEach runs before the file's, and the
  // afterEach/afterAll below run after the file's (hooks unwind as a stack),
  // so afterAll also catches hits from beforeAll/afterAll no afterEach saw.
  beforeEach(() => {
    inTestBody = true;
  });
  afterEach(() => {
    inTestBody = false;
    failOnRealDataWrites();
  });
  afterAll(failOnRealDataWrites);
}

try {
  registerGuardHooks();
} catch (err) {
  if (!/failed to find the runner/i.test(err instanceof Error ? err.message : String(err))) throw err;
}
