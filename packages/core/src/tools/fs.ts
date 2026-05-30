/**
 * Atomic filesystem tool primitives (E3 · T11405 · SG-PACKAGE-ARCH).
 *
 * The canonical `fs`-class implementations of the {@link
 * https://www.npmjs.com/package/@cleocode/contracts | @cleocode/contracts/tools/atomic}
 * contracts. Each primitive is a PURE async function of its typed input — no
 * session, loop, or global-state coupling — so it can be driven identically by
 * any transport (CLI/MCP/RPC/HTTP) and wrapped by the deny-first guardrail
 * chokepoint (T11407). This module is the forward-only consolidation TARGET for
 * the ~290 ad-hoc `node:fs` call sites across `core` (migrated under T11410);
 * it does NOT yet replace them.
 *
 * `writeFileAtomic` uses the repo's canonical tmp-then-rename doctrine (mkdir →
 * write `.tmp` → atomic `rename`), matching AGENTS.md "Runtime Data Safety" and
 * the sentient-state writer — a half-written file is never observable.
 *
 * @epic T11390
 * @task T11405
 * @saga T11387
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  PathExistsInput,
  PathExistsResult,
  ReadFileInput,
  ReadFileResult,
  WriteFileInput,
  WriteFileResult,
} from '@cleocode/contracts/tools/atomic';

/**
 * Read a file as text.
 *
 * @param input - {@link ReadFileInput} (absolute path + optional encoding).
 * @returns the path and its text content.
 *
 * @example
 * ```ts
 * const { content } = await readFileText({ path: '/abs/config.json' });
 * ```
 */
export async function readFileText(input: ReadFileInput): Promise<ReadFileResult> {
  const content = await readFile(input.path, { encoding: input.encoding ?? 'utf8' });
  return { path: input.path, content };
}

/**
 * Read and parse a JSON file.
 *
 * @typeParam T - the expected parsed shape (caller-asserted; this primitive does
 *   not validate the schema — pair with a zod parse at the call site when the
 *   input is untrusted).
 * @param path - absolute path to the `.json` file.
 * @returns the parsed value.
 * @throws SyntaxError when the file is not valid JSON.
 */
export async function readJson<T>(path: string): Promise<T> {
  const { content } = await readFileText({ path });
  return JSON.parse(content) as T;
}

/**
 * Atomically write a file via tmp-then-rename.
 *
 * Writes to a sibling `.<name>.<pid>.tmp` then `rename`s it over the target, so
 * a crash mid-write never leaves a partial file at `path`. Creates parent
 * directories by default.
 *
 * @param input - {@link WriteFileInput} (absolute path + content + createDirs).
 * @returns the path and the number of bytes written.
 */
export async function writeFileAtomic(input: WriteFileInput): Promise<WriteFileResult> {
  const dir = dirname(input.path);
  if (input.createDirs !== false) {
    await mkdir(dir, { recursive: true });
  }
  const bytesWritten = Buffer.byteLength(input.content, 'utf8');
  const tmpPath = join(dir, `.${process.pid}-${bytesWritten}.tmp`);
  await writeFile(tmpPath, input.content, { encoding: 'utf8' });
  await rename(tmpPath, input.path);
  return { path: input.path, bytesWritten };
}

/**
 * Test whether a path exists, and what kind of entry it is.
 *
 * @param input - {@link PathExistsInput} (absolute path).
 * @returns existence + (when present) `'file' | 'directory' | 'other'`.
 */
export async function pathExists(input: PathExistsInput): Promise<PathExistsResult> {
  try {
    const s = await stat(input.path);
    const kind = s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other';
    return { exists: true, kind };
  } catch {
    return { exists: false };
  }
}
