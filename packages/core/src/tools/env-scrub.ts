/**
 * Subprocess environment scrubbing (T11897 · S1 · security hardening).
 *
 * Building the environment a child process inherits is a SECURITY boundary, not
 * a convenience. Two distinct threats are closed here:
 *
 * 1. **Sandbox escape via Pi-controlled env** — a model-driven loop that can
 *    set `LD_PRELOAD`, `NODE_OPTIONS`, `GIT_SSH_COMMAND`, `DYLD_*`, or a custom
 *    `PATH` gains arbitrary native code execution outside any command allowlist
 *    (the OS loader / Node honour them) and can satisfy a basename denylist with
 *    a workspace-resident impostor on a hijacked `PATH`. The scrubber NEVER
 *    forwards any of these dangerous variables and PINS `PATH` to a trusted
 *    absolute value.
 * 2. **Daemon-secret exfiltration** — the daemon's own `process.env` carries
 *    resolved provider credentials (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …),
 *    OAuth headers, and vault material (`CLEO_VAULT_*`). Inheriting the full
 *    parent env into a Pi-spawned child means a single `env`/`printenv`/log line
 *    exfiltrates them. The scrubber builds a MINIMAL, explicitly-constructed env
 *    instead of inheriting `process.env`.
 *
 * The doctrine is **allowlist, not denylist**: the scrubbed env starts EMPTY and
 * only a small set of benign, named variables are copied through from the parent
 * (locale, terminal, home/user, tmp). Everything else — including every secret,
 * every loader hook, and `PATH` itself — is reconstructed from trusted inputs.
 *
 * Pure function of input — no global/session coupling, import-time side-effect
 * free (S1).
 *
 * @epic T10403
 * @task T11761
 * @task T11897
 * @saga T11387
 */

import { delimiter } from 'node:path';

/**
 * The trusted, absolute `PATH` a scrubbed subprocess runs under. A fixed list of
 * standard system binary directories — NEVER the caller's (possibly Pi-poisoned)
 * `PATH`. Pinning this defeats the "workspace-resident impostor on a hijacked
 * PATH satisfies an allowed basename" escape: the workspace is not on it.
 */
export const TRUSTED_PATH = [
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin',
].join(delimiter);

/**
 * Benign environment variables copied through from the parent when present.
 * These carry NO secrets and NO code-execution surface — locale, terminal type,
 * timezone, home/user identity, and the tmp dir. `PATH` is deliberately ABSENT
 * (it is pinned to {@link TRUSTED_PATH}); every `*_API_KEY`, `*_TOKEN`,
 * `LD_*`, `DYLD_*`, `NODE_OPTIONS`, and `GIT_SSH_COMMAND` is deliberately ABSENT.
 */
const PASSTHROUGH_KEYS: readonly string[] = [
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'TMPDIR',
  'SHELL',
] as const;

/** Options for {@link scrubSubprocessEnv}. */
export interface ScrubEnvOptions {
  /**
   * The parent environment to copy the benign {@link PASSTHROUGH_KEYS} from.
   * Defaults to `process.env`. Injectable for tests so a clean env can be
   * asserted without mutating the real process environment.
   */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Extra variables to set on the scrubbed env (e.g. a caller-supplied `env`
   * merged ON TOP of the minimal base). These are themselves SCRUBBED — any
   * dangerous key (loader hooks, `PATH`, secrets) is dropped, so an untrusted
   * caller (Pi) cannot reintroduce an escape through this channel.
   */
  readonly extra?: Readonly<Record<string, string | undefined>>;
  /**
   * The trusted `PATH` to pin. Defaults to {@link TRUSTED_PATH}. Callers MUST
   * pass an absolute, trusted value — never the inbound/Pi-controlled `PATH`.
   */
  readonly path?: string;
}

/**
 * Variable-name prefixes that are NEVER forwarded into a scrubbed subprocess.
 * These either grant arbitrary code execution to the child (loader/runtime
 * hooks) or carry credentials. Matched case-INsensitively as a prefix so e.g.
 * `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `CLEO_VAULT_SECRET`, and `AWS_SECRET_ACCESS_KEY` are all
 * caught. Used to filter the caller-supplied `extra` map.
 */
const FORBIDDEN_PREFIXES: readonly string[] = [
  'LD_',
  'DYLD_',
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'GIT_SSH',
  'GIT_PROXY',
  'BASH_ENV',
  'ENV',
  'CDPATH',
] as const;

/**
 * Exact variable names that are NEVER forwarded (in addition to
 * {@link FORBIDDEN_PREFIXES}). `PATH` is pinned separately, so a caller cannot
 * override it via `extra`.
 */
const FORBIDDEN_EXACT: ReadonlySet<string> = new Set(['PATH', 'IFS']);

/**
 * Substrings whose presence in a variable NAME marks it as a credential that is
 * NEVER forwarded. Matched case-INsensitively. Catches `*_API_KEY`, `*_TOKEN`,
 * `*_SECRET`, `*PASSWORD*`, OAuth material, and the vault namespace.
 */
const SECRET_NAME_SUBSTRINGS: readonly string[] = [
  'API_KEY',
  'APIKEY',
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'PRIVATE_KEY',
  'ACCESS_KEY',
  'AUTH',
  'VAULT',
  'SESSION_KEY',
] as const;

/**
 * Whether a variable NAME is forbidden in a scrubbed subprocess env (a loader
 * hook, `PATH`, or a credential).
 *
 * @param name - The environment variable name.
 * @returns `true` when the variable must NOT be forwarded.
 */
export function isForbiddenEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (FORBIDDEN_EXACT.has(upper)) return true;
  if (FORBIDDEN_PREFIXES.some((p) => upper.startsWith(p))) return true;
  if (SECRET_NAME_SUBSTRINGS.some((s) => upper.includes(s))) return true;
  return false;
}

/**
 * Build a MINIMAL, explicitly-constructed subprocess environment.
 *
 * The result starts EMPTY; only the benign {@link PASSTHROUGH_KEYS} present in
 * `parentEnv` are copied, `PATH` is pinned to a trusted absolute value, and any
 * caller-supplied `extra` is merged ON TOP after being filtered through
 * {@link isForbiddenEnvName}. The daemon's secrets and any loader hooks in the
 * parent environment are therefore NEVER visible to the child, and an untrusted
 * caller cannot reintroduce an escape via `extra`.
 *
 * @param options - {@link ScrubEnvOptions}.
 * @returns A fresh `Record<string, string>` safe to hand to `spawn(..., { env })`.
 *
 * @example
 * ```ts
 * // A Pi-supplied env that tries to inject a loader hook + hijack PATH:
 * const env = scrubSubprocessEnv({
 *   extra: { LD_PRELOAD: '/tmp/evil.so', PATH: '/workspace', SAFE: '1' },
 * });
 * // env has no LD_PRELOAD, PATH is the pinned TRUSTED_PATH, only SAFE survives.
 * ```
 */
export function scrubSubprocessEnv(options: ScrubEnvOptions = {}): Record<string, string> {
  const parentEnv = options.parentEnv ?? process.env;
  const scrubbed: Record<string, string> = {};

  for (const key of PASSTHROUGH_KEYS) {
    const value = parentEnv[key];
    if (typeof value === 'string' && value.length > 0 && !isForbiddenEnvName(key)) {
      scrubbed[key] = value;
    }
  }

  // Pin PATH to a trusted absolute value — never the inbound/parent PATH.
  scrubbed.PATH = options.path ?? TRUSTED_PATH;

  // Merge caller-supplied extras ON TOP, but drop any dangerous key so an
  // untrusted caller (Pi) cannot reintroduce a loader hook, secret, or PATH
  // override through this channel.
  if (options.extra) {
    for (const [key, value] of Object.entries(options.extra)) {
      if (typeof value !== 'string') continue;
      if (isForbiddenEnvName(key)) continue;
      scrubbed[key] = value;
    }
  }

  return scrubbed;
}
