/**
 * Core upgrade logic - unified project maintenance.
 *
 * Handles:
 *   1. Storage engine migration (JSON → SQLite)
 *   2. Schema version upgrades
 *   3. Structural repairs (checksums, missing fields)
 *   4. Global ~/.cleo data migration
 *
 * CLI delegates here (shared-core pattern).
 *
 * @task T4699
 * @epic T4454
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureGitHooks } from './hooks.js';
import {
  initAgentDefinition,
  initCoreSkills,
  initNexusRegistration,
  installGitHubTemplates,
} from './init.js';
import { ensureInjection } from './injection.js';
import { detectLegacyAgentOutputs, migrateAgentOutputs } from './migration/agent-outputs.js';
import { getCleoDirAbsolute, getCleoHome, getProjectRoot } from './paths.js';
import {
  ensureCleoGitRepo,
  ensureCleoStructure,
  ensureConfig,
  ensureGitignore,
  ensureProjectContext,
  ensureProjectInfo,
  ensureSqliteDb,
  removeCleoFromRootGitignore,
} from './scaffold.js';
import { cleanProjectSchemas, ensureGlobalSchemas } from './schema-management.js';
import { acquireLock, forceCheckpointBeforeOperation, type ReleaseFn } from './store/index.js';
import { checkStorageMigration, type PreflightResult } from './system/storage-preflight.js';

/** A single upgrade action with status. */
export interface UpgradeAction {
  action: string;
  status: 'applied' | 'skipped' | 'preview' | 'error';
  details: string;
  reason?: string;
  fix?: string;
}

/** Full upgrade result. */
export interface UpgradeResult {
  success: boolean;
  upToDate: boolean;
  dryRun: boolean;
  actions: UpgradeAction[];
  applied: number;
  errors: string[];
  /** Summary of what was checked (added for --diagnose and bare upgrade). */
  summary?: UpgradeSummary;
  /** Storage migration sub-result (if migration was triggered). */
  storageMigration?: {
    migrated: boolean;
    tasksImported: number;
    archivedImported: number;
    sessionsImported: number;
    warnings: string[];
  };
}

/** Counts of what upgrade checked/applied/skipped. */
export interface UpgradeSummary {
  checked: number;
  applied: number;
  skipped: number;
  errors: number;
  warnings: string[];
}

/** A single diagnostic finding from --diagnose. */
export interface DiagnoseFinding {
  check: string;
  status: 'ok' | 'warning' | 'error';
  details: string;
  fix?: string;
}

/** Result from diagnoseUpgrade(). */
export interface DiagnoseResult {
  success: boolean;
  findings: DiagnoseFinding[];
  summary: { ok: number; warnings: number; errors: number };
}

/**
 * Run a full upgrade pass on the project .cleo/ directory.
 *
 * Steps:
 *   1. Pre-flight storage check (JSON → SQLite)
 *   2. If migration needed and not dry-run, run auto-migration with backup
 *   3. Schema version checks on JSON files
 *   4. Structural repairs (checksums, missing fields)
 *
 * @param options.dryRun  Preview changes without applying
 * @param options.includeGlobal  Also check global ~/.cleo
 * @param options.autoMigrate  Auto-migrate storage if needed (default: true)
 * @param options.forceDetect  Force re-detection of project type (ignore staleness)
 * @param options.mapCodebase  Run full codebase analysis and store to brain.db
 * @param options.projectName  Update project name in project-info and nexus
 * @param options.cwd  Project directory override
 */
export async function runUpgrade(
  options: {
    dryRun?: boolean;
    includeGlobal?: boolean;
    autoMigrate?: boolean;
    forceDetect?: boolean;
    mapCodebase?: boolean;
    projectName?: string;
    cwd?: string;
  } = {},
): Promise<UpgradeResult> {
  const isDryRun = options.dryRun ?? false;
  const autoMigrate = options.autoMigrate ?? true;
  const actions: UpgradeAction[] = [];
  const errors: string[] = [];
  let storageMigrationResult: UpgradeResult['storageMigration'];

  // ── Step 1: Pre-flight storage check ──────────────────────────────
  let preflight: PreflightResult;
  try {
    preflight = checkStorageMigration(options.cwd);
  } catch (err) {
    actions.push({
      action: 'storage_preflight',
      status: 'error',
      details: `Pre-flight check failed: ${String(err)}`,
    });
    return {
      success: false,
      upToDate: false,
      dryRun: isDryRun,
      actions,
      applied: 0,
      errors: [String(err)],
    };
  }

  // Determine what actions are actually needed
  const cleoDir = getCleoDirAbsolute(options.cwd);
  const dbPath = join(cleoDir, 'tasks.db');
  const dbExists = existsSync(dbPath);

  const legacyRecordCount =
    preflight.details.todoJsonTaskCount +
    preflight.details.archiveJsonTaskCount +
    preflight.details.sessionsJsonCount;

  // Migration needed only if: no DB exists AND JSON has data
  const needsMigration = !dbExists && legacyRecordCount > 0;
  // Cleanup needed if: DB exists AND stale JSON files exist
  const needsCleanup = dbExists && preflight.migrationNeeded;

  if (needsMigration) {
    if (isDryRun) {
      actions.push({
        action: 'storage_migration',
        status: 'preview',
        details: preflight.summary,
        fix: preflight.fix ?? undefined,
      });
    } else if (autoMigrate) {
      // Auto-migrate with SAFE backup-first approach.
      // CRITICAL: Never delete tasks.db without a verified backup.
      // Previous implementation (pre-2026.2.6) had a destructive bug
      // that unconditionally deleted tasks.db before migration, causing
      // total data loss of 4,295 tasks. This fix follows the project's
      // atomic operation pattern: backup → migrate to temp → validate → rename.
      let migrationLock: ReleaseFn | null = null;
      try {
        // CRITICAL: Acquire migration lock before any destructive operations
        const cleoDir = getCleoDirAbsolute(options.cwd);
        const dbPath = join(cleoDir, 'tasks.db');
        try {
          migrationLock = await acquireLock(dbPath, { stale: 30_000, retries: 0 });
        } catch {
          // Lock acquisition failed — another migration is in progress
          actions.push({
            action: 'storage_migration',
            status: 'error',
            details: 'Cannot acquire migration lock: Another migration is currently in progress',
            fix: 'Wait for the other migration to complete, then retry.',
          });
          errors.push('Cannot acquire migration lock: Another migration is currently in progress');
          return { success: false, upToDate: false, dryRun: isDryRun, actions, applied: 0, errors };
        }

        // CRITICAL: Force checkpoint before ANY destructive operations
        await forceCheckpointBeforeOperation('storage-migration', options.cwd);

        // Initialize migration state tracking
        const { MigrationLogger } = await import('./migration/logger.js');
        const {
          createMigrationState,
          updateMigrationPhase,
          updateMigrationProgress,
          addMigrationWarning,
          completeMigration,
          failMigration,
        } = await import('./migration/state.js');
        const logger = new MigrationLogger(cleoDir);
        await createMigrationState(cleoDir, {
          todoJson: { path: join(cleoDir, 'todo.json'), checksum: '' },
          sessionsJson: { path: join(cleoDir, 'sessions.json'), checksum: '' },
          archiveJson: { path: join(cleoDir, 'todo-archive.json'), checksum: '' },
        });
        await updateMigrationPhase(cleoDir, 'backup');
        logger.info('init', 'start', 'Migration state initialized');
        const dbBackupPath = join(
          cleoDir,
          'backups',
          'safety',
          `tasks.db.pre-migration.${Date.now()}`,
        );
        const dbTempPath = join(cleoDir, 'tasks.db.migrating');

        // Step 1: Backup existing tasks.db if it exists (NEVER delete without backup)
        if (existsSync(dbPath)) {
          const backupDir = join(cleoDir, 'backups', 'safety');
          if (!existsSync(backupDir)) {
            mkdirSync(backupDir, { recursive: true });
          }
          copyFileSync(dbPath, dbBackupPath);

          // Verify backup integrity: SHA-256 checksum + SQLite open check
          const { createHash } = await import('node:crypto');
          const origChecksum = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
          const backupChecksum = createHash('sha256')
            .update(readFileSync(dbBackupPath))
            .digest('hex');
          if (origChecksum !== backupChecksum) {
            throw new Error(
              `Backup verification failed: checksum mismatch. ` +
                `Aborting migration to prevent data loss.`,
            );
          }
          const { validateSqliteDatabase } = await import('./store/atomic.js');
          const backupIsValid = await validateSqliteDatabase(dbBackupPath);
          if (!backupIsValid) {
            throw new Error(
              `Backup verification failed: backup is not a valid SQLite database. ` +
                `Aborting migration to prevent data loss.`,
            );
          }
          logger.info('backup', 'verified', 'Backup integrity verified', {
            checksum: origChecksum,
          });
        }

        // Step 2: Remove temp DB if leftover from a previous failed attempt
        if (existsSync(dbTempPath)) {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(dbTempPath);
        }

        // Step 3: Save config backup in case we need to restore after failure
        const configPath = join(cleoDir, 'config.json');
        let configBackup: string | null = null;
        if (existsSync(configPath)) {
          configBackup = readFileSync(configPath, 'utf-8');
        }

        // Step 4: Close any existing DB connection before migration
        const { resetDbState } = await import('./store/sqlite.js');
        resetDbState();

        // Step 5 removed — do not delete original DB; atomic rename preserves it until new DB is verified

        // Step 6: Migrate JSON → temp DB, then atomically rename into place
        await updateMigrationPhase(cleoDir, 'import');
        const { migrateJsonToSqliteAtomic } = await import('./store/migration-sqlite.js');
        const { atomicDatabaseMigration, validateSqliteDatabase: validateDb } = await import(
          './store/atomic.js'
        );
        const result = await migrateJsonToSqliteAtomic(options.cwd, dbTempPath, logger);

        // Step 6b: Atomically rename temp DB into place (only if migration succeeded)
        if (result.success) {
          const atomicResult = await atomicDatabaseMigration(dbPath, dbTempPath, validateDb);
          if (!atomicResult.success) {
            throw new Error(
              `Atomic rename failed: ${atomicResult.error}. Original database preserved.`,
            );
          }
        }

        // Update progress
        await updateMigrationProgress(cleoDir, {
          tasksImported: result.tasksImported,
          archivedImported: result.archivedImported,
          sessionsImported: result.sessionsImported,
        });

        // Log any warnings
        for (const warning of result.warnings) {
          await addMigrationWarning(cleoDir, warning);
          logger.warn('import', 'warning', warning);
        }

        // Step 7: Close db connection so config update doesn't conflict
        resetDbState();

        // Step 8: Validate migration result before committing
        if (result.success) {
          // Verify the new DB has reasonable data
          const totalImported = result.tasksImported + result.archivedImported;
          if (totalImported === 0 && existsSync(dbBackupPath)) {
            // Migration "succeeded" but imported nothing — likely a bug.
            // Restore from backup to prevent silent data loss.
            copyFileSync(dbBackupPath, dbPath);
            if (configBackup) {
              writeFileSync(configPath, configBackup);
            }
            actions.push({
              action: 'storage_migration',
              status: 'error',
              details: 'Migration imported 0 tasks despite existing data. Restored from backup.',
              fix: 'Run `cleo upgrade --dry-run` to diagnose, then retry.',
            });
            errors.push('Migration imported 0 tasks — restored from backup to prevent data loss');
          } else {
            // Migration successful with data — update config to sqlite
            let config: Record<string, unknown> = {};
            if (existsSync(configPath)) {
              try {
                config = JSON.parse(readFileSync(configPath, 'utf-8'));
              } catch {
                // Start fresh config
              }
            }
            if (!config.storage || typeof config.storage !== 'object') {
              config.storage = {};
            }
            (config.storage as Record<string, unknown>).engine = 'sqlite';
            writeFileSync(configPath, JSON.stringify(config, null, 2));

            actions.push({
              action: 'storage_migration',
              status: 'applied',
              details:
                `Migrated to SQLite: ${result.tasksImported} tasks, ` +
                `${result.archivedImported} archived, ${result.sessionsImported} sessions`,
            });
            storageMigrationResult = {
              migrated: true,
              tasksImported: result.tasksImported,
              archivedImported: result.archivedImported,
              sessionsImported: result.sessionsImported,
              warnings: result.warnings,
            };

            // Mark migration as complete
            await updateMigrationPhase(cleoDir, 'complete');
            await completeMigration(cleoDir);
            logger.info('complete', 'finish', 'Migration completed successfully');
          }
        } else {
          // Migration had errors — restore DB and config from backup
          if (existsSync(dbBackupPath)) {
            copyFileSync(dbBackupPath, dbPath);
          }
          if (configBackup) {
            writeFileSync(configPath, configBackup);
          }

          // Mark migration as failed
          await updateMigrationPhase(cleoDir, 'failed');
          for (const error of result.errors) {
            await addMigrationWarning(cleoDir, `ERROR: ${error}`);
          }
          await failMigration(cleoDir, result.errors.join('; '));
          logger.error('failed', 'error', 'Migration failed', { errors: result.errors });

          actions.push({
            action: 'storage_migration',
            status: 'error',
            details: `Migration failed: ${result.errors.join('; ')}. Restored from backup.`,
            fix: preflight.fix ?? undefined,
          });
          errors.push(...result.errors);
        }
      } catch (err) {
        // Catastrophic error — attempt to restore from backup
        try {
          const cleoDir = getCleoDirAbsolute(options.cwd);
          const dbPath = join(cleoDir, 'tasks.db');
          const safetyDir = join(cleoDir, 'backups', 'safety');
          if (existsSync(safetyDir)) {
            // Find most recent pre-migration backup
            const backups = readdirSync(safetyDir)
              .filter((f) => f.startsWith('tasks.db.pre-migration.'))
              .sort()
              .reverse();
            if (backups.length > 0 && !existsSync(dbPath)) {
              copyFileSync(join(safetyDir, backups[0]), dbPath);
            }
          }
        } catch {
          // Best-effort recovery — don't mask original error
        }
        actions.push({
          action: 'storage_migration',
          status: 'error',
          details: `Migration error: ${String(err)}`,
          fix: preflight.fix ?? undefined,
        });
        errors.push(String(err));
      } finally {
        // Always release the migration lock
        if (migrationLock) {
          try {
            await migrationLock();
          } catch {
            // Best-effort lock release
          }
        }
      }
    } else {
      // autoMigrate=false: just report
      actions.push({
        action: 'storage_migration',
        status: 'skipped',
        details: preflight.summary,
        fix: preflight.fix ?? undefined,
      });
    }
  } else {
    actions.push({
      action: 'storage_preflight',
      status: 'skipped',
      details: preflight.summary,
      reason: dbExists
        ? 'SQLite DB exists and is accessible — no migration needed. Use --diagnose for column/migration validation.'
        : 'No legacy JSON data found and no DB exists — nothing to migrate.',
    });
  }

  // ── Step 2: SQLite structural repairs ────────────────────────────
  // Direct Drizzle SQL updates — no TaskFile loading required.
  if (existsSync(dbPath)) {
    try {
      const { runAllRepairs } = await import('./repair.js');
      const repairActions = await runAllRepairs(options.cwd, isDryRun);
      for (const ra of repairActions) {
        actions.push({ ...ra, status: ra.status as UpgradeAction['status'] });
      }
    } catch {
      // DB may not exist yet. Not an error.
    }
  }

  // ── Step 2a: Sequence state migration (.sequence/.sequence.json -> SQLite) ──
  if (existsSync(dbPath)) {
    const legacySequenceFiles = ['.sequence', '.sequence.json'].filter((f) =>
      existsSync(join(cleoDir, f)),
    );

    if (legacySequenceFiles.length > 0) {
      if (isDryRun) {
        actions.push({
          action: 'sequence_migration',
          status: 'preview',
          details: `Would migrate legacy sequence file(s) to SQLite metadata: ${legacySequenceFiles.join(', ')}`,
        });
      } else {
        try {
          const { showSequence } = await import('./sequence/index.js');
          const sequence = await showSequence(options.cwd);
          actions.push({
            action: 'sequence_migration',
            status: 'applied',
            details: `Migrated legacy sequence state to SQLite (counter=${String(sequence.counter ?? 0)}).`,
          });
        } catch (err) {
          actions.push({
            action: 'sequence_migration',
            status: 'error',
            details: `Failed to migrate sequence state: ${String(err)}`,
          });
        }
      }
    }
  }

  // ── Step 2b: Stale JSON file cleanup (post-migration) ────────────
  // If tasks.db exists and there are stale legacy files, safely backup and delete them
  // so they don't trigger false positives or cause confusion.
  if (needsCleanup) {
    const staleJsonFiles = [
      'todo.json',
      'sessions.json',
      'todo-archive.json',
      '.sequence',
      '.sequence.json',
    ];
    const foundStale = staleJsonFiles.filter((f) => existsSync(join(cleoDir, f)));

    if (foundStale.length > 0) {
      if (isDryRun) {
        actions.push({
          action: 'stale_json_cleanup',
          status: 'preview',
          details: `Would backup and delete ${foundStale.length} legacy JSON file(s): ${foundStale.join(', ')}`,
        });
      } else {
        try {
          // Backup stale files first
          const backupDir = join(cleoDir, '.backups', `legacy-json-${Date.now()}`);
          mkdirSync(backupDir, { recursive: true });
          for (const f of foundStale) {
            const src = join(cleoDir, f);
            copyFileSync(src, join(backupDir, f));
          }

          // Delete the originals
          const { unlinkSync } = await import('node:fs');
          for (const f of foundStale) {
            unlinkSync(join(cleoDir, f));
          }

          actions.push({
            action: 'stale_json_cleanup',
            status: 'applied',
            details: `Deleted ${foundStale.length} legacy JSON file(s) (backed up to ${backupDir})`,
          });
        } catch (err) {
          actions.push({
            action: 'stale_json_cleanup',
            status: 'error',
            details: `Failed to clean up legacy JSON files: ${String(err)}`,
          });
        }
      }
    }
  }

  // ── Step 3: Global ~/.cleo check ──────────────────────────────────
  if (options.includeGlobal) {
    try {
      const globalDir = getCleoHome();
      const globalPreflight = checkStorageMigration(join(globalDir, '..'));
      if (globalPreflight.migrationNeeded) {
        actions.push({
          action: 'global_storage_check',
          status: isDryRun ? 'preview' : 'skipped',
          details: `Global (~/.cleo): ${globalPreflight.summary}`,
          fix: globalPreflight.fix ?? undefined,
        });
      } else {
        actions.push({
          action: 'global_storage_check',
          status: 'skipped',
          details: `Global (~/.cleo): ${globalPreflight.summary}`,
        });
      }
    } catch {
      // Global check is best-effort
    }
  }

  // ── Step 4: Gitignore integrity repair ───────────────────────────
  try {
    const projectRoot = getProjectRoot(options.cwd);
    if (isDryRun) {
      // Check current state for dry-run reporting
      const gitignorePath = join(cleoDir, '.gitignore');
      if (!existsSync(gitignorePath)) {
        actions.push({
          action: 'gitignore_integrity',
          status: 'preview',
          details: 'Would create .cleo/.gitignore from template',
        });
      } else {
        actions.push({
          action: 'gitignore_integrity',
          status: 'preview',
          details: 'Would verify .cleo/.gitignore matches template',
        });
      }
    } else {
      const gitignoreResult = await ensureGitignore(projectRoot);
      actions.push({
        action: 'gitignore_integrity',
        status: gitignoreResult.action === 'skipped' ? 'skipped' : 'applied',
        details: gitignoreResult.details ?? gitignoreResult.action,
      });
    }
  } catch {
    // Gitignore repair is best-effort
  }

  // ── Step 5: Agent-outputs migration (delegated to migration utility)
  try {
    const projectRoot = getProjectRoot(options.cwd);
    const detection = detectLegacyAgentOutputs(projectRoot, cleoDir);

    if (!detection.hasLegacy) {
      actions.push({
        action: 'agent_outputs_migration',
        status: 'skipped',
        details: 'No legacy output directories found',
      });
    } else if (isDryRun) {
      actions.push({
        action: 'agent_outputs_migration',
        status: 'preview',
        details: `Would migrate ${detection.legacyPaths.join(' + ')} → .cleo/agent-outputs/${detection.hasCanonical ? ' (merging with existing)' : ''}`,
      });
    } else {
      const result = migrateAgentOutputs(projectRoot, cleoDir);
      actions.push({
        action: 'agent_outputs_migration',
        status: result.migrated ? 'applied' : 'skipped',
        details: result.summary,
      });
    }
  } catch {
    // Agent outputs migration is best-effort
  }

  // ── Step 6: Project context re-detection ────────────────────────
  try {
    const projectRootForContext = getProjectRoot(options.cwd);
    if (isDryRun) {
      const contextPath = join(cleoDir, 'project-context.json');
      if (!existsSync(contextPath)) {
        actions.push({
          action: 'project_context_detection',
          status: 'preview',
          details: 'Would detect and create project-context.json',
        });
      } else {
        try {
          const context = JSON.parse(readFileSync(contextPath, 'utf-8'));
          if (context.detectedAt) {
            const daysSince =
              (Date.now() - new Date(context.detectedAt).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSince > 30) {
              actions.push({
                action: 'project_context_detection',
                status: 'preview',
                details: `Would refresh project-context.json (${Math.round(daysSince)} days old)`,
              });
            } else {
              actions.push({
                action: 'project_context_detection',
                status: 'skipped',
                details: 'project-context.json is up to date',
              });
            }
          }
        } catch {
          actions.push({
            action: 'project_context_detection',
            status: 'preview',
            details: 'Would regenerate project-context.json (unreadable)',
          });
        }
      }
    } else {
      const contextResult = await ensureProjectContext(projectRootForContext, {
        staleDays: options.forceDetect ? 0 : 30,
      });
      actions.push({
        action: 'project_context_detection',
        status: contextResult.action === 'skipped' ? 'skipped' : 'applied',
        details: contextResult.details ?? contextResult.action,
      });
    }
  } catch {
    // Project context detection is best-effort
  }

  // ── Step 7: Refresh project-scope injection ────────────────────
  // Strip legacy CLEO blocks and update CAAMP blocks.
  if (!isDryRun) {
    try {
      const projectRootForInjection = getProjectRoot(options.cwd);
      const injectionResult = await ensureInjection(projectRootForInjection);
      actions.push({
        action: 'injection_refresh',
        status: injectionResult.action === 'skipped' ? 'skipped' : 'applied',
        details: injectionResult.details ?? 'Project docs refreshed',
      });
    } catch {
      // Injection refresh is best-effort
    }
  } else {
    actions.push({
      action: 'injection_refresh',
      status: 'preview',
      details: 'Would refresh project injection (strip legacy CLEO blocks, update CAAMP blocks)',
    });
  }

  // ── Step 8: Structural maintenance ──────────────────────────────
  if (!isDryRun) {
    const projectRootForMaint = getProjectRoot(options.cwd);

    // Create missing .cleo subdirs
    try {
      const structResult = await ensureCleoStructure(projectRootForMaint);
      if (structResult.action !== 'skipped') {
        actions.push({
          action: 'ensure_structure',
          status: 'applied',
          details: structResult.details ?? 'Created missing directories',
        });
      }
    } catch {
      /* best-effort */
    }

    // Ensure .cleo/config.json exists and matches current template semantics
    try {
      const configResult = await ensureConfig(projectRootForMaint);
      if (configResult.action !== 'skipped') {
        actions.push({
          action: 'config_file',
          status: 'applied',
          details: configResult.details ?? 'Created or updated config.json',
        });
      }
    } catch {
      /* best-effort */
    }

    // Install/update git hooks
    try {
      const hooksResult = await ensureGitHooks(projectRootForMaint);
      if (hooksResult.action !== 'skipped') {
        actions.push({
          action: 'git_hooks',
          status: 'applied',
          details: hooksResult.details ?? 'Installed git hooks',
        });
      }
    } catch {
      /* best-effort */
    }

    // Create project-info.json if missing
    try {
      const infoResult = await ensureProjectInfo(projectRootForMaint);
      if (infoResult.action !== 'skipped') {
        actions.push({
          action: 'project_info',
          status: 'applied',
          details: infoResult.details ?? 'Created project-info.json',
        });
      }
    } catch {
      /* best-effort */
    }

    // Install global schemas
    try {
      const schemasResult = ensureGlobalSchemas();
      actions.push({
        action: 'global_schemas',
        status: 'applied',
        details: `Installed ${schemasResult.installed} schemas (${schemasResult.updated} updated)`,
      });
    } catch {
      /* best-effort */
    }

    // Clean deprecated project schemas
    try {
      const cleanResult = await cleanProjectSchemas(projectRootForMaint);
      if (cleanResult.cleaned) {
        actions.push({
          action: 'clean_project_schemas',
          status: 'applied',
          details: 'Backed up and removed deprecated .cleo/schemas/',
        });
      }
    } catch {
      /* best-effort */
    }

    // Initialize .cleo/.git checkpoint repo
    try {
      const gitRepoResult = await ensureCleoGitRepo(projectRootForMaint);
      if (gitRepoResult.action !== 'skipped') {
        actions.push({
          action: 'cleo_git_repo',
          status: 'applied',
          details: gitRepoResult.details ?? 'Created .cleo/.git checkpoint repository',
        });
      }
    } catch {
      /* best-effort */
    }

    // Initialize SQLite database for fresh projects
    try {
      const dbResult = await ensureSqliteDb(projectRootForMaint);
      if (dbResult.action !== 'skipped') {
        actions.push({
          action: 'ensure_sqlite_db',
          status: 'applied',
          details: dbResult.details ?? 'SQLite database initialized',
        });
      }
    } catch {
      /* best-effort */
    }

    // Initialize brain.db for BRAIN memory system
    try {
      const { ensureBrainDb } = await import('./scaffold.js');
      const brainResult = await ensureBrainDb(projectRootForMaint);
      if (brainResult.action !== 'skipped') {
        actions.push({
          action: 'ensure_brain_db',
          status: 'applied',
          details: brainResult.details ?? 'brain.db initialized',
        });
      }
    } catch {
      /* best-effort */
    }

    // Initialize/upgrade signaldock.db for local agent messaging (T224)
    try {
      const { ensureSignaldockDb } = await import('./store/signaldock-sqlite.js');
      const sdResult = await ensureSignaldockDb(projectRootForMaint);
      actions.push({
        action: 'ensure_signaldock_db',
        status: 'applied',
        details:
          sdResult.action === 'created'
            ? 'signaldock.db created with full schema'
            : 'signaldock.db schema verified',
      });
    } catch {
      /* best-effort — signaldock.db will be created on first agent operation */
    }

    // Regenerate memory-bridge.md
    try {
      const { writeMemoryBridge } = await import('./memory/memory-bridge.js');
      const bridgeResult = await writeMemoryBridge(projectRootForMaint);
      if (bridgeResult.written) {
        actions.push({
          action: 'memory_bridge',
          status: 'applied',
          details: 'memory-bridge.md regenerated',
        });
      }
    } catch {
      /* best-effort */
    }

    // Remove .cleo/ from root .gitignore if present
    try {
      const rootGitignoreResult = await removeCleoFromRootGitignore(projectRootForMaint);
      if (rootGitignoreResult.removed) {
        actions.push({
          action: 'root_gitignore_cleanup',
          status: 'applied',
          details: '.cleo/ removed from root .gitignore',
        });
      }
    } catch {
      /* best-effort */
    }

    // Install cleo-subagent agent definition
    try {
      const agentCreated: string[] = [];
      const agentWarnings: string[] = [];
      await initAgentDefinition(agentCreated, agentWarnings);
      if (agentCreated.length > 0) {
        actions.push({
          action: 'agent_definition',
          status: 'applied',
          details: agentCreated.join(', '),
        });
      }
    } catch {
      /* best-effort */
    }

    // (Step skipped — CLI dispatch only)

    // Install core skills
    try {
      const skillsCreated: string[] = [];
      const skillsWarnings: string[] = [];
      await initCoreSkills(skillsCreated, skillsWarnings);
      if (skillsCreated.length > 0) {
        actions.push({
          action: 'core_skills',
          status: 'applied',
          details: skillsCreated.join(', '),
        });
      }
    } catch {
      /* best-effort */
    }

    // Register with NEXUS
    try {
      const nexusCreated: string[] = [];
      const nexusWarnings: string[] = [];
      await initNexusRegistration(projectRootForMaint, nexusCreated, nexusWarnings);
      if (nexusCreated.length > 0) {
        actions.push({
          action: 'nexus_registration',
          status: 'applied',
          details: nexusCreated.join(', '),
        });
      }
    } catch {
      /* best-effort */
    }

    // Run codebase mapping if requested (delegates to core mapCodebase)
    if (options.mapCodebase) {
      try {
        const { mapCodebase } = await import('./codebase-map/index.js');
        const mapResult = await mapCodebase(projectRootForMaint, { storeToBrain: true });
        actions.push({
          action: 'codebase_map',
          status: 'applied',
          details: `Analyzed: ${mapResult.stack?.languages?.length ?? 0} languages, ${mapResult.concerns?.todos?.length ?? 0} TODOs found`,
        });
      } catch (err) {
        actions.push({
          action: 'codebase_map',
          status: 'error',
          details: `Codebase mapping failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Update project name if requested (delegates to core updateProjectName)
    if (options.projectName) {
      try {
        const { updateProjectName } = await import('./project-info.js');
        await updateProjectName(projectRootForMaint, options.projectName);
        actions.push({
          action: 'project_name_update',
          status: 'applied',
          details: `Project name set to "${options.projectName}"`,
        });
      } catch {
        /* best-effort */
      }
    }

    // GitHub issue/PR templates — install missing ones, warn if absent
    try {
      const { existsSync: fsExistsSync } = await import('node:fs');
      const { join: pathJoin } = await import('node:path');
      const hasGit = fsExistsSync(pathJoin(projectRootForMaint, '.git'));
      const hasGitHubTemplates = fsExistsSync(
        pathJoin(projectRootForMaint, '.github', 'ISSUE_TEMPLATE'),
      );

      if (hasGit && !hasGitHubTemplates) {
        const ghCreated: string[] = [];
        const ghSkipped: string[] = [];
        await installGitHubTemplates(projectRootForMaint, ghCreated, ghSkipped);
        if (ghCreated.length > 0) {
          actions.push({
            action: 'github_templates',
            status: 'applied',
            details: `Installed ${ghCreated.length} GitHub template(s): ${ghCreated.join(', ')}`,
          });
        }
      }
    } catch {
      /* best-effort */
    }
  } else {
    // Dry-run reporting for new steps
    const { existsSync: fsExistsSync } = await import('node:fs');
    const { join: pathJoin } = await import('node:path');
    const hasGit = fsExistsSync(pathJoin(getProjectRoot(options.cwd), '.git'));
    const hasGitHubTemplates = fsExistsSync(
      pathJoin(getProjectRoot(options.cwd), '.github', 'ISSUE_TEMPLATE'),
    );
    if (hasGit && !hasGitHubTemplates) {
      actions.push({
        action: 'github_templates',
        status: 'preview',
        details:
          'Would install GitHub issue/PR templates to .github/ — run `cleo init` or `cleo upgrade --fix` to apply',
        fix: 'cleo upgrade',
      });
    }

    actions.push({
      action: 'structural_maintenance',
      status: 'preview',
      details:
        'Would create missing directories, ensure config, install hooks, schemas, project-info, agent definition, skills, and NEXUS registration',
    });
  }

  const appliedActions = actions.filter((a) => a.status === 'applied');
  const skippedActions = actions.filter((a) => a.status === 'skipped');
  const errorActions = actions.filter((a) => a.status === 'error');
  const hasErrors = errors.length > 0 || errorActions.length > 0;
  const upToDate = !actions.some((a) => a.status === 'applied' || a.status === 'preview');

  // Build summary of what was checked
  const summaryWarnings: string[] = [];
  for (const a of actions) {
    if (a.status === 'skipped' && a.reason) {
      summaryWarnings.push(`${a.action}: ${a.reason}`);
    }
  }

  return {
    success: !hasErrors,
    upToDate,
    dryRun: isDryRun,
    actions,
    applied: appliedActions.length,
    errors,
    summary: {
      checked: actions.length,
      applied: appliedActions.length,
      skipped: skippedActions.length,
      errors: errorActions.length,
      warnings: summaryWarnings,
    },
    storageMigration: storageMigrationResult,
  };
}

/**
 * Deep diagnostic inspection of schema and migration state.
 *
 * Unlike bare `cleo upgrade` which skips checks that "look OK",
 * --diagnose validates:
 * - tasks.db: all required columns present via PRAGMA table_info
 * - tasks.db: migration journal entries match local migration files
 * - brain.db: migration journal entries match local migration files
 * - brain.db: expected tables exist
 * - Stale/orphaned journal entries detected and reported
 *
 * Read-only: does not modify any data.
 *
 * @task T131
 */
export async function diagnoseUpgrade(options: { cwd?: string } = {}): Promise<DiagnoseResult> {
  const findings: DiagnoseFinding[] = [];
  const cleoDir = getCleoDirAbsolute(options.cwd);
  const dbPath = join(cleoDir, 'tasks.db');
  const brainDbPath = join(cleoDir, 'brain.db');

  // ── tasks.db column validation ──
  if (existsSync(dbPath)) {
    try {
      const { getNativeDb, getDb } = await import('./store/sqlite.js');
      const projectRoot = getProjectRoot(options.cwd);
      await getDb(projectRoot);
      const nativeDb = getNativeDb();

      if (nativeDb) {
        // Check required columns
        const columns = nativeDb.prepare('PRAGMA table_info(tasks)').all() as Array<{
          name: string;
        }>;
        const existingCols = new Set(columns.map((c: { name: string }) => c.name));

        const requiredColumns = ['pipeline_stage'];
        const missing = requiredColumns.filter((c) => !existingCols.has(c));

        if (missing.length > 0) {
          findings.push({
            check: 'tasks.db.columns',
            status: 'error',
            details: `Missing required columns: ${missing.join(', ')}`,
            fix: 'Run: cleo upgrade',
          });
        } else {
          findings.push({
            check: 'tasks.db.columns',
            status: 'ok',
            details: `All ${requiredColumns.length} required column(s) present (${columns.length} total)`,
          });
        }

        // Check migration journal
        const hasMigTable = nativeDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
          )
          .get() as { name?: string } | undefined;

        if (hasMigTable?.name) {
          const journalEntries = nativeDb
            .prepare('SELECT * FROM __drizzle_migrations')
            .all() as Array<{
            id: number | null;
            hash: string;
            created_at: number | null;
          }>;

          const nullIdEntries = journalEntries.filter((e) => e.id === null || e.id === undefined);
          const staleEntries = journalEntries.filter(
            (e) => e.created_at === null || e.created_at === undefined,
          );

          if (nullIdEntries.length > 0) {
            findings.push({
              check: 'tasks.db.journal',
              status: 'warning',
              details: `${nullIdEntries.length} journal entry/entries with null IDs (orphaned from previous CLEO version)`,
              fix: 'Run: cleo upgrade (will reconcile automatically)',
            });
          } else if (staleEntries.length > 0) {
            findings.push({
              check: 'tasks.db.journal',
              status: 'warning',
              details: `${staleEntries.length} journal entry/entries with null timestamps`,
              fix: 'Run: cleo upgrade (will reconcile automatically)',
            });
          } else {
            findings.push({
              check: 'tasks.db.journal',
              status: 'ok',
              details: `${journalEntries.length} migration(s) in journal, all valid`,
            });
          }
        } else {
          findings.push({
            check: 'tasks.db.journal',
            status: 'warning',
            details: 'No migration journal table found — migrations may not have been tracked',
            fix: 'Run: cleo upgrade',
          });
        }

        // Integrity check
        const integrity = nativeDb.prepare('PRAGMA integrity_check').get() as
          | Record<string, unknown>
          | undefined;
        const ok = integrity?.integrity_check === 'ok';
        findings.push({
          check: 'tasks.db.integrity',
          status: ok ? 'ok' : 'error',
          details: ok ? 'SQLite integrity check passed' : 'SQLite integrity check failed',
          ...(!ok ? { fix: 'Restore from backup: cleo admin backup --action restore' } : {}),
        });
      } else {
        findings.push({
          check: 'tasks.db.connection',
          status: 'error',
          details: 'Could not obtain native DB handle',
        });
      }
    } catch (err) {
      findings.push({
        check: 'tasks.db.connection',
        status: 'error',
        details: `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    findings.push({
      check: 'tasks.db',
      status: 'error',
      details: 'tasks.db not found',
      fix: 'Run: cleo init',
    });
  }

  // ── brain.db validation ──
  if (existsSync(brainDbPath)) {
    try {
      const { getBrainNativeDb, getBrainDb } = await import('./store/brain-sqlite.js');
      await getBrainDb(options.cwd);
      const nativeDb = getBrainNativeDb();

      if (nativeDb) {
        // Check expected tables
        const tables = nativeDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '__drizzle%' AND name NOT LIKE 'sqlite_%'",
          )
          .all() as Array<{ name: string }>;
        const tableNames = new Set(tables.map((t: { name: string }) => t.name));

        const expectedTables = [
          'brain_observations',
          'brain_decisions',
          'brain_patterns',
          'brain_learnings',
        ];
        const missingTables = expectedTables.filter((t) => !tableNames.has(t));

        if (missingTables.length > 0) {
          findings.push({
            check: 'brain.db.tables',
            status: 'error',
            details: `Missing tables: ${missingTables.join(', ')}`,
            fix: 'Run: cleo upgrade',
          });
        } else {
          findings.push({
            check: 'brain.db.tables',
            status: 'ok',
            details: `All ${expectedTables.length} expected tables present (${tables.length} total)`,
          });
        }

        // Check migration journal
        const hasMigTable = nativeDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
          )
          .get() as { name?: string } | undefined;

        if (hasMigTable?.name) {
          const journalEntries = nativeDb
            .prepare('SELECT * FROM __drizzle_migrations')
            .all() as Array<{
            id: number | null;
            hash: string;
            created_at: number | null;
          }>;

          const nullIdEntries = journalEntries.filter((e) => e.id === null || e.id === undefined);

          if (nullIdEntries.length > 0) {
            findings.push({
              check: 'brain.db.journal',
              status: 'warning',
              details: `${nullIdEntries.length} journal entry/entries with null IDs (orphaned from previous CLEO version)`,
              fix: 'Run: cleo upgrade (will reconcile automatically)',
            });
          } else {
            findings.push({
              check: 'brain.db.journal',
              status: 'ok',
              details: `${journalEntries.length} migration(s) in journal, all valid`,
            });
          }
        } else {
          findings.push({
            check: 'brain.db.journal',
            status: 'warning',
            details: 'No migration journal table found',
            fix: 'Run: cleo upgrade',
          });
        }
      } else {
        findings.push({
          check: 'brain.db.connection',
          status: 'error',
          details: 'Could not obtain native DB handle',
        });
      }
    } catch (err) {
      findings.push({
        check: 'brain.db.connection',
        status: 'error',
        details: `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    findings.push({
      check: 'brain.db',
      status: 'warning',
      details: 'brain.db not found (will be created on first use)',
    });
  }

  const okCount = findings.filter((f) => f.status === 'ok').length;
  const warnCount = findings.filter((f) => f.status === 'warning').length;
  const errCount = findings.filter((f) => f.status === 'error').length;

  return {
    success: errCount === 0,
    findings,
    summary: { ok: okCount, warnings: warnCount, errors: errCount },
  };
}
