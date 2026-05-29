/**
 * Node runtime-version enforcement gate (SSoT).
 *
 * Single source of truth for "is the running Node new enough to run CLEO".
 * The minimum is read from this package's own shipped `engines.node` at
 * runtime — NOT a hardcoded constant — so bumping the floor is a one-line
 * `package.json` edit and the gate evolves with it. A CI lint
 * (`scripts/lint-node-engine-ssot.mjs`) keeps every workspace package's
 * `engines.node` equal to root's, so the value the gate reads is authoritative.
 *
 * Lives in `@cleocode/paths` — the zero-dep leaf (only `env-paths`) that is
 * importable BEFORE any `@cleocode/core` import. The CLI guard must run here,
 * not at `node:sqlite` load, so an under-floor Node fails with an actionable
 * message instead of a cryptic `ERR_UNKNOWN_BUILTIN_MODULE` / divergent-SQLite
 * behavior. (Importing this package does NOT eagerly load `node:sqlite` — that
 * is lazy via `createRequire`; see `cleo-paths.ts`.)
 *
 * Why a full-semver floor and not a major-only check: 24.13.1 satisfies
 * `major >= 24` yet is below 24.16.0, where the bundled SQLite WAL-reset
 * corruption fix (SQLite 3.53.0) landed. The major-only guards
 * (`cli/index.ts`, `dependencies.ts:checkNode`) waved it through, then the
 * persistence layer diverged from CI. This gate compares full semver.
 *
 * @packageDocumentation
 * @task T11281
 * @task T11242
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch as osArch, platform as osPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Last-resort floor used only when this package's `engines.node` cannot be
 * read (e.g. a corrupted install). Kept equal to root `engines.node` by the
 * `lint-node-engine-ssot` CI gate so it can never silently lie.
 */
export const FALLBACK_MIN_NODE = '24.16.0';

/** A parsed `major.minor.patch` triple. */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse the first `x.y.z` triple out of a version fragment such as
 * `24.16.0`, `v24.16.0`, or a range like `>=24.16.0 <27`.
 *
 * @param raw - The version or range string.
 * @returns The parsed {@link Semver}, or `null` when no triple is present.
 */
export function parseSemver(raw: string): Semver | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * `a >= b` for {@link Semver} (major, then minor, then patch).
 */
function gte(a: Semver, b: Semver): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

/**
 * Read the minimum Node version from this package's shipped `engines.node`
 * (the SSoT). Falls back to {@link FALLBACK_MIN_NODE} when the manifest is
 * unreadable or declares no parseable version.
 *
 * @returns A normalized `major.minor.patch` string.
 *
 * @public
 */
export function getRequiredNodeVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      engines?: { node?: string };
    };
    const parsed = parseSemver(pkg.engines?.node ?? '');
    return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : FALLBACK_MIN_NODE;
  } catch {
    return FALLBACK_MIN_NODE;
  }
}

/** A version manager (or platform installer) CLEO can suggest for upgrading. */
export type NodeManager =
  | 'fnm'
  | 'nvm'
  | 'n'
  | 'volta'
  | 'asdf'
  | 'brew'
  | 'winget'
  | 'choco'
  | 'nodesource';

/** A concrete, copy-pasteable upgrade instruction. */
export interface UpgradeHint {
  manager: NodeManager;
  command: string;
  note?: string;
}

/** Result of evaluating the running Node against the required floor. */
export interface NodeVersionVerdict {
  compliant: boolean;
  current: string;
  required: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Ordered best-first; empty when compliant. */
  hints: UpgradeHint[];
}

/**
 * Build OS- and manager-aware upgrade hints from environment + platform ONLY
 * (no `child_process` spawns), so the compliant fast-path stays a no-op.
 *
 * @param required - The required Node version (e.g. `24.16.0`).
 * @param platform - The current `process.platform`.
 */
function upgradeHints(required: string, platform: NodeJS.Platform): UpgradeHint[] {
  const hints: UpgradeHint[] = [];
  const e = process.env;

  if (e['FNM_DIR'] || e['FNM_MULTISHELL_PATH']) {
    hints.push({
      manager: 'fnm',
      command: `fnm install ${required} && fnm use ${required} && fnm default ${required}`,
    });
  }
  if (e['NVM_DIR']) {
    hints.push({
      manager: 'nvm',
      command: `nvm install ${required} && nvm alias default ${required}`,
    });
  }
  if (e['VOLTA_HOME']) {
    hints.push({ manager: 'volta', command: `volta install node@${required}` });
  }
  if (e['ASDF_DIR'] || e['ASDF_DATA_DIR']) {
    hints.push({
      manager: 'asdf',
      command: `asdf install nodejs ${required} && asdf global nodejs ${required}`,
    });
  }

  // Platform fallbacks when no manager env is detected.
  if (hints.length === 0) {
    if (platform === 'win32') {
      hints.push({ manager: 'winget', command: 'winget install OpenJS.NodeJS' });
      hints.push({ manager: 'choco', command: `choco upgrade nodejs --version=${required}` });
    } else if (platform === 'darwin') {
      hints.push({ manager: 'brew', command: 'brew upgrade node' });
      hints.push({
        manager: 'fnm',
        command: `curl -fsSL https://fnm.vercel.app/install | bash && fnm install ${required}`,
      });
    } else {
      hints.push({
        manager: 'fnm',
        command: `curl -fsSL https://fnm.vercel.app/install | bash && fnm install ${required}`,
      });
      hints.push({
        manager: 'nodesource',
        command: '# see https://github.com/nodesource/distributions',
        note: 'system-wide install',
      });
    }
  }
  return hints;
}

/**
 * Evaluate the running Node against the required floor. Pure and
 * side-effect-free (no `process.exit`, no I/O beyond the SSoT manifest read) —
 * safe to call from `doctor`/`health` and unit tests.
 *
 * @param currentRaw - The Node version to evaluate. Defaults to
 *   `process.versions.node`.
 * @returns The {@link NodeVersionVerdict}.
 *
 * @public
 */
export function evaluateNodeVersion(
  currentRaw: string = process.versions.node,
): NodeVersionVerdict {
  const required = getRequiredNodeVersion();
  const cur = parseSemver(currentRaw);
  const req = parseSemver(required) ?? parseSemver(FALLBACK_MIN_NODE);
  const platform = osPlatform();
  // `req` is non-null: FALLBACK_MIN_NODE is a valid triple by construction.
  const compliant = cur !== null && req !== null && gte(cur, req);
  return {
    compliant,
    current: currentRaw,
    required,
    platform,
    arch: osArch(),
    hints: compliant ? [] : upgradeHints(required, platform),
  };
}

/** Options controlling {@link enforceNodeVersion}. */
export interface EnforceOptions {
  /**
   * `enforce` (default): print guidance + exit 1.
   * `warn`: print guidance + continue.
   * `auto`: best-effort install, then exit 1 ("open a new shell + re-run").
   * Default resolves to `auto` when `CLEO_NODE_AUTO_UPGRADE=1`, else `enforce`.
   */
  mode?: 'enforce' | 'warn' | 'auto';
  /** stderr writer (injectable for tests). */
  write?: (s: string) => void;
  /** process exit (injectable for tests). */
  exit?: (code: number) => never;
  /**
   * Node version to evaluate. Defaults to `process.versions.node`. Injectable
   * so tests assert a fixed verdict deterministically on any runtime (otherwise
   * the same assertion flips between a below-floor dev box and a compliant CI).
   */
  current?: string;
}

/**
 * The runtime gate. A microsecond no-op when Node is compliant; otherwise
 * prints an exact, OS-/manager-aware upgrade instruction and (by default)
 * exits non-zero.
 *
 * Auto mode (opt-in via `CLEO_NODE_AUTO_UPGRADE=1`) runs the install command,
 * then STILL exits non-zero: version managers switch Node via shell shims, so
 * a child process cannot hot-swap the interpreter already executing — the user
 * must open a new shell and re-run. Silent toolchain mutation is deliberately
 * never the default.
 *
 * @param opts - {@link EnforceOptions}.
 * @returns The {@link NodeVersionVerdict} (for the compliant no-op path, and
 *   for tests that stub `exit`).
 *
 * @public
 */
export function enforceNodeVersion(opts: EnforceOptions = {}): NodeVersionVerdict {
  const verdict = evaluateNodeVersion(opts.current);
  if (verdict.compliant) return verdict; // fast path — the common case

  const write = opts.write ?? ((s: string) => void process.stderr.write(s));
  const exit = opts.exit ?? ((c: number): never => process.exit(c));
  const mode = opts.mode ?? (process.env['CLEO_NODE_AUTO_UPGRADE'] === '1' ? 'auto' : 'enforce');

  const primary = verdict.hints[0]?.command ?? `# install Node >= ${verdict.required}`;
  const extra = verdict.hints
    .slice(1)
    .map((h) => `  (${h.manager}) ${h.command}\n`)
    .join('');

  write(
    `\nError: cleo requires Node.js >= ${verdict.required}\n` +
      `You are running Node ${verdict.current} (${verdict.platform}/${verdict.arch}).\n\n` +
      `Node ${verdict.required} bundles the SQLite WAL-reset corruption fix CLEO's\n` +
      `persistence layer (node:sqlite, zero native deps) depends on. Older 24.x\n` +
      `builds pass a major-only check but diverge at runtime (e.g. sqlite_master\n` +
      `DEFENSIVE-mode handling), causing local results to differ from CI.\n\n` +
      `Update to proceed:\n    ${primary}\n\n` +
      (extra ? `Other options:\n${extra}\n` : ''),
  );

  if (mode === 'warn') return verdict;

  if (mode === 'auto') {
    // Deferred require keeps child_process off the compliant fast-path. A
    // version-manager install mutates the SHELL, not this process, so we run it
    // then still exit non-zero below asking for a fresh shell + re-run.
    try {
      const req = createRequire(import.meta.url);
      const { execSync } = req('node:child_process') as typeof import('node:child_process');
      write(`Attempting: ${primary}\n`);
      // execSync runs through a shell by default, so compound `&&` commands work.
      execSync(primary, { stdio: 'inherit' });
      write(`\nInstalled Node ${verdict.required}. Open a NEW shell and re-run cleo.\n`);
    } catch {
      write('\nAuto-upgrade failed — run the command above manually.\n');
    }
  }

  return exit(1);
}
