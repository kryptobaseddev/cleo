/**
 * Migrate the legacy worktree-include file location to the canonical one.
 *
 * Pre-T9983 layout (deprecated): `<projectRoot>/.cleo/worktree-include`
 * Post-T9983 canonical layout:    `<projectRoot>/.worktreeinclude`
 *
 * The canonical location matches Claude Code Desktop, worktrunk-core, and
 * the broader git-worktree-tooling ecosystem convention. The reader in
 * `@cleocode/worktree` already prefers the canonical path and emits a
 * one-time `DeprecationWarning` when only the legacy path is present —
 * this migrator is the explicit, side-effect-only counterpart that moves
 * the file with a timestamped backup.
 *
 * @task T9983
 * @epic T9983 (E6-WORKTREEINCLUDE-MIGRATION)
 * @saga T9977 (SG-WORKTRUNK-OWN)
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { getCleoDirAbsolute } from '../paths.js';

/**
 * Outcome of {@link migrateWorktreeIncludeFile}.
 *
 * @task T9983
 */
export interface MigrateWorktreeIncludeResult {
  /**
   * `migrated`  — legacy → canonical move succeeded.
   * `noop`      — canonical exists or no legacy file present.
   * `conflict`  — BOTH canonical and legacy exist; canonical wins, legacy
   *               backed up out of the way (lossless).
   * `dry-run`   — `dryRun: true` was set; nothing was written.
   */
  action: 'migrated' | 'noop' | 'conflict' | 'dry-run';
  /** Canonical path checked or written: `<root>/.worktreeinclude`. */
  canonicalPath: string;
  /** Legacy path checked or moved: `<root>/.cleo/worktree-include`. */
  legacyPath: string;
  /** When `migrated` or `conflict`: path of the timestamped backup. */
  backupPath?: string;
  /** Human-readable summary; safe to echo to stdout. */
  message: string;
}

/**
 * Migrate `<projectRoot>/.cleo/worktree-include` (legacy) to
 * `<projectRoot>/.worktreeinclude` (canonical).
 *
 * Decision table:
 *
 * | canonical exists | legacy exists | dryRun | action     |
 * |------------------|---------------|--------|------------|
 * | no               | no            | -      | noop       |
 * | yes              | no            | -      | noop       |
 * | no               | yes           | true   | dry-run    |
 * | no               | yes           | false  | migrated   |
 * | yes              | yes           | true   | dry-run    |
 * | yes              | yes           | false  | conflict   |
 *
 * In the `conflict` case the canonical file is the source of truth (matches
 * the {@link loadWorktreeIncludePatterns} resolver in `@cleocode/worktree`).
 * The legacy file is backed up to `.cleo/backups/worktree-include-<ts>.bak`
 * so no content is lost.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param opts.dryRun - When `true`, return the would-be action without
 *                      touching the filesystem.
 * @returns A {@link MigrateWorktreeIncludeResult} describing what happened.
 *
 * @task T9983
 */
export async function migrateWorktreeIncludeFile(
  projectRoot: string,
  opts: { dryRun?: boolean } = {},
): Promise<MigrateWorktreeIncludeResult> {
  const dryRun = opts.dryRun === true;
  const canonicalPath = join(projectRoot, '.worktreeinclude');
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const legacyPath = join(cleoDir, 'worktree-include');

  const canonicalExists = existsSync(canonicalPath);
  const legacyExists = existsSync(legacyPath);

  // Nothing to do.
  if (!legacyExists) {
    return {
      action: 'noop',
      canonicalPath,
      legacyPath,
      message: canonicalExists
        ? `nothing to do — .worktreeinclude already at ${canonicalPath}`
        : `nothing to do — neither .worktreeinclude nor legacy .cleo/worktree-include present`,
    };
  }

  if (dryRun) {
    return {
      action: 'dry-run',
      canonicalPath,
      legacyPath,
      message: canonicalExists
        ? `would back up legacy ${legacyPath} (canonical already exists; would NOT overwrite)`
        : `would copy legacy ${legacyPath} → ${canonicalPath} and back up the legacy file`,
    };
  }

  // Compute backup path under .cleo/backups/.
  const backupDir = join(cleoDir, 'backups');
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDir, `worktree-include-${stamp}.bak`);

  if (canonicalExists) {
    // Conflict path — canonical wins; legacy is backed up out of the way.
    await rename(legacyPath, backupPath);
    return {
      action: 'conflict',
      canonicalPath,
      legacyPath,
      backupPath,
      message:
        `BOTH .worktreeinclude and legacy .cleo/worktree-include were present. ` +
        `Canonical at ${canonicalPath} is the source of truth. Legacy file backed up to ${backupPath}.`,
    };
  }

  // Standard migration path — copy first (atomic enough for our usage),
  // then move the legacy file into the backup slot.
  await copyFile(legacyPath, canonicalPath);
  await rename(legacyPath, backupPath);

  return {
    action: 'migrated',
    canonicalPath,
    legacyPath,
    backupPath,
    message: `migrated legacy ${legacyPath} → ${canonicalPath} (backup: ${backupPath})`,
  };
}
