/**
 * Install CLEO's heavy-command hook into a project's provider configs (T12983).
 *
 * The hook (`cleo hook heavy-command`, in `@cleocode/cleo`) runs before every
 * shell command an agent issues and routes heavy work (tests, builds,
 * typechecks, installs) through `cleo run`, the machine-wide resource budget.
 * Delivery per provider:
 *
 * - Claude Code: a `PreToolUse` / `Bash` hook in
 *   `<project>/.claude/settings.local.json`: project-level but per machine,
 *   which fits a per-machine budget. When git does not ignore that file yet,
 *   a marked block in the repository's `info/exclude` keeps it out of git.
 * - Codex: the same hook in `<project>/.codex/hooks.json` (Codex asks the
 *   user to review and trust a new project hook in `/hooks` before it runs).
 * - opencode: a `tool.execute.before` / `tool.execute.after` plugin at
 *   `<project>/.opencode/plugins/cleo-heavy-command.js`.
 * - Kimi: not installed. Kimi reads hooks only from the global
 *   `~/.kimi/config.toml` and cannot rewrite input; `cleo hook heavy-command
 *   --provider kimi` speaks its protocol for a manual `[[hooks]]` entry.
 *
 * Project-level only: CLEO never writes this hook into a user-global config,
 * and never into the home directory's provider configs. The hook command
 * decides cheaply before it starts `cleo` (a tool name must appear as a whole
 * word), guards against a missing or older `cleo`, and always exits 0. Only
 * CLEO's own hook object is ever added, replaced or removed: a user hook that
 * shares its matcher group stays. Mode `off` removes it again.
 *
 * @task T12983
 * @epic T12978
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { updateJsonConfigFile } from '@cleocode/caamp';
import type { HeavyCommandHookMode } from '@cleocode/contracts';
import { CLEO_HOOK_MARKER, hookMap, isPlainObject } from './hook-config.js';

/** Identifies the heavy-command hook among CLEO's hook commands. */
export const HEAVY_COMMAND_HOOK_ID = 'cleo hook heavy-command';

/** Seconds a harness waits for the hook before it runs the command unchanged. */
export const HEAVY_COMMAND_HOOK_TIMEOUT_SEC = 20;

/** File name of the generated opencode plugin. */
export const OPENCODE_HEAVY_COMMAND_PLUGIN = 'cleo-heavy-command.js';

/**
 * Tool names that send a shell call on to `cleo hook`: a superset of the
 * command words `run-class` treats as heavy (test runners, compilers,
 * bundlers, linters, package managers and their exec runners, cargo, go).
 * Matched as whole words only, so `cat test-notes.md` never starts `cleo`;
 * recognition proper stays in `run-class` inside `cleo hook`.
 */
export const HEAVY_TOOL_WORDS: readonly string[] = Object.freeze([
  'vitest',
  'jest',
  'mocha',
  'ava',
  'tap',
  'playwright',
  'pytest',
  'rspec',
  'phpunit',
  'tsc',
  'tsup',
  'turbo',
  'vite',
  'esbuild',
  'webpack',
  'rollup',
  'next',
  'nx',
  'biome',
  'eslint',
  'svelte-check',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'pnpx',
  'bunx',
  'cargo',
  'go',
]);

/**
 * What a sync did to one config file. `skipped`: the project is the user's
 * home directory, whose provider configs are the user-global ones.
 */
export type HeavyHookSyncResult = 'installed' | 'updated' | 'removed' | 'unchanged' | 'skipped';

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * A config path cannot be created because something on the way to it exists
 * but is not a directory (T13124: a stray empty `<project>/.codex` file made
 * `mkdirSync` throw `EEXIST` and aborted the Codex install). Nothing is
 * written; the delivery reports the provider as `blocked`.
 */
export class HeavyHookPathBlockedError extends Error {
  /** The existing path that is not a directory. */
  readonly path: string;

  /**
   * @param path - the existing non-directory path.
   * @param target - the config file that would have lived under it.
   */
  constructor(path: string, target: string) {
    super(`${path} exists but is not a directory, so ${target} cannot be created under it`);
    this.name = 'HeavyHookPathBlockedError';
    this.path = path;
  }
}

/**
 * The nearest existing path at or above `dir` when it is NOT a directory, or
 * `null` when the nearest existing one is a directory (so `mkdir -p dir`
 * can succeed). Errors other than "does not exist" return `null` and are left
 * to the write that follows.
 *
 * @param dir - the directory a config file needs.
 */
export function nonDirectoryAncestor(dir: string): string | null {
  let cur = resolve(dir);
  for (;;) {
    try {
      return statSync(cur).isDirectory() ? null : cur;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Create `dirname(target)`, or throw {@link HeavyHookPathBlockedError} when a file is in the way. */
function ensureParentDir(target: string): void {
  const blocked = nonDirectoryAncestor(dirname(target));
  if (blocked !== null) throw new HeavyHookPathBlockedError(blocked, target);
  mkdirSync(dirname(target), { recursive: true });
}

/**
 * Whether `projectDir` is the user's home directory. There,
 * `<home>/.claude/settings.local.json`, `<home>/.codex/hooks.json` and
 * `<home>/.opencode/` act as user-global configs, and CLEO installs this
 * hook per project only, so the installers skip it.
 *
 * @param projectDir - the project root an installer was given.
 * @param home - the home directory (injectable for tests).
 */
export function isUserHomeDir(projectDir: string, home: string = homedir()): boolean {
  return canonical(projectDir) === canonical(home);
}

/**
 * The context line an older CLEO gets: its `cleo` has no `cleo hook` (and so
 * no `cleo run`), so the command runs unchanged and ungoverned. A
 * Claude-style `PreToolUse` answer; no single quotes (it is inlined into a
 * single-quoted `sh` word).
 */
export const OLDER_CLEO_HOOK_ANSWER = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    additionalContext:
      '[cleo] This may be a heavy command, but the cleo on PATH predates cleo hook and ' +
      'cleo run, so it runs outside the machine-wide resource budget. Upgrade CLEO to govern it.',
  },
});

/** File-name prefix of the "this cleo has no `cleo hook`" markers in `$TMPDIR`. */
export const OLDER_CLEO_MARKER_PREFIX = 'cleo-hook-unsupported-';

/**
 * Delete this user's older-CLEO markers, so a CLEO that has just installed the
 * hook is asked again at once instead of after the marker lapses.
 *
 * @param dir - the directory the hook command keeps markers in
 *   (`$XDG_RUNTIME_DIR`, else `$TMPDIR`).
 * @returns how many markers were removed.
 */
export function clearOlderCleoMarkers(
  dir: string = process.env.XDG_RUNTIME_DIR || tmpdir(),
): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(OLDER_CLEO_MARKER_PREFIX)) continue;
    try {
      rmSync(join(dir, name), { force: true });
      removed++;
    } catch {
      // Someone else's marker, or already gone.
    }
  }
  return removed;
}

/** Quote `text` as one `sh` word (also valid in zsh, bash and fish). */
function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The guard script both JSON configs run, a POSIX `sh` script that always
 * exits 0 (exit 2 would block the agent's command):
 *
 * 1. no `cleo` on PATH: print nothing (harmless on a machine without CLEO);
 * 2. no {@link HEAVY_TOOL_WORDS} word anywhere in the payload: print nothing
 *    without starting `cleo`. This is what most shell calls cost: one `sed`;
 * 3. this `cleo` is known to lack `cleo hook`: print
 *    {@link OLDER_CLEO_HOOK_ANSWER} without starting `cleo`. The marker lives
 *    in `$XDG_RUNTIME_DIR` (else `$TMPDIR`, else `/tmp`), is keyed on the
 *    resolved `cleo` path AND the directory (a version-manager shim such as
 *    mise's resolves a different `cleo` per project), must be a regular file
 *    the user owns (never a symlink), and lapses when the binary is newer,
 *    after an hour, or when a newer CLEO installs the hook
 *    ({@link clearOlderCleoMarkers});
 * 4. otherwise ask `cleo hook heavy-command` and print its answer when it is
 *    a JSON object. Only the older-CLEO signature (exit 127 with "Unknown
 *    command" on stderr) writes the marker (created with `mktemp`, moved into
 *    place) and prints the notice; any other failure, such as a current CLEO
 *    killed under memory pressure, fails open silently and asks again on the
 *    next call.
 */
function heavyCommandGuardScript(provider: 'claude-code' | 'codex'): string {
  const words = HEAVY_TOOL_WORDS.join('|');
  const old = `printf '%s\\n' '${OLDER_CLEO_HOOK_ANSWER}'`;
  return [
    'command -v cleo >/dev/null 2>&1 || exit 0',
    'in="$(cat)"',
    'set -f',
    'hit=',
    // `[\]` (not `\\`) matches a backslash: it survives fish's quoting under Codex.
    `for w in $(printf '%s' "$in" | sed 's/[\\][nrt]/ /g; s/[^A-Za-z0-9_./@+-]/ /g'); do case "\${w##*/}" in ${words}) hit=1; break;; esac; done`,
    '[ -n "$hit" ] || exit 0',
    'p="$(command -v cleo)"',
    `d="\${XDG_RUNTIME_DIR:-\${TMPDIR:-/tmp}}"`,
    `k="$d/${OLDER_CLEO_MARKER_PREFIX}$(printf '%s|%s' "$p" "$PWD" | cksum | tr -c '0-9' '-')"`,
    `if [ -f "$k" ] && [ ! -L "$k" ] && [ -O "$k" ] && ! [ "$p" -nt "$k" ] && [ -n "$(find "$k" -mmin -60 2>/dev/null)" ]; then ${old}; exit 0; fi`,
    'e="$(mktemp 2>/dev/null)" || e=',
    // Only the older-CLEO signature (exit 127, "Unknown command hook") writes the
    // marker; a crash or kill of a current CLEO fails open and asks again next time.
    `if out="$(printf '%s' "$in" | ${HEAVY_COMMAND_HOOK_ID} --provider ${provider} 2>"\${e:-/dev/null}")"; then case "$out" in "{"*) printf '%s\\n' "$out";; esac; else rc=$?; if [ "$rc" = 127 ] && [ -n "$e" ] && grep -q 'Unknown command' "$e" 2>/dev/null; then t="$(mktemp "$k.XXXXXX" 2>/dev/null)" && mv -f "$t" "$k"; ${old}; fi; fi`,
    '[ -z "$e" ] || rm -f "$e"',
    'exit 0',
  ].join('; ');
}

/**
 * The hook command line for a JSON hook config, ending in the `# cleo-hook`
 * marker. Claude Code runs hook commands through `sh -c`, so its line is the
 * guard script itself. Codex runs them through the user's login shell
 * (`$SHELL -lc`, which may be fish), so its line hands the script to
 * `/bin/sh -c` as one quoted word.
 *
 * @param provider - the harness protocol to answer in.
 * @returns the command line for the provider's config.
 *
 * @example
 * ```ts
 * heavyCommandHookCommand('claude-code');
 * // command -v cleo >/dev/null 2>&1 || exit 0; in="$(cat)"; set -f; …; exit 0 # cleo-hook
 * heavyCommandHookCommand('codex');
 * // /bin/sh -c 'command -v cleo >/dev/null 2>&1 || exit 0; …' # cleo-hook
 * ```
 */
export function heavyCommandHookCommand(provider: 'claude-code' | 'codex'): string {
  const script = heavyCommandGuardScript(provider);
  const line = provider === 'codex' ? `/bin/sh -c ${shellWord(script)}` : script;
  return `${line} ${CLEO_HOOK_MARKER}`;
}

/**
 * CLEO's hook object (one element of a matcher group's `hooks` array).
 *
 * @param provider - `claude-code` or `codex`.
 */
export function heavyCommandHookObject(provider: 'claude-code' | 'codex'): Record<string, unknown> {
  return {
    type: 'command',
    command: heavyCommandHookCommand(provider),
    timeout: HEAVY_COMMAND_HOOK_TIMEOUT_SEC,
  };
}

/**
 * The `hooks.PreToolUse` matcher group CLEO adds when none of the user's
 * groups holds its hook yet (Claude Code and Codex both match `Bash`).
 *
 * @param provider - `claude-code` or `codex`.
 */
export function heavyCommandHookEntry(provider: 'claude-code' | 'codex'): Record<string, unknown> {
  return { matcher: 'Bash', hooks: [heavyCommandHookObject(provider)] };
}

/** Whether one hook object is CLEO's heavy-command hook. */
export function isHeavyHookObject(hook: unknown): boolean {
  return (
    isPlainObject(hook) &&
    typeof hook.command === 'string' &&
    hook.command.includes(CLEO_HOOK_MARKER) &&
    hook.command.includes(HEAVY_COMMAND_HOOK_ID)
  );
}

/**
 * Put `desired` in place of CLEO's first heavy-command hook object, drop any
 * other copies, and drop a matcher group only when CLEO's hook was all it
 * held. `desired: null` removes CLEO's hook everywhere.
 *
 * @returns whether the groups changed, and whether CLEO's hook was found.
 */
function placeHeavyHook(
  hooks: Record<string, unknown>,
  desired: Record<string, unknown> | null,
): { readonly changed: boolean; readonly found: boolean } {
  const groups = hooks.PreToolUse;
  if (groups === undefined) return { changed: false, found: false };
  if (!Array.isArray(groups)) {
    throw new Error('hooks "PreToolUse" is not an array; not modifying it');
  }
  let changed = false;
  let found = false;
  const next: unknown[] = [];
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
      next.push(group);
      continue;
    }
    const kept: unknown[] = [];
    let groupChanged = false;
    for (const hook of group.hooks) {
      if (!isHeavyHookObject(hook)) {
        kept.push(hook);
      } else if (desired !== null && !found) {
        found = true;
        if (JSON.stringify(hook) !== JSON.stringify(desired)) groupChanged = true;
        kept.push(desired);
      } else {
        groupChanged = true;
      }
    }
    if (!groupChanged) {
      next.push(group);
      continue;
    }
    changed = true;
    if (kept.length > 0) next.push({ ...group, hooks: kept });
  }
  if (changed) hooks.PreToolUse = next;
  return { changed, found };
}

/**
 * Add, refresh or (mode `off`) remove CLEO's heavy-command hook in a JSON hook
 * config, through CAAMP's locked atomic writer. Only CLEO's own hook object is
 * touched; a malformed file throws and is left as it is.
 *
 * @param configPath - the config file (created when missing, unless `off`).
 * @param provider - `claude-code` or `codex`.
 * @param mode - the resolved hook mode.
 * @returns what changed.
 */
export async function syncJsonHeavyCommandHook(
  configPath: string,
  provider: 'claude-code' | 'codex',
  mode: HeavyCommandHookMode,
): Promise<HeavyHookSyncResult> {
  if (mode === 'off') {
    if (!existsSync(configPath)) return 'unchanged';
    const removed = await updateJsonConfigFile(configPath, (config) => {
      if (config.hooks === undefined) return false;
      return placeHeavyHook(hookMap(config), null).changed;
    });
    return removed ? 'removed' : 'unchanged';
  }
  ensureParentDir(configPath);
  clearOlderCleoMarkers();
  let result: HeavyHookSyncResult = 'unchanged';
  await updateJsonConfigFile(configPath, (config) => {
    const hooks = hookMap(config);
    const placed = placeHeavyHook(hooks, heavyCommandHookObject(provider));
    if (placed.found) {
      if (placed.changed) result = 'updated';
      return placed.changed;
    }
    const existing = hooks.PreToolUse;
    hooks.PreToolUse = [
      ...(Array.isArray(existing) ? existing : []),
      heavyCommandHookEntry(provider),
    ];
    result = 'installed';
    return true;
  });
  return result;
}

/** Claude Code's per-machine settings file, relative to the project. */
export const CLAUDE_LOCAL_SETTINGS = '.claude/settings.local.json';

/** First line of the `info/exclude` block CLEO adds for `settings.local.json` (and alone may remove). */
export const LOCAL_SETTINGS_EXCLUDE_MARKER =
  '# cleo-hook: keep the per-machine heavy-command hook settings out of git (T12983)';

/**
 * First line of the `info/exclude` block CLEO adds for any other hook file it
 * writes: Codex's `.codex/hooks.json` and the opencode plugin (T13124, gh#1805:
 * an untracked plugin file widened `cleo verify`'s evidence scope).
 */
export const HOOK_FILE_EXCLUDE_MARKER =
  '# cleo-hook: keep a per-machine heavy-command hook file out of git (T13124)';

/** Codex's project hook config, relative to the project. */
export const CODEX_HOOKS_FILE = '.codex/hooks.json';

/** The opencode plugin, relative to the project. */
export const OPENCODE_PLUGIN_FILE = `.opencode/plugins/${OPENCODE_HEAVY_COMMAND_PLUGIN}`;

/** Run git in `projectDir`; its trimmed stdout, or `null` on any failure. */
function gitOutput(projectDir: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', projectDir, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/** The repository's `info/exclude` path for `projectDir`, or `null` outside a work tree. */
function excludeFile(projectDir: string): string | null {
  if (gitOutput(projectDir, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const path = gitOutput(projectDir, ['rev-parse', '--git-path', 'info/exclude']);
  if (path === null || path === '') return null;
  return isAbsolute(path) ? path : join(projectDir, path);
}

/** The `info/exclude` line for a project file (relative to the repo root). */
function excludeLine(projectDir: string, relPath: string): string {
  const prefix = gitOutput(projectDir, ['rev-parse', '--show-prefix']) ?? '';
  return `/${prefix}${relPath}`;
}

/**
 * Keep a hook file CLEO wrote out of git when nothing ignores it yet: add a
 * marked block naming this project's file to the repository's `info/exclude`,
 * never to a tracked `.gitignore`. A file git already tracks is left alone (an
 * exclude cannot untrack it). Keyed on the exact path line, so a second CLEO
 * project in a subdirectory of the same repository gets its own line.
 * Idempotent; does nothing outside a git work tree.
 *
 * @param projectDir - the project root.
 * @param relPath - the file, relative to the project (forward slashes).
 * @param marker - the block's first line.
 * @returns whether a block was added.
 */
export function excludeHookFileFromGit(
  projectDir: string,
  relPath: string,
  marker: string = HOOK_FILE_EXCLUDE_MARKER,
): boolean {
  const exclude = excludeFile(projectDir);
  if (exclude === null) return false;
  if (gitOutput(projectDir, ['check-ignore', relPath]) !== null) return false;
  if (gitOutput(projectDir, ['ls-files', '--error-unmatch', relPath]) !== null) return false;
  const line = excludeLine(projectDir, relPath);
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf-8') : '';
  if (text.split('\n').includes(line)) return false;
  const block = `${marker}\n${line}\n`;
  mkdirSync(dirname(exclude), { recursive: true });
  writeFileSync(exclude, text === '' || text.endsWith('\n') ? text + block : `${text}\n${block}`);
  return true;
}

/**
 * Remove the block {@link excludeHookFileFromGit} added for this project's
 * file, and only that: the exact path line and the CLEO marker right above it.
 *
 * @param projectDir - the project root.
 * @param relPath - the file, relative to the project (forward slashes).
 * @returns whether a block was removed.
 */
export function unexcludeHookFileFromGit(projectDir: string, relPath: string): boolean {
  const exclude = excludeFile(projectDir);
  if (exclude === null || !existsSync(exclude)) return false;
  const lines = readFileSync(exclude, 'utf-8').split('\n');
  const at = lines.indexOf(excludeLine(projectDir, relPath));
  const above = lines[at - 1];
  if (at < 1 || (above !== LOCAL_SETTINGS_EXCLUDE_MARKER && above !== HOOK_FILE_EXCLUDE_MARKER)) {
    return false;
  }
  lines.splice(at - 1, 2);
  writeFileSync(exclude, lines.join('\n'));
  return true;
}

/**
 * Whether git sees a hook file as an untracked change: inside a work tree,
 * not ignored and not tracked. Such a file shows up in `git status` and
 * widens `cleo verify`'s evidence scope (gh#1805).
 *
 * @param projectDir - the project root.
 * @param relPath - the file, relative to the project (forward slashes).
 */
export function hookFileVisibleToGit(projectDir: string, relPath: string): boolean {
  if (gitOutput(projectDir, ['rev-parse', '--is-inside-work-tree']) !== 'true') return false;
  if (gitOutput(projectDir, ['check-ignore', relPath]) !== null) return false;
  return gitOutput(projectDir, ['ls-files', '--error-unmatch', relPath]) === null;
}

/**
 * Keep `.claude/settings.local.json` out of git when nothing ignores it yet
 * (Claude Code ignores the file only when it creates it itself). See
 * {@link excludeHookFileFromGit}.
 *
 * @param projectDir - the project root.
 * @returns whether a block was added.
 */
export function excludeLocalSettingsFromGit(projectDir: string): boolean {
  return excludeHookFileFromGit(projectDir, CLAUDE_LOCAL_SETTINGS, LOCAL_SETTINGS_EXCLUDE_MARKER);
}

/**
 * Remove the block {@link excludeLocalSettingsFromGit} added for this
 * project, and only that.
 *
 * @param projectDir - the project root.
 * @returns whether a block was removed.
 */
export function unexcludeLocalSettingsFromGit(projectDir: string): boolean {
  return unexcludeHookFileFromGit(projectDir, CLAUDE_LOCAL_SETTINGS);
}

/**
 * Codex: sync the hook in `<project>/.codex/hooks.json` and keep that file out
 * of git (T13124), as {@link syncClaudeCodeHeavyCommandHook} does for Claude
 * Code's settings.
 *
 * @param projectDir - the project root.
 * @param mode - the resolved hook mode.
 * @returns what changed in `hooks.json`.
 */
export async function syncCodexHeavyCommandHook(
  projectDir: string,
  mode: HeavyCommandHookMode,
): Promise<HeavyHookSyncResult> {
  const result = await syncJsonHeavyCommandHook(join(projectDir, CODEX_HOOKS_FILE), 'codex', mode);
  if (mode === 'off') unexcludeHookFileFromGit(projectDir, CODEX_HOOKS_FILE);
  else excludeHookFileFromGit(projectDir, CODEX_HOOKS_FILE);
  return result;
}

/**
 * Claude Code: sync the hook in `<project>/.claude/settings.local.json`, keep
 * that file out of git, and remove a hook an earlier build put in the shared
 * `<project>/.claude/settings.json`.
 *
 * @param projectDir - the project root.
 * @param mode - the resolved hook mode.
 * @returns what changed in `settings.local.json`.
 */
export async function syncClaudeCodeHeavyCommandHook(
  projectDir: string,
  mode: HeavyCommandHookMode,
): Promise<HeavyHookSyncResult> {
  const result = await syncJsonHeavyCommandHook(
    join(projectDir, CLAUDE_LOCAL_SETTINGS),
    'claude-code',
    mode,
  );
  if (mode === 'off') unexcludeLocalSettingsFromGit(projectDir);
  else excludeLocalSettingsFromGit(projectDir);
  try {
    await syncJsonHeavyCommandHook(
      join(projectDir, '.claude', 'settings.json'),
      'claude-code',
      'off',
    );
  } catch {
    // Legacy cleanup only (T13124): a shared settings.json that is not valid
    // JSON is the user's to fix, and Claude Code cannot load a hook from it
    // anyway. The local install above already succeeded.
  }
  return result;
}

/**
 * Source of the opencode plugin. opencode runs plugins in-process:
 * `tool.execute.before` may replace `output.args`, and
 * `tool.execute.after` may extend the tool's output. The plugin skips calls
 * with no {@link HEAVY_TOOL_WORDS} word, asks
 * `cleo hook heavy-command --provider opencode` for the rest, applies a
 * rewrite and its longer timeout, and appends the hook's context line to the
 * tool's output (opencode has no other channel back to the agent).
 */
export function opencodeHeavyCommandPluginSource(): string {
  return [
    '// CLEO heavy-command plugin for OpenCode (generated by @cleocode/adapters, T12983).',
    '// Routes heavy shell commands (tests, builds, typechecks, installs) through',
    '// `cleo run`, the machine-wide resource budget. Opt out with',
    '// CLEO_HEAVY_COMMAND_HOOK=off, or set resources.heavyCommandHook to "off" and',
    '// run `cleo upgrade` (which deletes this file). Fails open: on any error the',
    '// command runs unchanged.',
    '',
    "import { execFile } from 'node:child_process';",
    '',
    `const HEAVY = /(?:^|[^A-Za-z0-9_.@+-])(?:${HEAVY_TOOL_WORDS.join('|')})(?=$|[^A-Za-z0-9_.@+-])/;`,
    'const contexts = new Map();',
    '',
    'function ask(payload) {',
    '  return new Promise((done) => {',
    '    const child = execFile(',
    "      'cleo',",
    "      ['hook', 'heavy-command', '--provider', 'opencode'],",
    `      { timeout: ${HEAVY_COMMAND_HOOK_TIMEOUT_SEC * 1000} },`,
    "      (err, stdout) => done(err ? '' : stdout),",
    '    );',
    "    child.on('error', () => done(''));",
    '    child.stdin?.end(JSON.stringify(payload));',
    '  });',
    '}',
    '',
    'export const CleoHeavyCommand = async ({ directory }) => ({',
    "  'tool.execute.before': async (input, output) => {",
    "    if (input?.tool !== 'bash' || typeof output?.args?.command !== 'string') return;",
    "    if (process.env.CLEO_HEAVY_COMMAND_HOOK === 'off') return;",
    '    if (!HEAVY.test(output.args.command)) return;',
    '    try {',
    "      const text = await ask({ tool_name: 'bash', tool_input: output.args, cwd: directory });",
    "      const answer = JSON.parse(text || '{}');",
    "      if (typeof answer.command === 'string') output.args.command = answer.command;",
    "      if (typeof answer.timeout === 'number') output.args.timeout = answer.timeout;",
    "      if (typeof answer.context === 'string' && input.callID) contexts.set(input.callID, answer.context);",
    '    } catch {',
    '      // Fail open.',
    '    }',
    '  },',
    "  'tool.execute.after': async (input, output) => {",
    '    const context = input?.callID ? contexts.get(input.callID) : undefined;',
    '    if (context === undefined) return;',
    '    contexts.delete(input.callID);',
    "    if (typeof output?.output === 'string') output.output += '\\n\\n' + context;",
    '  },',
    '});',
    '',
  ].join('\n');
}

/**
 * Write (or, mode `off`, delete) the opencode plugin in
 * `<projectDir>/.opencode/plugins/`, and keep it out of git (T13124).
 * Rewritten only when its content changed.
 *
 * @param projectDir - the project root.
 * @param mode - the resolved hook mode.
 * @returns what changed.
 */
export function syncOpencodeHeavyCommandPlugin(
  projectDir: string,
  mode: HeavyCommandHookMode,
): HeavyHookSyncResult {
  const pluginPath = join(projectDir, OPENCODE_PLUGIN_FILE);
  const exists = existsSync(pluginPath);
  if (mode === 'off') {
    unexcludeHookFileFromGit(projectDir, OPENCODE_PLUGIN_FILE);
    if (!exists) return 'unchanged';
    rmSync(pluginPath, { force: true });
    return 'removed';
  }
  const source = opencodeHeavyCommandPluginSource();
  const current = exists && readFileSync(pluginPath, 'utf-8') === source;
  if (!current) {
    ensureParentDir(pluginPath);
    writeFileSync(pluginPath, source, 'utf-8');
  }
  // An untracked plugin file widened `cleo verify`'s evidence scope (gh#1805).
  excludeHookFileFromGit(projectDir, OPENCODE_PLUGIN_FILE);
  return current ? 'unchanged' : exists ? 'updated' : 'installed';
}
