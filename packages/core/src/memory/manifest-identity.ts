/**
 * Manifest identity validation — the entry id, the linked task ids and the
 * file reference of a `pipeline_manifest` entry (T12829).
 *
 * Before this module `cleo manifest append` stored whatever it was given: a
 * `--task` of `T99999` (no such task), a 900-character JSON blob, or
 * `../../x`. The shorthand builder turns `--task` into both the entry id and
 * the `file` reference (`.cleo/agent-outputs/<task>-<type>-<stamp>.md`), and
 * `cleo manifest show` reads `file` relative to the project root. So the blob
 * became an unreadable path (ENAMETOOLONG), and a `../` task made `show` read
 * a file outside the project. Nothing is written to that path; the defect is
 * an unvalidated identity that later flows into a filesystem read.
 *
 * Every check here is pure except {@link findMissingLinkedTasks}, which reads
 * the task store. Append rejects a problem before writing; show refuses a
 * malformed id or unsafe file before touching the filesystem; `cleo doctor
 * manifest-rows` reports rows stored before these checks existed.
 *
 * @module
 * @task T12829
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isStorableTaskId, isTaskId } from '@cleocode/contracts/task-id.js';

/** Longest accepted manifest entry id. */
export const MANIFEST_ENTRY_ID_MAX_LENGTH = 200;

/**
 * Accepted manifest entry id characters: an alphanumeric first character,
 * then alphanumerics and `.`, `_`, `:`, `@`, `+`, `-`. No path separator,
 * whitespace or control character can appear, so an id can never name a
 * path outside the directory it is joined onto.
 */
export const MANIFEST_ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/;

/** Longest accepted `file` reference. */
export const MANIFEST_FILE_MAX_LENGTH = 1024;

/** Longest accepted single path segment of a `file` reference (filesystem NAME_MAX). */
export const MANIFEST_FILE_SEGMENT_MAX_BYTES = 255;

/** A URI-shaped `file` reference (`cleo://docs/...`); `show` validates these itself. */
const URI_REFERENCE = /^[a-z][a-z\d+.-]*:/i;

/** A Windows drive path (`C:\x`, `C:/x`, drive-relative `C:x`), which is a path and not a URI. */
const WINDOWS_DRIVE = /^[a-z]:/i;

/** A UNC-looking reference (`\\server\share`, `//server/share`). */
const UNC_REFERENCE = /^[\\/]{2}/;

/** Control characters, which no id or path reference may contain. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Structured task ids CLEO mints on purpose alongside the canonical `T<digits>`
 * (`T-RECONCILE-FOLLOWUP-v2026.5.63-6`, see `isStorableTaskId`): a `T`, then
 * letters, digits, `.`, `_` and `-` only.
 */
const STRUCTURED_TASK_ID = /^T[A-Za-z0-9._-]+$/;

/**
 * Whether `value` is acceptable as a manifest linked task id: the canonical
 * `T<digits>` shape, or a structured `T…` id CLEO mints and stores
 * (`isStorableTaskId`, at most 64 characters, no whitespace or separators).
 * A JSON blob, a path, or an over-long value is never accepted.
 *
 * @param value - Candidate task id.
 * @returns `true` when the value can name a task.
 */
export function isManifestTaskId(value: unknown): value is string {
  if (isTaskId(value)) return true;
  return typeof value === 'string' && isStorableTaskId(value) && STRUCTURED_TASK_ID.test(value);
}

/** One identity problem found in a manifest entry. */
export interface ManifestIdentityIssue {
  /** The entry field at fault. */
  field: 'id' | 'linked_tasks' | 'file';
  /** `E_VALIDATION` for a malformed value; `E_NOT_FOUND` for a well-formed task id with no task. */
  code: 'E_VALIDATION' | 'E_NOT_FOUND';
  /** The offending value, truncated to 120 characters for display. */
  value: string;
  /** What is wrong. */
  message: string;
}

/**
 * Truncate a value for display in an issue so a huge input cannot flood output.
 *
 * @param value - Raw value.
 * @returns At most 120 characters, with an ellipsis and the full length when cut.
 */
function preview(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 120)}… (${value.length} chars)`;
}

/**
 * Why a manifest entry id is unacceptable, or `null` when it is fine.
 *
 * @param id - Candidate entry id.
 * @returns A reason, or `null`.
 * @example
 * ```ts
 * manifestEntryIdProblem('T123-implementation-20260929'); // null
 * manifestEntryIdProblem('../../x');                      // 'must start with ...'
 * ```
 */
export function manifestEntryIdProblem(id: unknown): string | null {
  if (typeof id !== 'string' || id === '') return 'id must be a non-empty string';
  if (id.length > MANIFEST_ENTRY_ID_MAX_LENGTH) {
    return `id is ${id.length} characters; the maximum is ${MANIFEST_ENTRY_ID_MAX_LENGTH}`;
  }
  if (!MANIFEST_ENTRY_ID_PATTERN.test(id)) {
    return 'id must start with a letter or digit and contain only letters, digits and . _ : @ + -';
  }
  return null;
}

/**
 * Why a manifest `file` reference is unsafe, or `null` when it is fine.
 *
 * Lexical checks only: an absolute, drive, UNC or backslash path is refused,
 * and the reference joined onto `root` must stay inside `root`. A symbolic
 * link inside the project can still point outside it, so every reader goes
 * through {@link resolveContainedFile} / {@link readContainedFile}, which
 * resolve real paths. URI references are left to `show`, which accepts only
 * `cleo://docs/<reference>`.
 *
 * @param file - Candidate `file` value.
 * @param root - Directory the reference is resolved against.
 * @returns A reason, or `null`.
 */
export function manifestFileProblem(file: unknown, root: string): string | null {
  if (typeof file !== 'string' || file === '') return 'file must be a non-empty string';
  if (file.length > MANIFEST_FILE_MAX_LENGTH) {
    return `file is ${file.length} characters; the maximum is ${MANIFEST_FILE_MAX_LENGTH}`;
  }
  if (CONTROL_CHARS.test(file)) return 'file must not contain control characters';
  if (UNC_REFERENCE.test(file)) return 'file must not be a UNC path';
  if (file.includes('\\')) return 'file must not contain a backslash';
  if (WINDOWS_DRIVE.test(file)) return 'file must not be a Windows drive path';
  if (file.startsWith('/') || isAbsolute(file)) return 'file must be a relative path';
  if (URI_REFERENCE.test(file)) return null;
  const tooLong = file
    .split(/[\\/]/)
    .find((segment) => Buffer.byteLength(segment, 'utf8') > MANIFEST_FILE_SEGMENT_MAX_BYTES);
  if (tooLong !== undefined) {
    return `file has a path segment longer than ${MANIFEST_FILE_SEGMENT_MAX_BYTES} bytes`;
  }
  const rel = relative(root, join(root, file));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return 'file must resolve to a path inside the project';
  }
  return null;
}

/**
 * Format checks for a manifest entry's id, linked task ids and file reference
 * (an absent `file` is not checked). Pure: no store access. Pair with {@link findMissingLinkedTasks} to check
 * that the linked tasks exist.
 *
 * @param entry - The entry's identity fields.
 * @param root - Directory `file` is resolved against (the project root).
 * @returns Every problem found; empty when the entry is well formed.
 */
export function manifestIdentityIssues(
  entry: { id?: unknown; linked_tasks?: unknown; file?: unknown },
  root: string,
): ManifestIdentityIssue[] {
  const issues: ManifestIdentityIssue[] = [];
  const idProblem = manifestEntryIdProblem(entry.id);
  if (idProblem) {
    issues.push({
      field: 'id',
      code: 'E_VALIDATION',
      value: preview(String(entry.id ?? '')),
      message: idProblem,
    });
  }
  if (entry.linked_tasks !== undefined) {
    if (!Array.isArray(entry.linked_tasks)) {
      issues.push({
        field: 'linked_tasks',
        code: 'E_VALIDATION',
        value: preview(String(entry.linked_tasks)),
        message: 'linked_tasks must be an array of task ids',
      });
    } else {
      for (const taskId of entry.linked_tasks) {
        if (!isManifestTaskId(taskId)) {
          issues.push({
            field: 'linked_tasks',
            code: 'E_VALIDATION',
            value: preview(String(taskId)),
            message: 'linked task id must be a task id such as T1234',
          });
        }
      }
    }
  }
  // An absent file is the caller's required-field check; only a present one is resolved.
  const fileProblem = entry.file === undefined ? null : manifestFileProblem(entry.file, root);
  if (fileProblem) {
    issues.push({
      field: 'file',
      code: 'E_VALIDATION',
      value: preview(String(entry.file ?? '')),
      message: fileProblem,
    });
  }
  return issues;
}

/**
 * The well-formed linked task ids that name no task in the project store
 * (archived tasks count as existing).
 *
 * @param taskIds - Linked task ids; malformed ones are skipped (format checks report them).
 * @param projectRoot - Project whose task store is consulted.
 * @returns The ids with no task, in input order, without duplicates.
 */
export async function findMissingLinkedTasks(
  taskIds: readonly string[],
  projectRoot: string,
): Promise<string[]> {
  const wellFormed = [...new Set(taskIds.filter((id) => isManifestTaskId(id)))];
  if (wellFormed.length === 0) return [];
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(projectRoot);
  const missing: string[] = [];
  for (const id of wellFormed) {
    if (!(await accessor.taskExists(id))) missing.push(id);
  }
  return missing;
}

/** Outcome of resolving a manifest `file` reference against a directory on disk. */
export type ContainedFileResolution =
  /** The reference names an existing path whose real location is inside the real root. */
  | { status: 'ok'; realPath: string }
  /** Nothing exists at the reference (including a dangling symbolic link). Never read. */
  | { status: 'not-found' }
  /** The reference is malformed or resolves outside the root. Never read. */
  | { status: 'unsafe'; reason: string };

/** Outcome of reading a manifest `file` reference; `ok` carries the content. */
export type ContainedFileRead =
  | { status: 'ok'; realPath: string; content: string }
  | { status: 'not-found' }
  | { status: 'unsafe'; reason: string };

/**
 * The error code carried by a thrown filesystem error, when it has one.
 *
 * @param error - Caught value.
 * @returns The `code` string, or `undefined`.
 */
function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** Filesystem errors that mean "nothing is there" for a manifest reference. */
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Whether `realTarget` lies strictly inside `realRoot` (separator-safe: a
 * sibling `/proj-evil` is not inside `/proj`).
 *
 * @param realRoot - Real (symlink-free) root directory.
 * @param realTarget - Real (symlink-free) candidate path.
 * @returns `true` when the target is a descendant of the root.
 */
function isInsideRealRoot(realRoot: string, realTarget: string): boolean {
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  return realTarget.startsWith(prefix);
}

/**
 * Resolve a manifest `file` reference to its real path, requiring it to stay
 * inside `root` after every symbolic link is followed (T12829).
 *
 * {@link manifestFileProblem} is lexical: `link/secret.txt` passes when
 * `link` is an in-project symlink to a directory outside the project. This
 * resolves both the root and the target with `realpathSync` and requires the
 * real target under the real root. A missing target (or a dangling link) is
 * `not-found` and must not be read; a URI reference is `unsafe` here because
 * it is not a filesystem path.
 *
 * @param root - Directory the reference is resolved against.
 * @param file - The stored `file` reference.
 * @returns The resolution; only `ok` may be read, and only via `realPath`.
 * @throws The underlying filesystem error for anything other than not-found or a link loop.
 * @example
 * ```ts
 * resolveContainedFile('/proj', 'link/secret.txt'); // { status: 'unsafe', ... } when link -> ../outside
 * ```
 */
export function resolveContainedFile(root: string, file: unknown): ContainedFileResolution {
  const problem = manifestFileProblem(file, root);
  if (problem) return { status: 'unsafe', reason: problem };
  if (typeof file !== 'string' || URI_REFERENCE.test(file)) {
    return { status: 'unsafe', reason: 'file must be a filesystem path, not a URI' };
  }
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(join(realRoot, file));
  } catch (error) {
    const code = errnoCode(error);
    if (code !== undefined && NOT_FOUND_CODES.has(code)) return { status: 'not-found' };
    if (code === 'ELOOP') return { status: 'unsafe', reason: 'file is a symbolic link loop' };
    throw error;
  }
  if (!isInsideRealRoot(realRoot, realTarget)) {
    return {
      status: 'unsafe',
      reason: 'file resolves (through a symbolic link) outside the project',
    };
  }
  return { status: 'ok', realPath: realTarget };
}

/**
 * Read a manifest `file` reference as UTF-8 text, only when its real path is
 * inside `root` (see {@link resolveContainedFile}).
 *
 * The resolved real path is opened once, without following a final symbolic
 * link and without blocking on a FIFO, and the content is read through that
 * file descriptor. After opening, the path is re-resolved and must still name
 * the same inode, so a component swapped for a link between the check and the
 * open is refused rather than read.
 *
 * @param root - Directory the reference is resolved against.
 * @param file - The stored `file` reference.
 * @returns The content, or why it was not read.
 * @throws The underlying filesystem error for failures other than not-found
 *   (a directory throws `EISDIR`).
 */
export function readContainedFile(root: string, file: unknown): ContainedFileRead {
  const resolved = resolveContainedFile(root, file);
  if (resolved.status !== 'ok') return resolved;
  const flags =
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = openSync(resolved.realPath, flags);
  } catch (error) {
    const code = errnoCode(error);
    if (code !== undefined && NOT_FOUND_CODES.has(code)) return { status: 'not-found' };
    if (code === 'ELOOP') {
      return { status: 'unsafe', reason: 'file changed into a symbolic link while being read' };
    }
    throw error;
  }
  try {
    const opened = fstatSync(fd);
    // A directory falls through to the read, which fails with EISDIR like any
    // other read failure; a FIFO, socket or device is never read.
    if (!opened.isFile() && !opened.isDirectory()) {
      return { status: 'unsafe', reason: 'file is not a regular file' };
    }
    const again = resolveContainedFile(root, file);
    if (again.status !== 'ok' || again.realPath !== resolved.realPath) {
      return { status: 'unsafe', reason: 'file changed while being read' };
    }
    const current = statSync(again.realPath);
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      return { status: 'unsafe', reason: 'file changed while being read' };
    }
    return { status: 'ok', realPath: resolved.realPath, content: readFileSync(fd, 'utf-8') };
  } finally {
    closeSync(fd);
  }
}
