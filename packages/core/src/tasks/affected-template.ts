/**
 * The affected-scope test template a project runs under, declared or derived
 * (T13125).
 *
 * A scope-aware `tool:test` (T12959) runs only the packages a branch changed,
 * plus their dependents, when the project declares `testing.affectedCommand`.
 * Most workspaces never declared one, so every `cleo verify --evidence
 * tool:test` ran the whole workspace suite, once per task: on 2026-10-03
 * VidaPeps (`testing.command` = `pnpm -r --no-bail --if-present run test`)
 * ran its entire suite for T1955 and then again for T1956, back to back.
 *
 * For the commands whose workspace-wide form names the scope as one flag, the
 * affected form is mechanical — the same command with that flag replaced by a
 * per-package selection:
 *
 * | Workspace-wide test command        | Affected template                     |
 * |------------------------------------|---------------------------------------|
 * | `pnpm -r [flags] [run] test`       | `pnpm {filters} [flags] [run] test`   |
 * | `npm [run] test --workspaces`      | `npm [run] test {workspaces}`         |
 * | `turbo run test` (no `--filter`)   | `turbo run test {filters}`            |
 *
 * It runs the same per-package `test` scripts the full command runs, on the
 * subset; the affected planner still refuses the scope (a full run) when a
 * change touches anything outside every package. A `<pm> run test` /
 * `npm test` command that delegates to the root `test` script is read through
 * that script once. Anything else derives nothing.
 *
 * A declared `testing.affectedCommand` always wins; a derived one is reported
 * as derived, with the command it came from, so `cleo init`, `cleo detect`
 * and `cleo doctor` can propose it and an evidence atom can say what it ran.
 *
 * @module
 * @task T13125
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitCommandLine } from './command-line.js';

/** Where an affected template came from. */
export type AffectedTemplateSource = 'declared' | 'derived';

/** An affected-scope test template and its provenance. */
export interface AffectedTemplate {
  /** The template, e.g. `pnpm {filters} --no-bail --if-present run test`. */
  readonly template: string;
  /** `declared` in `.cleo/project-context.json`, or `derived` from `testing.command`. */
  readonly source: AffectedTemplateSource;
  /** For a derived template: the workspace-wide command it was derived from. */
  readonly basis: string | null;
}

/** Package-manager flags that select every workspace package. */
const PNPM_RECURSIVE = new Set(['-r', '--recursive']);
const NPM_ALL_WORKSPACES = new Set(['--workspaces', '-ws']);

/** Flags that already narrow the selection: a command carrying one is not workspace-wide. */
const SELECTION_FLAGS = /^(--filter|-F|--workspace|-w|--scope|--affected)(=|$)/;

/** A word `splitCommandLine` reads back unchanged without quoting. */
const BARE_WORD = /^[A-Za-z0-9_@%+=:,./{}^-]+$/;

/** Quote one argv word so {@link splitCommandLine} reads it back verbatim. */
function quoteWord(word: string): string {
  return BARE_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether `root` is a workspace root: a `pnpm-workspace.yaml`, or a
 * `package.json` declaring `workspaces`.
 *
 * @param root - Directory to inspect.
 * @returns `true` for a workspace root.
 * @task T13125
 */
export function isWorkspaceRoot(root: string): boolean {
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      workspaces?: unknown;
    };
    return pkg.workspaces !== undefined;
  } catch {
    return false;
  }
}

/** The root `package.json` `test` script, if any. */
function rootTestScript(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, unknown>;
    };
    const script = pkg.scripts?.test;
    return typeof script === 'string' && script.trim() !== '' ? script : null;
  } catch {
    return null;
  }
}

/**
 * Whether `words` (after the runner) run the `test` script: `run test` anywhere
 * (a flag value before it cannot be mistaken for the script), or `test` as the
 * first non-flag word.
 */
function runsTestScript(words: readonly string[]): boolean {
  if (words.some((w, i) => w === 'test' && words[i - 1] === 'run')) return true;
  return words.find((w) => !w.startsWith('-')) === 'test';
}

/** Whether `words` delegate to the root `test` script: `<pm> test`, `<pm> run test`, `npm t`. */
function delegatesToRootScript(words: readonly string[]): boolean {
  const [runner, ...rest] = words;
  if (runner !== 'pnpm' && runner !== 'npm' && runner !== 'yarn' && runner !== 'bun') return false;
  if (rest.some((w) => w.startsWith('-'))) return false;
  return (
    (rest.length === 1 && (rest[0] === 'test' || rest[0] === 't')) ||
    (rest.length === 2 && rest[0] === 'run' && rest[1] === 'test')
  );
}

/** The affected form of one workspace-wide command, or `null`. */
function deriveFromWords(words: readonly string[]): string[] | null {
  if (words.some((w) => SELECTION_FLAGS.test(w))) return null;
  const [runner, ...rest] = words;
  if (runner === 'pnpm' && runsTestScript(rest)) {
    const at = rest.findIndex((w) => PNPM_RECURSIVE.has(w));
    if (at === -1) return null;
    return [runner, ...rest.slice(0, at), '{filters}', ...rest.slice(at + 1)];
  }
  if (runner === 'npm' && runsTestScript(rest)) {
    const at = rest.findIndex((w) => NPM_ALL_WORKSPACES.has(w));
    if (at === -1) return null;
    return [runner, ...rest.slice(0, at), '{workspaces}', ...rest.slice(at + 1)];
  }
  const turboAt = words.indexOf('turbo');
  const isTurbo = turboAt === 0 || (turboAt === 1 && /^(pnpm|npx|yarn|bunx)$/.test(runner ?? ''));
  if (isTurbo) {
    const task = words.slice(turboAt + 1).filter((w) => !w.startsWith('-'));
    const tasks = task[0] === 'run' ? task.slice(1) : task;
    if (tasks.length === 1 && tasks[0] === 'test') return [...words, '{filters}'];
  }
  return null;
}

/**
 * Derive an affected-scope test template from a workspace's test command.
 *
 * @param root - The workspace root (its `package.json` and workspace file are read).
 * @param testCommand - `testing.command`, as declared or detected; when absent,
 *   the root `test` script (what the language default runs) is read instead.
 * @returns The template and the workspace-wide command it came from, or `null`
 *   when the command is not one whose affected form is mechanical, uses shell
 *   syntax, or `root` is not a workspace.
 *
 * @example
 * ```ts
 * proposeAffectedCommand(root, 'pnpm -r --no-bail --if-present run test');
 * // → { template: 'pnpm {filters} --no-bail --if-present run test',
 * //     basis: 'pnpm -r --no-bail --if-present run test' }
 * ```
 *
 * @task T13125
 */
export function proposeAffectedCommand(
  root: string,
  testCommand: string | undefined,
): { template: string; basis: string } | null {
  if (!isWorkspaceRoot(root)) return null;
  const derive = (command: string): { template: string; basis: string } | null => {
    let words: string[];
    try {
      words = splitCommandLine(command, 'testing.command');
    } catch {
      return null;
    }
    const affected = deriveFromWords(words);
    return affected === null
      ? null
      : { template: affected.map(quoteWord).join(' '), basis: command };
  };
  // No declared command: the language default runs the root `test` script.
  if (testCommand === undefined || testCommand.trim() === '') {
    const script = rootTestScript(root);
    return script === null ? null : derive(script);
  }
  const direct = derive(testCommand);
  if (direct !== null) return direct;
  let words: string[];
  try {
    words = splitCommandLine(testCommand, 'testing.command');
  } catch {
    return null;
  }
  const script = delegatesToRootScript(words) ? rootTestScript(root) : null;
  return script === null ? null : derive(script);
}

/**
 * The affected template a project's evidence runs use: the declared
 * `testing.affectedCommand`, else one derived from `testing.command`
 * ({@link proposeAffectedCommand}), else `null`.
 *
 * @param testing - The raw `testing` block of `.cleo/project-context.json`.
 * @param root - The workspace root the derivation inspects.
 * @returns The template with its provenance, or `null`.
 *
 * @task T13125
 */
export function resolveAffectedTemplate(
  testing: { affectedCommand?: unknown; command?: unknown } | undefined,
  root: string,
): AffectedTemplate | null {
  const declared = testing?.affectedCommand;
  if (typeof declared === 'string' && declared.trim() !== '') {
    return { template: declared, source: 'declared', basis: null };
  }
  const command = typeof testing?.command === 'string' ? testing.command : undefined;
  const proposal = proposeAffectedCommand(root, command);
  return proposal === null
    ? null
    : { template: proposal.template, source: 'derived', basis: proposal.basis };
}
