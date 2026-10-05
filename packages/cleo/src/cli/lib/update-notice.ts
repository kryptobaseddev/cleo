/**
 * Passive update notice for an installed CLEO (T13137).
 *
 * Before this, nothing told an installed CLI that a newer release existed: only
 * an explicit `cleo self-update` (or `npm i -g`) updated, so agents on other
 * machines kept running a release with a known defect indefinitely. A hotfix
 * reached only the users who happened to update.
 *
 * ## How it stays off the hot path
 *
 * A command only READS a small cache file (`<state>/update-check.json`). When the
 * cache is older than a day (an hour after a failed check), the command claims a
 * lock file and starts a detached, unref'd child (`update-check-entry.js`) that
 * asks the registry for the package's dist-tags (and the latest version's
 * manifest, for the hotfix flag) and rewrites the cache. The
 * command never waits on the network, and the lock keeps a burst of concurrent
 * agents to one check. The notice itself is one line on stderr; stdout (the LAFS
 * envelope) is never touched.
 *
 * ## What it says, and how often
 *
 * - A newer release on the install's channel (`latest`, or `beta` for a beta or
 *   rc install): one line naming the version and `cleo self-update`, at most once
 *   a day per machine.
 * - A release flagged as a hotfix: a stronger line at most every 15 minutes
 *   (not on every command: agents run hundreds of commands a session, each line
 *   lands in their context, and an agent usually cannot update on its own) until
 *   the install moves past it. The flag is release metadata, not a dist-tag
 *   (T13184): a release planned with `cleo release plan <v> --hotfix` has
 *   `"cleo": { "hotfix": true }` written into `@cleocode/cleo`'s package.json by
 *   release.yml, so it ships through the ordinary tokenless (OIDC) publish. The
 *   check reads the field from the latest version's registry manifest and
 *   remembers the highest flagged version it has seen, so a hotfix followed by
 *   a regular release still reads as "you are missing a hotfix".
 *
 * ## When it stays silent
 *
 * - `CLEO_NO_UPDATE_NOTICE=1` (or the `NO_UPDATE_NOTIFIER` convention): no notice
 *   and no registry check, in every environment, TTY or not.
 * - CI (`CI` and the common CI-provider variables): no notice and no check. A CI
 *   install is pinned and rebuilt per run, so neither can help.
 * - A CLI that does not run from an installed package (a source checkout or a
 *   worktree build) — unless {@link UPDATE_NOTICE_FROM_SOURCE_ENV} is set.
 * - `cleo self-update` (it reports versions itself) and `cleo hook …` (its
 *   output belongs to the harness).
 * - `--quiet` prints nothing; the background check still keeps the cache fresh.
 *
 * A non-TTY session is NOT silenced by default: agents run CLEO without a
 * terminal, and they are the callers who most need to learn about a hotfix.
 *
 * @module
 * @task T13137
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCleoStateDir } from '@cleocode/paths';

/** npm package whose dist-tags the check reads. */
export const CLEO_PACKAGE_NAME = '@cleocode/cleo';

/** Set to `1` to silence the notice and skip the registry check everywhere. */
export const UPDATE_NOTICE_OPT_OUT_ENV = 'CLEO_NO_UPDATE_NOTICE';

/**
 * Set to `1` to show the notice from a CLI that runs from a source checkout or a
 * worktree build (which never shows it otherwise). For testing the notice.
 */
export const UPDATE_NOTICE_FROM_SOURCE_ENV = 'CLEO_UPDATE_NOTICE_FROM_SOURCE';

/** Registry used when npm's own `registry` setting is not in the environment. */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';

/** A successful check is trusted for this long before the next one. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A failed check (offline, registry down) is retried after this long. */
export const UPDATE_CHECK_RETRY_MS = 60 * 60 * 1000;

/** A regular (non-hotfix) notice is shown at most once per this interval. */
export const UPDATE_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A check lock older than this belongs to a check that died; it is reclaimed. */
export const UPDATE_CHECK_LOCK_STALE_MS = 10 * 60 * 1000;

/** Cache file the background check writes, inside the CLEO state directory. */
export const UPDATE_CACHE_FILE = 'update-check.json';

/** Lock file that admits one background check at a time. */
export const UPDATE_LOCK_FILE = 'update-check.lock';

/** File whose mtime records when a regular notice was last shown. */
export const UPDATE_NOTICE_STAMP_FILE = 'update-notice.stamp';

/** A hotfix notice is shown at most once per this interval. */
export const HOTFIX_NOTICE_INTERVAL_MS = 15 * 60 * 1000;

/** File whose mtime records when a hotfix notice was last shown. */
export const HOTFIX_NOTICE_STAMP_FILE = 'update-notice-hotfix.stamp';

/** Entry module of the background check, next to the built CLI. */
export const UPDATE_CHECK_ENTRY = 'update-check-entry.js';

/** Environment variables that mean "this is a CI run". */
const CI_ENV_VARS: readonly string[] = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TF_BUILD',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'TRAVIS',
  'APPVEYOR',
  'CODEBUILD_BUILD_ID',
  'BITBUCKET_BUILD_NUMBER',
  'DRONE',
];

/** `x.y.z`, an optional `-prerelease` and an optional `+build`. */
const VERSION_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** What the background check last learned, as written to {@link UPDATE_CACHE_FILE}. */
export interface UpdateCheckCache {
  /** Cache format version. */
  readonly schemaVersion: 1;
  /** ISO time the last check finished, successfully or not. */
  readonly checkedAt: string;
  /** Whether the last check reached the registry. */
  readonly ok: boolean;
  /** dist-tag → version, from the last check that reached the registry. */
  readonly distTags: Readonly<Record<string, string>>;
  /** Highest version seen whose published manifest carries `cleo.hotfix: true`. */
  readonly hotfix?: string;
}

/** Everything the background check needs, passed to it on its command line. */
export interface UpdateCheckRequest {
  /** Absolute path of {@link UPDATE_CACHE_FILE}. */
  readonly cachePath: string;
  /** Absolute path of {@link UPDATE_LOCK_FILE}; removed when the check ends. */
  readonly lockPath: string;
  /** Registry base URL. */
  readonly registry: string;
  /** Package whose dist-tags are read. */
  readonly packageName: string;
}

/** A notice the running CLI should print. */
export type UpdateNotice =
  | {
      /** A newer release on the install's channel. */
      readonly kind: 'update';
      /** Version of the running CLI. */
      readonly installed: string;
      /** Version `cleo self-update` installs. */
      readonly target: string;
    }
  | {
      /** A newer release that includes a release flagged as a hotfix. */
      readonly kind: 'hotfix';
      /** Version of the running CLI. */
      readonly installed: string;
      /** Version `cleo self-update` installs. */
      readonly target: string;
      /** The flagged release (equal to `target` or older). */
      readonly hotfix: string;
    };

/** What {@link showUpdateNotice} did, for tests and debugging. */
export interface UpdateNoticeOutcome {
  /** Why nothing ran, when the notice is suppressed for this invocation. */
  readonly suppressed: string | null;
  /** Whether a background check was started. */
  readonly checkStarted: boolean;
  /** The notice printed, if any. */
  readonly shown: UpdateNotice | null;
}

/** Inputs of {@link showUpdateNotice}. Everything but `version` and `argv` defaults to the live process. */
export interface ShowUpdateNoticeOptions {
  /** Version of the running CLI. */
  readonly version: string;
  /** CLI arguments (without `node` and the script). */
  readonly argv: readonly string[];
  /** `--quiet`: print nothing (the background check still runs). */
  readonly quiet?: boolean;
  /** Environment; the live `process.env` by default. */
  readonly env?: NodeJS.ProcessEnv;
  /** Where the notice goes; `process.stderr` by default. Never stdout. */
  readonly stderr?: { write(chunk: string): unknown };
  /** CLEO state directory; {@link getCleoStateDir} by default. */
  readonly stateDir?: string;
  /** Whether this CLI runs from an installed package; derived from this module's path by default. */
  readonly installedPackage?: boolean;
  /** Current time in ms; `Date.now` by default. */
  readonly now?: () => number;
  /** Starts the background check; spawns {@link UPDATE_CHECK_ENTRY} detached by default. */
  readonly startCheck?: (request: UpdateCheckRequest, env: NodeJS.ProcessEnv) => void;
}

/** Whether an environment flag is set to something other than empty, `0` or `false`. */
function flagSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

/**
 * Whether the environment is a CI run.
 *
 * @param env - Environment to inspect.
 * @returns `true` when `CI` or a common CI-provider variable is set.
 *
 * @example
 * ```ts
 * isCiEnvironment({ CI: 'true' }); // → true
 * isCiEnvironment({ CI: 'false' }); // → false
 * ```
 */
export function isCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  return CI_ENV_VARS.some((name) => flagSet(env[name]));
}

/** Parsed `x.y.z[-pre]`; `null` for anything else. */
function parseVersion(version: string): { core: number[]; pre: string[] } | null {
  const m = VERSION_RE.exec(version.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? [] : m[4].split('.'),
  };
}

/** Semver precedence of two prerelease identifier lists (empty = a release). */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}

/**
 * Compare two versions by semver precedence (CLEO's CalVer `YYYY.M.P` is valid
 * semver).
 *
 * @param a - First version.
 * @param b - Second version.
 * @returns `-1`, `0` or `1`; `null` when either is not a version.
 *
 * @example
 * ```ts
 * compareVersions('2026.10.3', '2026.10.10'); // → -1
 * compareVersions('2026.10.4-beta.1', '2026.10.4'); // → -1
 * ```
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const x = pa.core[i] ?? 0;
    const y = pb.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  const pre = comparePrerelease(pa.pre, pb.pre);
  return pre === 0 ? 0 : pre < 0 ? -1 : 1;
}

/**
 * The dist-tag `cleo self-update` follows for an installed version, mirroring
 * the release workflow: a plain version is `latest`, `-beta`/`-rc` is `beta`,
 * and `-alpha`/`-dev` (or anything unparseable) gets no notice.
 *
 * @param version - Installed version.
 * @returns The channel's dist-tag, or `null` when no notice applies.
 */
export function releaseChannelTag(version: string): 'latest' | 'beta' | null {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  if (parsed.pre.length === 0) return 'latest';
  const tag = (parsed.pre[0] ?? '').toLowerCase();
  if (tag.startsWith('beta') || tag.startsWith('rc')) return 'beta';
  return null;
}

/**
 * Decide which notice, if any, an installed version should get.
 *
 * The target is the install's channel tag. A hotfix notice needs a flagged
 * version newer than the install and no newer than the target: then
 * `cleo self-update` delivers the fix. A flagged version at or below the install
 * (already have it) or above the target (self-update would not deliver it) is
 * ignored. No dist-tag ever flags a hotfix.
 *
 * @param installed - Version of the running CLI.
 * @param distTags - dist-tag → version.
 * @param hotfix - Highest version known to carry `cleo.hotfix: true`, if any.
 * @returns The notice, or `null` when the install is current.
 *
 * @example
 * ```ts
 * decideUpdateNotice('2026.10.3', { latest: '2026.10.5' }, '2026.10.4');
 * // → { kind: 'hotfix', installed: '2026.10.3', target: '2026.10.5', hotfix: '2026.10.4' }
 * ```
 */
export function decideUpdateNotice(
  installed: string,
  distTags: Readonly<Record<string, string>>,
  hotfix?: string,
): UpdateNotice | null {
  const channel = releaseChannelTag(installed);
  if (channel === null) return null;
  const target = distTags[channel];
  if (target === undefined || compareVersions(target, installed) !== 1) return null;
  if (
    hotfix !== undefined &&
    compareVersions(hotfix, installed) === 1 &&
    (compareVersions(hotfix, target) ?? 1) <= 0
  ) {
    return { kind: 'hotfix', installed, target, hotfix };
  }
  return { kind: 'update', installed, target };
}

/**
 * The one stderr line for a notice.
 *
 * @param notice - The notice to render.
 * @returns The line, newline-terminated.
 */
export function formatUpdateNotice(notice: UpdateNotice): string {
  const hide = `Set ${UPDATE_NOTICE_OPT_OUT_ENV}=1 to hide this.`;
  if (notice.kind === 'update') {
    return `[cleo] Update available: ${notice.target} (installed ${notice.installed}). Run \`cleo self-update\`. ${hide}\n`;
  }
  const release =
    notice.hotfix === notice.target
      ? `${notice.target} is a hotfix release`
      : `${notice.target} includes hotfix release ${notice.hotfix}`;
  return `[cleo] HOTFIX available: ${release} for a defect in your installed ${notice.installed}. Run \`cleo self-update\` now. ${hide}\n`;
}

/**
 * Why this invocation gets no notice and no check, or `null` when it may have both.
 *
 * @param argv - CLI arguments.
 * @param env - Environment.
 * @param installedPackage - Whether the CLI runs from an installed package.
 * @returns A short reason, or `null`.
 */
export function updateNoticeSuppression(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  installedPackage: boolean,
): string | null {
  if (flagSet(env[UPDATE_NOTICE_OPT_OUT_ENV])) return UPDATE_NOTICE_OPT_OUT_ENV;
  if (flagSet(env.NO_UPDATE_NOTIFIER)) return 'NO_UPDATE_NOTIFIER';
  if (isCiEnvironment(env)) return 'ci';
  if (!installedPackage && !flagSet(env[UPDATE_NOTICE_FROM_SOURCE_ENV])) return 'source-checkout';
  const command = argv.find((a) => !a.startsWith('-'));
  if (command === 'self-update' || command === 'hook') return `command:${command}`;
  return null;
}

/**
 * Parse the cache file's contents. Anything malformed reads as no cache, so the
 * next command starts a fresh check.
 *
 * @param raw - File contents.
 * @returns The cache, or `null`.
 */
export function parseUpdateCache(raw: string): UpdateCheckCache | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== 1) return null;
  const checkedAt = record['checkedAt'];
  if (typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt))) return null;
  const tags = record['distTags'];
  if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) return null;
  const distTags: Record<string, string> = {};
  for (const [tag, version] of Object.entries(tags)) {
    if (typeof version === 'string' && parseVersion(version)) distTags[tag] = version;
  }
  const hotfix = record['hotfix'];
  return {
    schemaVersion: 1,
    checkedAt,
    ok: record['ok'] === true,
    distTags,
    ...(typeof hotfix === 'string' && parseVersion(hotfix) ? { hotfix } : {}),
  };
}

/**
 * Whether a new background check is due.
 *
 * @param cache - The cache, or `null` when there is none.
 * @param now - Current time in ms.
 * @returns `true` when there is no cache, or it is older than its interval.
 */
export function updateCheckDue(cache: UpdateCheckCache | null, now: number): boolean {
  if (cache === null) return true;
  const age = now - Date.parse(cache.checkedAt);
  // A clock that moved backwards makes the age negative: check again.
  if (age < 0) return true;
  return age >= (cache.ok ? UPDATE_CHECK_INTERVAL_MS : UPDATE_CHECK_RETRY_MS);
}

/**
 * Claim the right to run the background check by creating the lock file
 * exclusively. A lock older than {@link UPDATE_CHECK_LOCK_STALE_MS} belongs to a
 * check that died and is reclaimed.
 *
 * The reclaim is not atomic, and that is accepted: two processes that both see
 * a stale lock can each unlink and recreate it, and a slow child that outlives
 * a reclaim removes the new owner's lock when it finishes. The worst case is a
 * duplicate dist-tags fetch; the cache write is tmp-then-rename either way.
 *
 * @param lockPath - Lock file path.
 * @param now - Current time in ms.
 * @returns `true` when this process holds the lock.
 */
export function claimUpdateCheck(lockPath: string, now: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        if (now - statSync(lockPath).mtimeMs < UPDATE_CHECK_LOCK_STALE_MS) return false;
        unlinkSync(lockPath);
      } catch {
        // Another process removed or reclaimed it first; try once more.
      }
    }
  }
  return false;
}

/** Registry from npm's environment configuration, else {@link DEFAULT_NPM_REGISTRY}. */
function registryFrom(env: NodeJS.ProcessEnv): string {
  const configured = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  if (configured && /^https?:\/\//i.test(configured)) return configured;
  return DEFAULT_NPM_REGISTRY;
}

/** Whether this module runs from an installed `@cleocode/cleo` package. */
function runsFromInstalledPackage(): boolean {
  return /[\\/]node_modules[\\/]@cleocode[\\/]cleo[\\/]/.test(fileURLToPath(import.meta.url));
}

/**
 * Start the background check as a detached child that outlives nothing it
 * should not: stdio is ignored and the handle is unref'd, so this process exits
 * on its own schedule.
 */
function spawnUpdateCheck(request: UpdateCheckRequest, env: NodeJS.ProcessEnv): void {
  const entry = join(dirname(fileURLToPath(import.meta.url)), UPDATE_CHECK_ENTRY);
  if (!existsSync(entry)) throw new Error(`update check entry missing: ${entry}`);
  const childEnv: NodeJS.ProcessEnv = { ...env };
  // Node's fetch honours HTTP(S)_PROXY only when asked to.
  const proxied = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => env[k]);
  if (proxied && childEnv.NODE_USE_ENV_PROXY === undefined) childEnv.NODE_USE_ENV_PROXY = '1';
  const child = spawn(
    process.execPath,
    [entry, request.cachePath, request.lockPath, request.registry, request.packageName],
    { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv },
  );
  // An asynchronous spawn failure must not become an uncaught 'error' event.
  child.on('error', () => {});
  child.unref();
}

/**
 * Show the update notice for this invocation, if one is due, and start a
 * background registry check when the cache is stale. Never throws, never waits
 * on the network and never writes to stdout.
 *
 * @param options - See {@link ShowUpdateNoticeOptions}.
 * @returns What happened.
 *
 * @example
 * ```ts
 * showUpdateNotice({ version: CLI_VERSION, argv: process.argv.slice(2) });
 * ```
 */
export function showUpdateNotice(options: ShowUpdateNoticeOptions): UpdateNoticeOutcome {
  const env = options.env ?? process.env;
  const suppressed = updateNoticeSuppression(
    options.argv,
    env,
    options.installedPackage ?? runsFromInstalledPackage(),
  );
  if (suppressed !== null) return { suppressed, checkStarted: false, shown: null };

  let checkStarted = false;
  let shown: UpdateNotice | null = null;
  try {
    const now = (options.now ?? Date.now)();
    const stateDir = options.stateDir ?? getCleoStateDir();
    const cachePath = join(stateDir, UPDATE_CACHE_FILE);
    let cache: UpdateCheckCache | null = null;
    try {
      cache = parseUpdateCache(readFileSync(cachePath, 'utf8'));
    } catch {
      // No cache yet.
    }

    if (updateCheckDue(cache, now)) {
      mkdirSync(stateDir, { recursive: true });
      const lockPath = join(stateDir, UPDATE_LOCK_FILE);
      if (claimUpdateCheck(lockPath, now)) {
        const request: UpdateCheckRequest = {
          cachePath,
          lockPath,
          registry: registryFrom(env),
          packageName: CLEO_PACKAGE_NAME,
        };
        try {
          (options.startCheck ?? spawnUpdateCheck)(request, env);
          checkStarted = true;
        } catch {
          try {
            unlinkSync(lockPath);
          } catch {
            // Already gone.
          }
        }
      }
    }

    if (cache === null || options.quiet === true) {
      return { suppressed: null, checkStarted, shown };
    }
    const notice = decideUpdateNotice(options.version, cache.distTags, cache.hotfix);
    if (notice === null) return { suppressed: null, checkStarted, shown };

    // Each kind has its own stamp, so a hotfix flagged after a regular notice
    // is announced at once rather than a day later.
    const hotfix = notice.kind === 'hotfix';
    const stampPath = join(stateDir, hotfix ? HOTFIX_NOTICE_STAMP_FILE : UPDATE_NOTICE_STAMP_FILE);
    const interval = hotfix ? HOTFIX_NOTICE_INTERVAL_MS : UPDATE_NOTICE_INTERVAL_MS;
    try {
      const age = now - statSync(stampPath).mtimeMs;
      if (age >= 0 && age < interval) return { suppressed: null, checkStarted, shown };
    } catch {
      // Never shown before.
    }
    writeFileSync(stampPath, `${notice.target}\n`);
    utimesSync(stampPath, new Date(now), new Date(now));
    (options.stderr ?? process.stderr).write(formatUpdateNotice(notice));
    shown = notice;
  } catch {
    // A notice must never break a command.
  }
  return { suppressed: null, checkStarted, shown };
}
