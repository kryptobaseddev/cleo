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

import { isAbsolute, join, relative, sep } from 'node:path';
import { isStorableTaskId, isTaskId } from '@cleocode/contracts';

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

/** A Windows drive path, which is a path and not a URI. */
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

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
 * A path reference is resolved exactly as `cleo manifest show` resolves it
 * (`join(root, file)`) and must stay inside `root`. URI references are left to
 * `show`, which accepts only `cleo://docs/<reference>`.
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
  if (URI_REFERENCE.test(file) && !WINDOWS_DRIVE.test(file)) return null;
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
