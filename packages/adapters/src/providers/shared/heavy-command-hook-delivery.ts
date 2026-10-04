/**
 * Deliver CLEO's heavy-command hook to every provider a project uses (T13124).
 *
 * `cleo init`, `cleo upgrade`, `cleo doctor` and the session briefing reach the
 * per-provider installers in {@link ./heavy-command-hook-install.js} through
 * this module. It used to go through `AdapterManager.discover()`, which looks for
 * manifests at `<project>/packages/adapters/<dir>/manifest.json`, a path that
 * exists in no project, cleocode included. So the hook was never installed
 * anywhere, and the per-adapter try/catch hid every failure.
 *
 * Each provider is handled on its own: a provider that cannot take the hook
 * (a stray `.codex` file, a malformed settings file) gets a `blocked` or
 * `failed` outcome with the reason and the exact remedy, and the other
 * providers still install. Nothing here throws.
 *
 * A provider counts as in use when the project has its config directory, its
 * CLI is on `PATH`, its user config directory exists, or the hook config
 * already exists. The home directory is only READ for that check. CLEO writes
 * project-level configs only, never a user-global one.
 *
 * @task T13124
 * @epic T13121
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsonConfigParseError } from '@cleocode/caamp';
import type {
  HeavyCommandHookMode,
  HeavyCommandHookProvider,
  HeavyHookCliProbe,
  HeavyHookDeliveryApi,
  HeavyHookDeliveryOptions,
  HeavyHookDeliveryOutcome,
  HeavyHookInspection,
} from '@cleocode/contracts';
import { findOnPath } from '@cleocode/paths';
import {
  CLAUDE_LOCAL_SETTINGS,
  CODEX_HOOKS_FILE,
  codexHookSnippet,
  codexHooksSharedReason,
  excludedByCleo,
  HEAVY_COMMAND_HOOK_ID,
  HeavyHookPathBlockedError,
  HeavyHookSharedConfigError,
  heavyCommandHookObject,
  hookFileVisibleToGit,
  isHeavyHookObject,
  isUserHomeDir,
  nonDirectoryAncestor,
  OLDER_CLEO_MARKER_PREFIX,
  OPENCODE_PLUGIN_FILE,
  opencodeHeavyCommandPluginSource,
  syncClaudeCodeHeavyCommandHook,
  syncCodexHeavyCommandHook,
  syncOpencodeHeavyCommandPlugin,
  trackedFileModified,
} from './heavy-command-hook-install.js';
import { isPlainObject } from './hook-config.js';

/** Every provider the delivery considers, in report order. */
export const HEAVY_HOOK_DELIVERY_PROVIDERS: readonly HeavyCommandHookProvider[] = Object.freeze([
  'claude-code',
  'codex',
  'opencode',
  'kimi',
]);

/** The focused remedy: installs or refreshes only this hook. */
export const HEAVY_HOOK_FIX_COMMAND = 'cleo doctor heavy-command-hook --fix';

type Env = Readonly<Record<string, string | undefined>>;

/** What to do when Codex's `hooks.json` is the project's own (review MED-3). */
const CODEX_SHARED_REMEDY =
  "if the team wants Codex governed here, add CLEO's PreToolUse entry (the snippet) to .codex/hooks.json yourself and commit it deliberately; CLEO never writes or hides a project's own hook config";

/** Kimi has no project-level hook config, so CLEO cannot install for it. */
const KIMI_REASON =
  'Kimi reads hooks only from its global ~/.kimi/config.toml, and CLEO never writes user-global configs';
const KIMI_REMEDY =
  'add a [[hooks]] entry for PreToolUse that runs `cleo hook heavy-command --provider kimi` to ~/.kimi/config.toml yourself';

function homeOf(env: Env): string {
  return env.HOME || homedir();
}

/**
 * The file a provider's project-level hook lives in (Kimi: its global config,
 * named for the report only; CLEO never writes it).
 *
 * @param provider - the harness.
 * @param projectDir - the project root.
 * @param env - environment (for Kimi's home directory).
 * @returns the absolute path.
 */
export function heavyHookTarget(
  provider: HeavyCommandHookProvider,
  projectDir: string,
  env: Env = process.env,
): string {
  switch (provider) {
    case 'claude-code':
      return join(projectDir, CLAUDE_LOCAL_SETTINGS);
    case 'codex':
      return join(projectDir, CODEX_HOOKS_FILE);
    case 'opencode':
      return join(projectDir, OPENCODE_PLUGIN_FILE);
    case 'kimi':
      return join(homeOf(env), '.kimi', 'config.toml');
  }
}

/** Whether a provider is in use, and the first signal that says so. */
export interface HeavyHookDetection {
  /** The provider is in use on this machine or in this project. */
  readonly detected: boolean;
  /** The signal found, or what was checked when nothing was. */
  readonly why: string;
}

/**
 * Whether `provider` is in use here, from cheap read-only signals: its
 * project config directory, its CLI on `PATH`, its user config directory, or
 * an existing hook config.
 *
 * @param provider - the harness.
 * @param projectDir - the project root.
 * @param env - environment (`PATH`, `HOME`, `CODEX_HOME`, `XDG_CONFIG_HOME`, …).
 * @returns whether it is in use, and why.
 */
export function detectHeavyHookProvider(
  provider: HeavyCommandHookProvider,
  projectDir: string,
  env: Env = process.env,
): HeavyHookDetection {
  const home = homeOf(env);
  const signals: ReadonlyArray<readonly [boolean | (() => boolean), string]> =
    provider === 'claude-code'
      ? [
          [
            env.CLAUDECODE === '1' || Boolean(env.CLAUDE_CODE_ENTRYPOINT),
            'running inside Claude Code',
          ],
          [() => existsSync(join(projectDir, '.claude')), 'the project has .claude/'],
          [() => findOnPath('claude', { env }) !== null, '`claude` is on PATH'],
          [() => existsSync(env.CLAUDE_CONFIG_DIR || join(home, '.claude')), '~/.claude exists'],
        ]
      : provider === 'codex'
        ? [
            [() => existsSync(join(projectDir, '.codex')), 'the project has .codex'],
            [() => findOnPath('codex', { env }) !== null, '`codex` is on PATH'],
            [() => existsSync(env.CODEX_HOME || join(home, '.codex')), '~/.codex exists'],
          ]
        : provider === 'opencode'
          ? [
              [() => existsSync(join(projectDir, '.opencode')), 'the project has .opencode/'],
              [
                () =>
                  existsSync(join(projectDir, 'opencode.json')) ||
                  existsSync(join(projectDir, 'opencode.jsonc')),
                'the project has opencode.json',
              ],
              [() => findOnPath('opencode', { env }) !== null, '`opencode` is on PATH'],
              [
                () => existsSync(join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')),
                '~/.config/opencode exists',
              ],
            ]
          : [
              [() => findOnPath('kimi', { env }) !== null, '`kimi` is on PATH'],
              [() => existsSync(join(home, '.kimi')), '~/.kimi exists'],
            ];
  for (const [test, why] of signals) {
    if (typeof test === 'boolean' ? test : test()) return { detected: true, why };
  }
  if (provider !== 'kimi' && existsSync(heavyHookTarget(provider, projectDir, env))) {
    return { detected: true, why: 'its hook config exists' };
  }
  return {
    detected: false,
    why: `${provider} is not in use here (no config directory or CLI found)`,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Sync one provider; never throws. */
async function syncProvider(
  provider: HeavyCommandHookProvider,
  projectDir: string,
  mode: HeavyCommandHookMode,
  env: Env,
): Promise<HeavyHookDeliveryOutcome> {
  const target = heavyHookTarget(provider, projectDir, env);
  if (provider === 'kimi') {
    return mode === 'off'
      ? { provider, status: 'unchanged', target }
      : { provider, status: 'unsupported', target, reason: KIMI_REASON, remedy: KIMI_REMEDY };
  }
  try {
    const result =
      provider === 'claude-code'
        ? await syncClaudeCodeHeavyCommandHook(projectDir, mode)
        : provider === 'codex'
          ? await syncCodexHeavyCommandHook(projectDir, mode)
          : syncOpencodeHeavyCommandPlugin(projectDir, mode);
    return { provider, status: result, target };
  } catch (err) {
    if (err instanceof HeavyHookSharedConfigError) {
      return {
        provider,
        status: 'needs-consent',
        target,
        reason: err.message,
        ...(mode === 'off'
          ? {
              remedy:
                "the team committed CLEO's hook in .codex/hooks.json; remove it there in a team change if the team agrees",
            }
          : { remedy: CODEX_SHARED_REMEDY, snippet: codexHookSnippet() }),
      };
    }
    if (err instanceof HeavyHookPathBlockedError) {
      return {
        provider,
        status: 'blocked',
        target,
        reason: err.message,
        remedy: `remove or rename ${err.path} (it is not a directory), then run: ${HEAVY_HOOK_FIX_COMMAND}`,
      };
    }
    return {
      provider,
      status: 'failed',
      target,
      reason: errorText(err),
      remedy:
        err instanceof JsonConfigParseError
          ? `fix the JSON in ${err.filePath} (it was left untouched), then run: ${HEAVY_HOOK_FIX_COMMAND}`
          : `run: ${HEAVY_HOOK_FIX_COMMAND}`,
    };
  }
}

/**
 * Install, refresh or (mode `off`) remove CLEO's heavy-command hook for every
 * provider in use in `projectDir`, each independently: one provider's failure
 * never stops another. Mode `off` cleans every provider, in use or not. The
 * home directory is skipped (its provider configs are the user-global ones).
 *
 * @param projectDir - the project root.
 * @param mode - the resolved hook mode (`resources.heavyCommandHook`).
 * @param options - environment and provider list (tests).
 * @returns one outcome per provider, in {@link HEAVY_HOOK_DELIVERY_PROVIDERS} order.
 */
export async function syncProjectHeavyCommandHooks(
  projectDir: string,
  mode: HeavyCommandHookMode,
  options: HeavyHookDeliveryOptions = {},
): Promise<readonly HeavyHookDeliveryOutcome[]> {
  const env = options.env ?? process.env;
  const providers = options.providers ?? HEAVY_HOOK_DELIVERY_PROVIDERS;
  const home = isUserHomeDir(projectDir, homeOf(env));
  const outcomes: HeavyHookDeliveryOutcome[] = [];
  for (const provider of providers) {
    const target = heavyHookTarget(provider, projectDir, env);
    if (home) {
      outcomes.push({
        provider,
        status: 'skipped',
        target,
        reason: 'the project is your home directory, whose provider configs are user-global',
      });
      continue;
    }
    const detection = detectHeavyHookProvider(provider, projectDir, env);
    if (mode !== 'off' && !detection.detected) {
      outcomes.push({ provider, status: 'skipped', target, reason: detection.why });
      continue;
    }
    outcomes.push(await syncProvider(provider, projectDir, mode, env));
  }
  return outcomes;
}

/** What a JSON hook config holds: CLEO's hook (current or not), or why it cannot say. */
type JsonHookPresence =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly current: boolean }
  | { readonly kind: 'unreadable'; readonly error: string };

/** Find CLEO's heavy-command hook in a JSON hook config (`hooks.PreToolUse[].hooks[]`). */
function jsonHookPresence(file: string, provider: 'claude-code' | 'codex'): JsonHookPresence {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { kind: 'absent' }
      : { kind: 'unreadable', error: errorText(err) };
  }
  if (raw.trim() === '') return { kind: 'absent' };
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    return { kind: 'unreadable', error: errorText(err) };
  }
  if (!isPlainObject(config))
    return { kind: 'unreadable', error: 'top-level value is not an object' };
  const hooks = config.hooks;
  const groups = isPlainObject(hooks) ? hooks.PreToolUse : undefined;
  if (!Array.isArray(groups)) return { kind: 'absent' };
  const expected = JSON.stringify(heavyCommandHookObject(provider));
  let found: JsonHookPresence = { kind: 'absent' };
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
    for (const hook of group.hooks) {
      if (!isHeavyHookObject(hook)) continue;
      if (JSON.stringify(hook) === expected) return { kind: 'present', current: true };
      found = { kind: 'present', current: false };
    }
  }
  return found;
}

/** The hook's presence in a provider's target. */
function presenceOf(
  provider: 'claude-code' | 'codex' | 'opencode',
  projectDir: string,
  target: string,
): JsonHookPresence {
  if (provider !== 'opencode') {
    const local = jsonHookPresence(target, provider);
    if (provider !== 'claude-code' || local.kind !== 'absent') return local;
    // An earlier build wrote it to the shared settings.json; upgrade moves it.
    const legacy = jsonHookPresence(join(projectDir, '.claude', 'settings.json'), provider);
    return legacy.kind === 'present' ? { kind: 'present', current: false } : { kind: 'absent' };
  }
  if (!existsSync(target)) return { kind: 'absent' };
  try {
    return {
      kind: 'present',
      current: readFileSync(target, 'utf-8') === opencodeHeavyCommandPluginSource(),
    };
  } catch (err) {
    return { kind: 'unreadable', error: errorText(err) };
  }
}

/** Each provider's hook file, relative to the project (forward slashes). */
const HOOK_FILES: Readonly<Record<'claude-code' | 'codex' | 'opencode', string>> = {
  'claude-code': CLAUDE_LOCAL_SETTINGS,
  codex: CODEX_HOOKS_FILE,
  opencode: OPENCODE_PLUGIN_FILE,
};

/** Inspect one provider; never throws. */
function inspectProvider(
  provider: HeavyCommandHookProvider,
  projectDir: string,
  mode: HeavyCommandHookMode,
  env: Env,
  gitChecks: boolean,
): HeavyHookInspection {
  const target = heavyHookTarget(provider, projectDir, env);
  const { detected, why } = detectHeavyHookProvider(provider, projectDir, env);
  const base = { provider, detected, target };
  if (provider === 'kimi') {
    if (!detected || mode === 'off') return { ...base, state: 'not-detected', detail: why };
    // CLEO never writes ~/.kimi/config.toml, but reading it tells whether the
    // user added the entry by hand.
    let manual = false;
    try {
      manual = readFileSync(target, 'utf-8').includes(HEAVY_COMMAND_HOOK_ID);
    } catch {
      // No config, or unreadable: not installed by hand.
    }
    return manual
      ? { ...base, state: 'installed', detail: `a manual entry in ${target} runs the hook` }
      : { ...base, state: 'unsupported', detail: `${why}; ${KIMI_REASON}`, remedy: KIMI_REMEDY };
  }
  const presence = presenceOf(provider, projectDir, target);
  if (presence.kind === 'unreadable') {
    return {
      ...base,
      state: 'unreadable',
      detail: `${target} cannot be read or parsed (${presence.error})`,
      remedy: `fix ${target}, then run: ${HEAVY_HOOK_FIX_COMMAND}`,
    };
  }
  if (mode === 'off') {
    return presence.kind === 'present'
      ? {
          ...base,
          state: 'outdated',
          detail: 'resources.heavyCommandHook is off, but the hook is still installed',
          remedy: `run: ${HEAVY_HOOK_FIX_COMMAND} (removes it)`,
        }
      : { ...base, state: 'disabled', detail: 'resources.heavyCommandHook is off' };
  }
  if (presence.kind === 'present') {
    if (!presence.current) {
      return {
        ...base,
        state: 'outdated',
        detail: `the hook in ${target} (or a legacy location) was written by another CLEO build`,
        remedy: `run: ${HEAVY_HOOK_FIX_COMMAND}`,
      };
    }
    if (!gitChecks) return { ...base, state: 'installed', detail: `installed in ${target}` };
    // Codex's hooks.json may be a shared team config (review MED-3): CLEO's
    // per-machine hook there must not ride along in a commit.
    const shared = provider === 'codex' ? codexHooksSharedReason(projectDir, true) : null;
    if (shared !== null && excludedByCleo(projectDir, CODEX_HOOKS_FILE)) {
      return {
        ...base,
        state: 'outdated',
        detail: `CLEO's info/exclude line hides ${target}, which ${shared}`,
        remedy: `run: ${HEAVY_HOOK_FIX_COMMAND} (removes CLEO's exclude line)`,
      };
    }
    if (shared !== null) {
      const modified = trackedFileModified(projectDir, CODEX_HOOKS_FILE);
      if (modified || hookFileVisibleToGit(projectDir, CODEX_HOOKS_FILE)) {
        return {
          ...base,
          state: 'outdated',
          detail: `CLEO's per-machine hook sits in ${target}, which ${shared}, as ${modified ? 'an uncommitted change' : 'an untracked file'}: one \`git commit -a\` ships it to the team, and it widens evidence scope`,
          remedy:
            "remove CLEO's entry from .codex/hooks.json, or commit it deliberately if the team wants Codex governed",
        };
      }
      return { ...base, state: 'installed', detail: `installed in ${target}, which ${shared}` };
    }
    // A per-machine hook file git can see shows in `git status` and widens
    // `cleo verify`'s evidence scope (gh#1805); the fix excludes it.
    if (hookFileVisibleToGit(projectDir, HOOK_FILES[provider])) {
      return {
        ...base,
        state: 'outdated',
        detail: `${target} is installed but git sees it as an untracked file (it widens evidence scope)`,
        remedy: `run: ${HEAVY_HOOK_FIX_COMMAND} (adds it to the repository's info/exclude)`,
      };
    }
    return { ...base, state: 'installed', detail: `installed in ${target}` };
  }
  if (!detected) return { ...base, state: 'not-detected', detail: why };
  // The briefing (no git checks) still reads the file: a project's own
  // hooks.json needs consent, it is not missing.
  const shared = provider === 'codex' ? codexHooksSharedReason(projectDir, gitChecks) : null;
  if (shared !== null && gitChecks && excludedByCleo(projectDir, CODEX_HOOKS_FILE)) {
    return {
      ...base,
      state: 'outdated',
      detail: `CLEO's info/exclude line hides ${target}, which ${shared}`,
      remedy: `run: ${HEAVY_HOOK_FIX_COMMAND} (removes CLEO's exclude line)`,
    };
  }
  if (shared !== null) {
    return {
      ...base,
      state: 'needs-consent',
      detail: `${target} ${shared}, so CLEO does not write or hide it; Codex runs ungoverned here until the team adds the entry (${why})`,
      remedy: CODEX_SHARED_REMEDY,
      snippet: codexHookSnippet(),
    };
  }
  const blocked = nonDirectoryAncestor(dirname(target));
  if (blocked !== null) {
    return {
      ...base,
      state: 'blocked',
      detail: `${blocked} exists but is not a directory, so the hook cannot be installed (${why})`,
      remedy: `remove or rename ${blocked}, then run: ${HEAVY_HOOK_FIX_COMMAND}`,
    };
  }
  return {
    ...base,
    state: 'missing',
    detail: `${why}, but ${target} has no heavy-command hook: agent-run tests and builds bypass the machine-wide budget`,
    remedy: `run: ${HEAVY_HOOK_FIX_COMMAND}`,
  };
}

/**
 * Read-only: the hook's state for every provider in `projectDir`. Never
 * writes and never throws.
 *
 * @param projectDir - the project root.
 * @param mode - the resolved hook mode (`resources.heavyCommandHook`).
 * @param options - environment and provider list (tests).
 * @returns one inspection per provider, in {@link HEAVY_HOOK_DELIVERY_PROVIDERS} order.
 */
export function inspectProjectHeavyCommandHooks(
  projectDir: string,
  mode: HeavyCommandHookMode,
  options: HeavyHookDeliveryOptions = {},
): readonly HeavyHookInspection[] {
  const env = options.env ?? process.env;
  const providers = options.providers ?? HEAVY_HOOK_DELIVERY_PROVIDERS;
  if (isUserHomeDir(projectDir, homeOf(env))) {
    return providers.map((provider) => ({
      provider,
      detected: false,
      state: 'not-detected' as const,
      target: heavyHookTarget(provider, projectDir, env),
      detail: 'the project is your home directory; CLEO installs this hook per project only',
    }));
  }
  const gitChecks = options.gitChecks ?? true;
  return providers.map((provider) => inspectProvider(provider, projectDir, mode, env, gitChecks));
}

/** How long the hook trusts its "this cleo predates `cleo hook`" marker. */
const OLDER_CLEO_MARKER_TTL_MS = 60 * 60 * 1000;

/**
 * The marker file the hook command writes when `cleo` (at `cleoPath`, from
 * directory `dir`) answered "Unknown command": the same key as the guard
 * script (`printf '%s|%s' "$p" "$PWD" | cksum | tr -c '0-9' '-'`, in
 * `$XDG_RUNTIME_DIR`, else `$TMPDIR`, else `/tmp`), or `null` when the key
 * cannot be computed.
 */
function olderCleoMarkerPath(cleoPath: string, dir: string, env: Env): string | null {
  try {
    const key = execFileSync(
      '/bin/sh',
      ['-c', `printf '%s|%s' "$1" "$2" | cksum | tr -c '0-9' '-'`, 'sh', cleoPath, dir],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    );
    const base = env.XDG_RUNTIME_DIR || env.TMPDIR || '/tmp';
    return join(base, `${OLDER_CLEO_MARKER_PREFIX}${key}`);
  } catch {
    return null;
  }
}

/** Whether the hook's own marker says this `cleo` predates `cleo hook` (the guard's validity rules). */
function hasOlderCleoMarker(cleoPath: string, dir: string, env: Env): boolean {
  const marker = olderCleoMarkerPath(cleoPath, dir, env);
  if (marker === null) return false;
  try {
    const st = lstatSync(marker);
    if (!st.isFile()) return false;
    if (Date.now() - st.mtimeMs > OLDER_CLEO_MARKER_TTL_MS) return false;
    return statSync(cleoPath).mtimeMs <= st.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Whether the `cleo` on PATH, as the hook resolves it from `projectDir`, can
 * answer the hook. A hook installed in front of an older CLEO (no `cleo hook`,
 * so no `cleo run`) lets every command run ungoverned, so `cleo doctor` must
 * say so. The check is the hook's own: its marker for this binary and
 * directory, else one call to `cleo hook heavy-command` with an empty payload,
 * where an older CLEO exits 127 with "Unknown command".
 *
 * @param projectDir - the project root (a version-manager shim may resolve a
 *   different `cleo` per directory).
 * @param options - environment (tests).
 * @returns the CLI's state.
 */
export function probeHeavyHookCli(
  projectDir: string,
  options: HeavyHookDeliveryOptions = {},
): HeavyHookCliProbe {
  const env = options.env ?? process.env;
  const path = findOnPath('cleo', { env });
  if (path === null) {
    return {
      state: 'missing',
      path: null,
      detail: 'no `cleo` on PATH, so the hook lets every heavy command run ungoverned',
      remedy: 'install CLEO so `cleo` is on PATH: npm i -g @cleocode/cleo',
    };
  }
  const older: HeavyHookCliProbe = {
    state: 'older',
    path,
    detail: `${path} predates \`cleo hook\` and \`cleo run\`, so the hook lets every heavy command run ungoverned`,
    remedy: `upgrade the cleo at ${path} (npm i -g @cleocode/cleo, or your version manager), then run: ${HEAVY_HOOK_FIX_COMMAND}`,
  };
  if (hasOlderCleoMarker(path, projectDir, env)) return older;
  const probe = spawnSync(path, ['hook', 'heavy-command', '--provider', 'claude-code'], {
    cwd: projectDir,
    env: { ...env },
    input: '{}',
    encoding: 'utf-8',
    timeout: 20_000,
  });
  if (probe.status === 0) {
    return { state: 'current', path, detail: `${path} answers \`cleo hook heavy-command\`` };
  }
  if (probe.status === 127 && /Unknown command/.test(probe.stderr ?? '')) return older;
  return {
    state: 'unknown',
    path,
    detail:
      `${path} did not answer \`cleo hook heavy-command\` (${probe.error?.message ?? `exit ${probe.status ?? 'none'}`}); ` +
      'the hook fails open, so heavy commands run ungoverned while it does not',
    remedy: `run \`${path} hook heavy-command < /dev/null\` in ${projectDir} to see why it fails (a broken version-manager shim, say)`,
  };
}

/** The delivery surface `@cleocode/core` loads at run time. */
export const heavyHookDeliveryApi: HeavyHookDeliveryApi = Object.freeze({
  syncProjectHeavyCommandHooks,
  inspectProjectHeavyCommandHooks,
  probeHeavyHookCli,
});
