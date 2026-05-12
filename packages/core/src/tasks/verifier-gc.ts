/**
 * Verifier lifecycle GC hooks (T9225 / ADR-070).
 *
 * Manages the `.cleo/verifiers/` directory when tasks are archived or deleted:
 *   - On archive: move verifier to `.cleo/verifiers/_archived/<TID>.mjs`
 *   - On delete:  remove verifier file entirely
 *
 * Backup semantics:
 *   `.cleo/verifiers/` is tracked in git (via the allow rule in `.cleo/.gitignore`)
 *   so it is included in any git-based snapshot. For file-level backups, call
 *   {@link backupVerifiersDir} which copies the directory to
 *   `.cleo/backups/verifiers-<timestamp>/` alongside the SQLite snapshots.
 *
 * All operations are best-effort — a missing verifier or filesystem error
 * never blocks the underlying task operation.
 */

import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Resolve the canonical verifier path for a task.
 *
 * @param taskId - Task ID (e.g. "T9225").
 * @param projectRoot - Absolute path to the project root.
 * @returns Absolute path to the verifier, or null if it does not exist.
 */
function resolveVerifierPath(taskId: string, projectRoot: string): string | null {
  const upper = taskId.toUpperCase();
  const candidate = join(resolve(projectRoot), '.cleo', 'verifiers', `${upper}.mjs`);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Archive GC hook: move verifier to `.cleo/verifiers/_archived/<TID>.mjs`.
 *
 * Called after a task is archived. If no verifier exists, this is a no-op.
 *
 * @param taskId - Task ID being archived.
 * @param projectRoot - Absolute path to the project root.
 */
export function archiveVerifier(taskId: string, projectRoot: string): void {
  const verifierPath = resolveVerifierPath(taskId, projectRoot);
  if (!verifierPath) return;

  try {
    const archivedDir = join(resolve(projectRoot), '.cleo', 'verifiers', '_archived');
    if (!existsSync(archivedDir)) {
      mkdirSync(archivedDir, { recursive: true });
    }
    const upper = taskId.toUpperCase();
    renameSync(verifierPath, join(archivedDir, `${upper}.mjs`));
  } catch {
    // best-effort — never block archive operation
  }
}

/**
 * Delete GC hook: remove verifier file entirely.
 *
 * Called after a task is deleted. If no verifier exists, this is a no-op.
 *
 * @param taskId - Task ID being deleted.
 * @param projectRoot - Absolute path to the project root.
 */
export function deleteVerifier(taskId: string, projectRoot: string): void {
  const verifierPath = resolveVerifierPath(taskId, projectRoot);
  if (!verifierPath) return;

  try {
    rmSync(verifierPath);
  } catch {
    // best-effort — never block delete operation
  }
}

/**
 * Backup GC: copy `.cleo/verifiers/` to `.cleo/backups/verifiers-<timestamp>/`.
 *
 * Called as part of `cleo backup add` to snapshot the verifier directory alongside
 * SQLite database backups. Best-effort — never throws.
 *
 * @param projectRoot - Absolute path to the project root.
 */
export function backupVerifiersDir(projectRoot: string): void {
  const verifiersDir = join(resolve(projectRoot), '.cleo', 'verifiers');
  if (!existsSync(verifiersDir)) return;

  try {
    const now = new Date();
    const ts =
      `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
      `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const backupDir = join(resolve(projectRoot), '.cleo', 'backups', `verifiers-${ts}`);
    mkdirSync(backupDir, { recursive: true });
    cpSync(verifiersDir, backupDir, { recursive: true });
  } catch {
    // best-effort — never block backup operation
  }
}
