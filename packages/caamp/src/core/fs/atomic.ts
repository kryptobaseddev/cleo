/**
 * Atomic file writes and cross-process file locking.
 *
 * CAAMP mutates files that are shared by *every* project on the machine — most
 * critically `~/.agents/AGENTS.md`, which every `cleo init`, `cleo upgrade` and
 * `cleo doctor` run rewrites regardless of which project it was invoked from.
 * A plain `writeFile` on such a path is `open(O_TRUNC)` followed by one or more
 * `write(2)` calls: two processes interleaving there can leave a caller reading
 * a half-written file, and a reader racing a writer can observe a truncated
 * one.
 *
 * Two primitives remove that class of failure:
 *
 * - `writeFileAtomic` — the canonical tmp-then-rename primitive from
 *   `@cleocode/core/tools/fs.js`. `rename(2)` within a filesystem is atomic, so
 *   a concurrent reader sees either the whole old file or the whole new one,
 *   never a mixture. It is re-exported here for callers already importing this
 *   module; the definition lives in core, per the tools-vs-skills boundary.
 * - {@link withFileLock} — serialise a whole read-modify-write cycle across
 *   processes via an `O_EXCL` guard file, so two writers cannot both read the
 *   pre-state and then clobber each other's result. Generalised from the
 *   bespoke copy that lived inline in `lock-utils.ts` (now a caller).
 *
 * @task T12051
 */

import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from '@cleocode/core/tools/fs.js';

/**
 * A guard file older than this is assumed to belong to a crashed process.
 *
 * Generous on purpose. The critical sections here are a read, a string
 * transform and an atomic write — milliseconds. Reclaiming after a short
 * interval does not speed anything up, it just makes it likelier that a
 * *live but descheduled* holder gets its guard stolen, which is a correctness
 * failure rather than a performance one.
 */
const DEFAULT_STALE_LOCK_MS = 30_000;

/**
 * How many times {@link withFileLock} retries before giving up.
 *
 * 400 × 25 ms ≈ 10 s. The previous 40 × 25 ms ≈ 1 s budget expired under
 * exactly the multi-session contention the lock exists to handle.
 */
const DEFAULT_LOCK_RETRIES = 400;

/** Delay between lock acquisition attempts, in milliseconds. */
const DEFAULT_LOCK_DELAY_MS = 25;

/** Resolve after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Options controlling {@link withFileLock}.
 *
 * @public
 */
export interface FileLockOptions {
  /**
   * Number of acquisition attempts before throwing.
   *
   * @defaultValue 400
   */
  retries?: number;
  /**
   * Delay between attempts, in milliseconds.
   *
   * @defaultValue 25
   */
  delayMs?: number;
  /**
   * Age at which an existing guard file is treated as abandoned and removed.
   *
   * @defaultValue 30000
   */
  staleMs?: number;
}

/**
 * Remove a guard file that is older than `staleMs`.
 *
 * @param guardPath - Path of the guard file
 * @param staleMs - Age beyond which the guard is considered abandoned
 * @param expectedToken - Token observed in the guard before waiting. The guard
 *   is only reclaimed if it still carries this token, so a guard that was
 *   released and re-acquired by someone else in the meantime is never removed.
 * @returns `true` if a stale guard was removed
 */
async function removeStaleGuard(
  guardPath: string,
  staleMs: number,
  expectedToken: string | null,
): Promise<boolean> {
  try {
    const info = await stat(guardPath);
    if (Date.now() - info.mtimeMs <= staleMs) return false;

    // Re-read: only reclaim the *same* guard we decided was stale.
    const current = await readFile(guardPath, 'utf-8').catch(() => null);
    if (expectedToken !== null && current !== null && current !== expectedToken) return false;

    await rm(guardPath, { force: true });
    return true;
  } catch {
    // Missing or unreadable — nothing to reclaim.
  }
  return false;
}

/**
 * Run `fn` while holding an exclusive cross-process lock on `targetPath`.
 *
 * The lock is a `<targetPath>.lock` guard file created with `O_EXCL`, which is
 * atomic on POSIX and on Windows. A guard left behind by a crashed process is
 * reclaimed once it exceeds `staleMs`.
 *
 * The guard is always released, including when `fn` throws.
 *
 * @param targetPath - Path being protected (the guard is a sibling of it)
 * @param fn - Work to perform while holding the lock
 * @param options - Retry, delay and staleness tuning
 * @returns Whatever `fn` returns
 * @throws Error if the lock cannot be acquired within `retries` attempts
 *
 * @example
 * ```typescript
 * const action = await withFileLock(agentsMd, async () => {
 *   const before = await readFile(agentsMd, "utf-8");
 *   await writeFileAtomic(agentsMd, transform(before));
 *   return "updated";
 * });
 * ```
 *
 * @public
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const retries = options.retries ?? DEFAULT_LOCK_RETRIES;
  const delayMs = options.delayMs ?? DEFAULT_LOCK_DELAY_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const guardPath = `${targetPath}.lock`;

  // Fencing token. Written into the guard so release can verify the guard it
  // is about to remove is still OURS. Without this, a holder whose guard was
  // reclaimed as stale would delete the *next* holder's guard on the way out,
  // letting two callers run their critical sections concurrently.
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;

  await mkdir(dirname(targetPath), { recursive: true });

  let acquired = false;
  for (let attempt = 0; attempt < retries && !acquired; attempt += 1) {
    try {
      // O_EXCL creation is what establishes exclusivity; the token is written
      // afterwards purely so release can prove the guard is still ours. We are
      // already the sole owner at this point, so the two-step is safe.
      const handle = await open(guardPath, 'wx');
      await handle.close();
      await writeFile(guardPath, token, 'utf-8');
      acquired = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;

      // A guard may be orphaned by a crashed process. Snapshot whose it is,
      // then only reclaim it if the very same one is still there and stale.
      const observed = await readFile(guardPath, 'utf-8').catch(() => null);
      if (await removeStaleGuard(guardPath, staleMs, observed)) continue;
      await sleep(delayMs);
    }
  }

  if (!acquired) {
    throw new Error(
      `Timed out acquiring lock for ${targetPath} after ${retries} attempts ` +
        `(~${Math.round((retries * delayMs) / 1000)}s)`,
    );
  }

  try {
    return await fn();
  } finally {
    // Only release a guard that is still ours. If it was reclaimed as stale
    // and re-acquired by another caller, removing it here would revoke THEIR
    // lock.
    const current = await readFile(guardPath, 'utf-8').catch(() => null);
    if (current === null || current === token) {
      await rm(guardPath, { force: true }).catch(() => {
        // Best-effort release — a stale guard is reclaimed by the next caller.
      });
    }
  }
}

/**
 * Throw if a read looks like it landed inside another process's
 * truncate-then-write window.
 *
 * `writeFileAtomic` makes *our* writes indivisible, but callers outside this
 * package still rewrite instruction files with a plain `writeFile`, which is
 * `open(O_TRUNC)` followed by `write(2)`. A read landing between those two
 * returns an empty string for a file that is not empty on disk. Reconciling
 * from that observation would replace every byte of the user's content with a
 * lone CAAMP block.
 *
 * Failing closed is the right trade: the caller retries or reports, and the
 * file is left exactly as it was.
 *
 * @param filePath - Path that was read, for the error message
 * @param content - What the read returned
 * @param sizeOnDisk - `stat().size` for the same path
 * @throws Error when `content` is empty but `sizeOnDisk` is greater than zero
 *
 * @example
 * ```typescript
 * const text = await readFile(p, "utf-8");
 * if (text.length === 0) assertNotTornRead(p, text, (await stat(p)).size);
 * ```
 *
 * @public
 */
export function assertNotTornRead(filePath: string, content: string, sizeOnDisk: number): void {
  if (content.length === 0 && sizeOnDisk > 0) {
    throw new Error(
      `Refusing to rewrite ${filePath}: read 0 bytes but the file is ${sizeOnDisk} bytes on ` +
        'disk (torn read from a concurrent non-atomic writer).',
    );
  }
}

/** Whether a parsed JSON value is a plain object (not an array or `null`). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A JSON config file could not be parsed, so it was left untouched.
 *
 * @remarks
 * Thrown by {@link updateJsonConfigFile} instead of treating the file as empty.
 * The pre-T12385 provider adapters caught the parse error and started from
 * `{}`, so a torn read of `~/.claude/settings.json` (Claude Code rewriting it
 * at the same moment) replaced the user's permissions, env, model and hooks
 * with CLEO's entries alone.
 *
 * @example
 * ```typescript
 * try {
 *   await updateJsonConfigFile(path, (config) => false);
 * } catch (err) {
 *   if (err instanceof JsonConfigParseError) console.error(err.filePath);
 * }
 * ```
 *
 * @public
 */
export class JsonConfigParseError extends Error {
  /** Path of the file that failed to parse. */
  readonly filePath: string;

  /**
   * @param filePath - Path of the file that failed to parse
   * @param reason - Parser message
   */
  constructor(filePath: string, reason: string) {
    super(`Refusing to rewrite ${filePath}: it is not a valid JSON object (${reason}).`);
    this.name = 'JsonConfigParseError';
    this.filePath = filePath;
  }
}

/**
 * Read-modify-write a JSON object file under the cross-process lock, writing
 * atomically, and never replacing an unparseable file.
 *
 * @remarks
 * Composes the two existing primitives — {@link withFileLock} and core's
 * `writeFileAtomic` — for provider config files such as
 * `~/.claude/settings.json` that the provider itself also rewrites (T12385):
 *
 * - The whole read → mutate → write cycle holds the `<file>.lock` guard, so
 *   two CLEO writers cannot both read the pre-state and clobber each other.
 * - The write is tmp-then-rename, so a concurrent reader (including the
 *   provider) sees the whole old file or the whole new one.
 * - A missing file starts from `{}`. A file that exists but is empty on read
 *   while non-empty on disk, is not valid JSON, or is not a JSON object throws
 *   ({@link assertNotTornRead} / {@link JsonConfigParseError}) and the file is
 *   left byte-identical.
 *
 * @param filePath - JSON file to update
 * @param mutate - Edits the parsed object in place; returns `true` when it
 *   changed something that must be written
 * @returns Whether the file was written
 * @throws {@link JsonConfigParseError} when the existing file cannot be parsed
 *   as a JSON object; the file is not modified
 *
 * @example
 * ```typescript
 * const wrote = await updateJsonConfigFile(settingsPath, (settings) => {
 *   if (settings.enabled === true) return false;
 *   settings.enabled = true;
 *   return true;
 * });
 * ```
 *
 * @public
 */
export async function updateJsonConfigFile(
  filePath: string,
  mutate: (config: Record<string, unknown>) => boolean,
): Promise<boolean> {
  return withFileLock(filePath, async () => {
    let config: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      const raw = await readFile(filePath, 'utf-8');
      if (raw.length === 0) assertNotTornRead(filePath, raw, (await stat(filePath)).size);
      if (raw.trim().length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          throw new JsonConfigParseError(
            filePath,
            err instanceof Error ? err.message : String(err),
          );
        }
        if (!isJsonObject(parsed)) {
          throw new JsonConfigParseError(filePath, 'top-level value is not an object');
        }
        config = parsed;
      }
    }

    if (!mutate(config)) return false;
    await writeFileAtomic({ path: filePath, content: `${JSON.stringify(config, null, 2)}\n` });
    return true;
  });
}
