/**
 * Vacuity detection for `tool:<name>` evidence (T12633).
 *
 * A tool that exits 0 after checking NOTHING is not evidence of anything, and
 * it is indistinguishable from a real pass by exit code alone. Measured in
 * this repository: the root `tsconfig.json` is references-only
 * (`"files": []` plus `references`), so the node default `npx tsc --noEmit`
 * type-checked zero files and exited 0 in 0.34s. Every `qaPassed` gate
 * recorded with `tool:typecheck` had been validated against a no-op.
 *
 * Two provable cases are detected, both for TypeScript's `tsc`:
 *
 *   1. STATIC — a command whose `tsc` steps include NO `-b`/`--build` step
 *      and at least one of which targets a references-only config. TypeScript compiles no files for such a config
 *      outside build mode; that is its documented semantics, not a guess.
 *      Checked before the tool runs (and before any cache lookup), so a stale
 *      cached pass for the vacuous command can never be served.
 *   2. PROBE — a direct `tsc` invocation (not through a package script, whose
 *      body may `cd` elsewhere) that exited 0 is re-run with `--listFilesOnly`.
 *      Zero files outside `node_modules` means nothing was checked.
 *
 * Anything this module cannot prove is reported as NOT vacuous. A false
 * "vacuous" would reject correct work, so every unknown fails open here and
 * the ordinary exit-code verdict stands.
 *
 * @task T12633
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { ResolvedToolCommand } from './tool-resolver.js';

/**
 * Launchers that forward to a named binary: `npx tsc …`, `pnpm exec tsc …`.
 *
 * @internal
 */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** Deadline for the `--listFilesOnly` probe. Listing parses; it does not check. */
const PROBE_TIMEOUT_MS = 120_000;

/** Upper bound on nested `<pm> run <script>` expansion. */
const MAX_SCRIPT_DEPTH = 3;

/**
 * Parse a JSON-with-comments document (tsconfig allows `//`, `/* *\/` and
 * trailing commas). Returns `null` when the file is absent or unparseable —
 * an unreadable config is "unknown", never "vacuous".
 *
 * @internal
 */
function readJsonc(path: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i++;
    } else {
      out += ch;
    }
  }
  try {
    const parsed = JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the `include` a config effectively carries, following RELATIVE
 * `extends` chains (TypeScript inherits `files`/`include` from the base when
 * they are not set locally). Returns `undefined` for "not set anywhere" and
 * `null` for "cannot be determined" (a package-name `extends`, a cycle, an
 * unreadable base).
 *
 * @internal
 */
function effectiveInclude(
  config: Record<string, unknown>,
  configPath: string,
  seen: Set<string>,
): unknown[] | undefined | null {
  if (Array.isArray(config.include)) return config.include;
  const ext = config.extends;
  if (ext === undefined) return undefined;
  const bases = Array.isArray(ext) ? ext : [ext];
  let inherited: unknown[] | undefined;
  for (const base of bases) {
    if (typeof base !== 'string' || !base.startsWith('.')) return null;
    let basePath = resolve(dirname(configPath), base);
    if (!basePath.endsWith('.json')) basePath = `${basePath}.json`;
    if (seen.has(basePath)) return null;
    seen.add(basePath);
    const baseConfig = readJsonc(basePath);
    if (!baseConfig) return null;
    const inc = effectiveInclude(baseConfig, basePath, seen);
    if (inc === null) return null;
    if (inc !== undefined) inherited = inc;
  }
  return inherited;
}

/**
 * Is this tsconfig references-only — a config TypeScript compiles ZERO files
 * for unless it is run in build mode (`tsc -b`)?
 *
 * True only when it is provable: a non-empty `references` array, an explicit
 * empty `files` array (or no `files` with an explicit empty `include`), and no
 * non-empty `include` inherited through `extends`.
 *
 * @param configPath - Absolute path to a tsconfig file.
 * @returns `true` only when the config provably selects no files.
 *
 * @task T12633
 */
export function isReferencesOnlyTsconfig(configPath: string): boolean {
  const config = readJsonc(configPath);
  if (!config) return false;
  if (!Array.isArray(config.references) || config.references.length === 0) return false;

  const include = effectiveInclude(config, configPath, new Set([resolve(configPath)]));
  if (include === null) return false;
  if (include !== undefined && include.length > 0) return false;

  if (Array.isArray(config.files)) return config.files.length === 0;
  if (config.files !== undefined) return false;
  // No `files`: TypeScript's default include (`**/*`) applies unless an
  // explicit empty include was declared.
  return include !== undefined;
}

/**
 * Split a script body into its sequential command segments.
 *
 * @internal
 */
function splitScript(body: string): string[][] {
  return body
    .split(/&&|\|\||;/)
    .map((seg) => seg.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

/** Read `scripts` from `<dir>/package.json`, or `null`. */
function readScripts(dir: string): Record<string, string> | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? null;
  } catch {
    return null;
  }
}

/**
 * One `tsc` invocation found inside a resolved command.
 *
 * @internal
 */
interface TscInvocation {
  /** Arguments passed to `tsc`. */
  args: string[];
  /** `true` when the command IS the invocation (no package script between). */
  direct: boolean;
}

/**
 * Find the `tsc` invocations a command performs.
 *
 * Returns `null` when the command cannot be analysed with confidence (a
 * script that changes directory, or unbounded nesting) — "unknown" is never
 * reported as vacuous.
 *
 * @internal
 */
function findTscInvocations(
  tokens: string[],
  root: string,
  direct: boolean,
  depth: number,
): TscInvocation[] | null {
  const [cmd, ...args] = tokens;
  if (!cmd) return [];
  const bin = basename(cmd);

  if (bin === 'tsc') return [{ args, direct }];
  if (bin === 'npx' || bin === 'bunx' || bin === 'pnpx') {
    const target = args.findIndex((a) => !a.startsWith('-'));
    if (target >= 0 && basename(args[target] ?? '') === 'tsc') {
      return [{ args: args.slice(target + 1), direct }];
    }
    return [];
  }
  if (bin === 'cd' || bin === 'pushd') return null;
  if (!PACKAGE_MANAGERS.has(bin)) return [];

  const [sub, ...rest] = args;
  if (sub === 'exec' || sub === 'dlx' || sub === 'x') {
    return findTscInvocations(rest, root, direct, depth);
  }
  const scripts = readScripts(root);
  const scriptName = sub === 'run' || sub === 'run-script' ? rest[0] : sub;
  const body = scriptName !== undefined ? scripts?.[scriptName] : undefined;
  if (body === undefined) return [];
  if (depth >= MAX_SCRIPT_DEPTH) return null;

  const found: TscInvocation[] = [];
  for (const segment of splitScript(body)) {
    const inner = findTscInvocations(segment, root, false, depth + 1);
    if (inner === null) return null;
    found.push(...inner);
  }
  return found;
}

/** Does this `tsc` argument list run in build mode? */
function isBuildMode(args: string[]): boolean {
  return args.includes('-b') || args.includes('--build');
}

/**
 * The config file a non-build `tsc` invocation reads, or `null` when it names
 * input files directly (then no config is consulted).
 *
 * @internal
 */
function tscConfigPath(args: string[], root: string): string | null {
  const idx = args.findIndex((a) => a === '-p' || a === '--project');
  if (idx >= 0) {
    const value = args[idx + 1];
    if (!value) return null;
    const abs = isAbsolute(value) ? value : resolve(root, value);
    try {
      return statSync(abs).isDirectory() ? join(abs, 'tsconfig.json') : abs;
    } catch {
      return null;
    }
  }
  // Positional `.ts` inputs bypass tsconfig entirely.
  if (args.some((a) => !a.startsWith('-') && /\.[cm]?[jt]sx?$/.test(a))) return null;
  return join(root, 'tsconfig.json');
}

/**
 * Statically prove that a resolved command's `tsc` step checks nothing.
 *
 * @param command - Resolved tool command.
 * @param executionRoot - Directory the command runs in.
 * @returns A reason string when provably vacuous, otherwise `null`.
 *
 * @task T12633
 */
export function detectStaticVacuity(
  command: ResolvedToolCommand,
  executionRoot: string,
): string | null {
  const invocations = findTscInvocations([command.cmd, ...command.args], executionRoot, true, 0);
  if (!invocations) return null;
  // One build-mode step checks the referenced projects, so the command as a
  // whole is not provably vacuous even if another step is (fail open).
  if (invocations.some((inv) => isBuildMode(inv.args))) return null;
  for (const inv of invocations) {
    const configPath = tscConfigPath(inv.args, executionRoot);
    if (configPath && existsSync(configPath) && isReferencesOnlyTsconfig(configPath)) {
      return (
        `\`tsc ${inv.args.join(' ')}\` reads ${configPath}, which is references-only ` +
        `(empty "files"/"include" plus "references"). Outside build mode TypeScript ` +
        `compiles ZERO files for such a config, so this exit code checks nothing.`
      );
    }
  }
  return null;
}

/**
 * After a direct `tsc` run exited 0, count the project files it compiled.
 *
 * @param command - Resolved tool command.
 * @param executionRoot - Directory the command runs in.
 * @returns The count of compiled files outside `node_modules`, or `null` when
 *   the command is not a direct non-build `tsc` invocation or the probe could
 *   not run.
 *
 * @task T12633
 */
export function probeTscFileCount(
  command: ResolvedToolCommand,
  executionRoot: string,
): number | null {
  const invocations = findTscInvocations([command.cmd, ...command.args], executionRoot, true, 0);
  if (!invocations || invocations.length !== 1) return null;
  const [inv] = invocations;
  if (!inv?.direct || isBuildMode(inv.args) || inv.args.includes('--listFilesOnly')) return null;

  const probe = spawnSync(command.cmd, [...command.args, '--listFilesOnly'], {
    cwd: executionRoot,
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return null;
  return probe.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.replace(/\\/g, '/').includes('/node_modules/'))
    .length;
}

/**
 * The fix hint attached to every `E_EVIDENCE_TOOL_VACUOUS` result.
 *
 * @task T12633
 */
export const VACUOUS_TOOL_FIX =
  'Run the checker in a mode that covers the project: for a project-references ' +
  'tsconfig use `tsc -b` (add a "typecheck": "tsc -b" script to package.json — CLEO ' +
  'prefers it), or declare typecheck.command in .cleo/project-context.json.';
