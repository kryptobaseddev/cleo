/**
 * What a git hook actually used (T13921), so a hooked `git push` or `git
 * commit` is charged by its measured peak, not assumed to be a scoped build
 * (a pre-push typecheck was charged 12 GiB and four routine pushes held a
 * one-file fix for 35 minutes).
 *
 * Measurements are keyed by the hook's name and the sha256 of its content, so
 * an edited hook is measured afresh. The recorded peak only grows, and the
 * charge adds {@link HOOK_PEAK_MARGIN}: a sampled peak can miss a spike.
 * Stored machine-wide beside the admission ledger. Every failure reads as
 * "not measured", which keeps the class plan.
 *
 * @task T13921
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** The measured peak is charged with this margin. */
export const HOOK_PEAK_MARGIN = 1.25;

/** Hooks kept in the file; the least recently measured are dropped. */
const MAX_HOOKS = 200;

/** One hook's measurement. */
interface HookMeasurement {
  readonly peakBytes: number;
  readonly measuredAtMs: number;
}

function file(dir: string): string {
  return join(dir, 'hook-footprints.json');
}

function readAll(dir: string): Record<string, HookMeasurement> {
  try {
    const doc = JSON.parse(readFileSync(file(dir), 'utf8')) as Record<string, HookMeasurement>;
    return typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
}

/**
 * Where git looks for a hook in the repository at `cwd`: `git rev-parse
 * --git-path hooks/<name>` honours `core.hooksPath`, and the command's own
 * global options (`-C <dir>`, `-c core.hooksPath=…`) pick the repository and
 * hooks directory it will use (T13458). Throws when git cannot say.
 *
 * @param cwd - Where the git command runs.
 * @param hook - Hook name (`pre-push`).
 * @param globals - The command's git global options.
 * @returns The absolute hook path (the file may not exist).
 */
export function gitHookPath(cwd: string, hook: string, globals: readonly string[] = []): string {
  const path = execFileSync(
    'git',
    [...globals, 'rev-parse', '--path-format=absolute', '--git-path', `hooks/${hook}`],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 },
  ).trim();
  return isAbsolute(path) ? path : join(cwd, path);
}

/**
 * The key for a hook as installed in the repository at `cwd`: `<hook>:<sha256
 * of its content>` ({@link gitHookPath}). `null` when it cannot be read.
 *
 * @param cwd - Where the git command runs.
 * @param hook - Hook name (`pre-push`).
 * @param globals - The command's git global options.
 */
export function hookFootprintKey(
  cwd: string,
  hook: string,
  globals: readonly string[] = [],
): string | null {
  try {
    const content = readFileSync(gitHookPath(cwd, hook, globals));
    return `${hook}:${createHash('sha256').update(content).digest('hex')}`;
  } catch {
    return null;
  }
}

/**
 * The measured peak for a hook key, or `null` when it was never measured.
 *
 * @param key - From {@link hookFootprintKey}.
 * @param dir - The admission directory.
 */
export function readHookPeak(key: string, dir: string): number | null {
  const m = readAll(dir)[key];
  return m !== undefined && typeof m.peakBytes === 'number' && m.peakBytes > 0 ? m.peakBytes : null;
}

/**
 * Record a measured peak for a hook key: the larger of it and the one already
 * recorded. Atomic (tmp then rename); a failure is ignored.
 *
 * @param key - From {@link hookFootprintKey}.
 * @param peakBytes - The run's measured peak resident memory.
 * @param dir - The admission directory.
 * @param nowMs - The clock.
 */
export function recordHookPeak(
  key: string,
  peakBytes: number,
  dir: string,
  nowMs: number = Date.now(),
): void {
  if (!(peakBytes > 0)) return;
  try {
    const all = readAll(dir);
    const peak = Math.max(peakBytes, all[key]?.peakBytes ?? 0);
    const kept = Object.entries({ ...all, [key]: { peakBytes: peak, measuredAtMs: nowMs } })
      .sort(([, a], [, b]) => b.measuredAtMs - a.measuredAtMs)
      .slice(0, MAX_HOOKS);
    mkdirSync(dir, { recursive: true });
    const tmp = `${file(dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)), 'utf8');
    renameSync(tmp, file(dir));
  } catch {
    // Not recorded: the next run keeps the class plan.
  }
}
