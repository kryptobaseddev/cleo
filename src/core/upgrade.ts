/**
 * Core upgrade logic - unified project maintenance.
 *
 * Handles:
 *   1. Storage engine migration (JSON → SQLite)
 *   2. Schema version upgrades
 *   3. Structural repairs (checksums, missing fields)
 *   4. Global ~/.cleo data migration
 *
 * Both CLI and MCP delegate here (shared-core pattern).
 *
 * @task T4699
 * @epic T4454
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDirAbsolute, getCleoHome, getProjectRoot } from './paths.js';
import { checkStorageMigration, type PreflightResult } from './migration/preflight.js';
import { detectLegacyAgentOutputs, migrateAgentOutputs } from './migration/agent-outputs.js';
import { MigrationLogger } from './migration/logger.js';
import { forceCheckpointBeforeOperation, acquireLock, type ReleaseFn } from '../store/index.js';
import {
  createMigrationState,
  updateMigrationPhase,
  updateMigrationProgress,
  addMigrationWarning,
  completeMigration,
  failMigration,
} from './migration/state.js';

/** A single upgrade action with status. */
export interface UpgradeAction {
  action: string;
  status: 'applied' | 'skipped' | 'preview' | 'error';
  details: string;
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
  /** Storage migration sub-result (if migration was triggered). */
  storageMigration?: {
    migrated: boolean;
    tasksImported: number;
    archivedImported: number;
    sessionsImported: number;
    warnings: string[];
  };
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
 * @param options.cwd  Project directory override
 */
export async function runUpgrade(options: {
  dryRun?: boolean;
  includeGlobal?: boolean;
  autoMigrate?: boolean;
  cwd?: string;
} = {}): Promise<UpgradeResult> {
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
    return { success: false, upToDate: false, dryRun: isDryRun, actions, applied: 0, errors: [String(err)] };
  }

  // Determine what actions are actually needed
  const cleoDir = getCleoDirAbsolute(options.cwd);
  const dbPath = join(cleoDir, 'tasks.db');
  const dbExists = existsSync(dbPath);
  
  // Check if JSON files have actual data (not just empty files)
  const todoPath = join(cleoDir, 'todo.json');
  const hasJsonData = existsSync(todoPath) && (() => {
    try {
      const data = JSON.parse(readFileSync(todoPath, 'utf-8'));
      return (data.tasks?.length ?? 0) > 0;
    } catch {
      return false;
    }
  })();
  
  // Migration needed only if: no DB exists AND JSON has data
  const needsMigration = !dbExists && hasJsonData;
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
        const logger = new MigrationLogger(cleoDir);
        await createMigrationState(cleoDir, {
          todoJson: { path: join(cleoDir, 'todo.json'), checksum: '' },
          sessionsJson: { path: join(cleoDir, 'sessions.json'), checksum: '' },
          archiveJson: { path: join(cleoDir, 'todo-archive.json'), checksum: '' },
        });
        await updateMigrationPhase(cleoDir, 'backup');
        logger.info('init', 'start', 'Migration state initialized');
        const dbBackupPath = join(cleoDir, 'backups', 'safety', `tasks.db.pre-migration.${Date.now()}`);
        const dbTempPath = join(cleoDir, 'tasks.db.migrating');

        // Step 1: Backup existing tasks.db if it exists (NEVER delete without backup)
        if (existsSync(dbPath)) {
          const backupDir = join(cleoDir, 'backups', 'safety');
          if (!existsSync(backupDir)) {
            mkdirSync(backupDir, { recursive: true });
          }
          copyFileSync(dbPath, dbBackupPath);

          // Verify backup is valid before proceeding
          const origStat = await import('node:fs').then(fs => fs.statSync(dbPath));
          const backupStat = await import('node:fs').then(fs => fs.statSync(dbBackupPath));
          if (backupStat.size !== origStat.size) {
            throw new Error(
              `Backup verification failed: original=${origStat.size} bytes, backup=${backupStat.size} bytes. ` +
              `Aborting migration to prevent data loss.`
            );
          }
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
        const { closeDb } = await import('../store/sqlite.js');
        closeDb();

        // Step 5: Remove existing DB so migration creates a fresh one
        // SAFE: backup verified at Step 1
        if (existsSync(dbPath)) {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(dbPath);
        }

        // Step 6: Run migration (creates new tasks.db from JSON sources)
        await updateMigrationPhase(cleoDir, 'import');
        const { migrateJsonToSqlite } = await import('../store/migration-sqlite.js');
        const result = await migrateJsonToSqlite(options.cwd);

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
        closeDb();

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
              details: `Migrated to SQLite: ${result.tasksImported} tasks, `
                + `${result.archivedImported} archived, ${result.sessionsImported} sessions`,
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
              .filter(f => f.startsWith('tasks.db.pre-migration.'))
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
    });
  }

  // ── Step 2: Schema + structural repairs ──────────────────────────
  // Runs on task data via accessor (SQLite per ADR-006).
  // Also runs if legacy todo.json still exists (pre-migration data).
  if (existsSync(dbPath) || existsSync(todoPath)) {
    try {
      const { getAccessor } = await import('../store/data-accessor.js');
      const { computeChecksum } = await import('../store/json.js');
      const { runAllRepairs } = await import('./repair.js');
      const accessor = await getAccessor(options.cwd);
      const data = await accessor.loadTaskFile();

      // Run all repairs via extracted functions
      const repairActions = runAllRepairs(data, isDryRun);
      for (const ra of repairActions) {
        actions.push({ ...ra, status: ra.status as UpgradeAction['status'] });
      }

      // Check schema version mismatch (not fixable by repair — just report)
      const { getCurrentSchemaVersion } = await import('./repair.js');
      const schemaVersion = data._meta?.schemaVersion;
      const currentVersion = getCurrentSchemaVersion();
      if (schemaVersion && schemaVersion !== currentVersion) {
        actions.push({
          action: 'schema_version_check',
          status: isDryRun ? 'preview' : 'skipped',
          details: `Schema version ${schemaVersion} differs from current ${currentVersion}`,
        });
      } else if (schemaVersion === currentVersion) {
        actions.push({
          action: 'schema_version_check',
          status: 'skipped',
          details: 'Schema version up to date',
        });
      }

      // Save if changes were made
      const appliedRepairs = repairActions.filter((a) => a.status === 'applied');
      if (appliedRepairs.length > 0 && !isDryRun) {
        data._meta.checksum = computeChecksum(data.tasks);
        data.lastUpdated = new Date().toISOString();
        await accessor.saveTaskFile(data);
      }
    } catch {
      // Data load may fail if no store exists yet. Not an error.
    }
  }

  // ── Step 2b: Stale JSON file cleanup (post-migration) ────────────
  // If tasks.db exists and there are stale legacy files, safely backup and delete them
  // so they don't trigger false positives or cause confusion.
  if (needsCleanup) {
    const staleJsonFiles = ['todo.json', 'sessions.json', 'todo-archive.json', 'tasks.json'];
    const foundStale = staleJsonFiles.filter(f => existsSync(join(cleoDir, f)));

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

  // ── Step 2c: Audit log JSONL-to-SQLite migration (T4837) ──────────
  // Migrate existing tasks-log.jsonl entries to the audit_log SQLite table.
  // Runs after tables are created/migrated. Safe to run repeatedly (idempotent via id PK).
  if (existsSync(dbPath) && !isDryRun) {
    try {
      const { getDb } = await import('../store/sqlite.js');
      const auditSchema = await import('../store/schema.js');
      const { count } = await import('drizzle-orm');
      const db = await getDb(options.cwd);

      // Check if audit_log table exists and is empty
      const auditCount = await db
        .select({ count: count() })
        .from(auditSchema.auditLog)
        .get();

      if ((auditCount?.count ?? 0) === 0) {
        // Check for JSONL log files
        const tasksLogPath = join(cleoDir, 'tasks-log.jsonl');
        const todoLogPath = join(cleoDir, 'todo-log.jsonl');
        const logPath = existsSync(tasksLogPath) ? tasksLogPath : existsSync(todoLogPath) ? todoLogPath : null;

        if (logPath) {
          const logContent = readFileSync(logPath, 'utf-8').trim();
          if (logContent) {
            const lines = logContent.split('\n').filter(l => l.trim());
            let imported = 0;

            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                const epoch = Math.floor(Date.now() / 1000);
                const rand = Math.random().toString(36).slice(2, 8);

                await db.insert(auditSchema.auditLog).values({
                  id: (entry.id as string) ?? `log-${epoch}-${rand}`,
                  timestamp: (entry.timestamp as string) ?? new Date().toISOString(),
                  action: (entry.action as string) ?? (entry.operation as string) ?? 'unknown',
                  taskId: (entry.taskId as string) ?? 'unknown',
                  actor: (entry.actor as string) ?? 'system',
                  detailsJson: entry.details ? JSON.stringify(entry.details) : '{}',
                  beforeJson: entry.before ? JSON.stringify(entry.before) : null,
                  afterJson: entry.after ? JSON.stringify(entry.after) : null,
                }).onConflictDoNothing().run();
                imported++;
              } catch {
                // Skip malformed entries
              }
            }

            if (imported > 0) {
              actions.push({
                action: 'audit_log_migration',
                status: 'applied',
                details: `Imported ${imported} audit log entries from ${logPath.split('/').pop()} to SQLite`,
              });
            }
          }
        }
      }
    } catch {
      // Audit log migration is best-effort
    }
  } else if (existsSync(dbPath) && isDryRun) {
    const tasksLogPath = join(cleoDir, 'tasks-log.jsonl');
    const todoLogPath = join(cleoDir, 'todo-log.jsonl');
    if (existsSync(tasksLogPath) || existsSync(todoLogPath)) {
      actions.push({
        action: 'audit_log_migration',
        status: 'preview',
        details: 'Would import JSONL audit log entries to SQLite audit_log table',
      });
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
    const gitignorePath = join(cleoDir, '.gitignore');
    let templateContent: string | null = null;

    // Try loading template
    try {
      const { getGitignoreTemplate } = await import('../cli/commands/init.js');
      templateContent = getGitignoreTemplate();
    } catch {
      // Template loading not available
    }

    if (templateContent) {
      const normalizeContent = (s: string) => s.trim().replace(/\r\n/g, '\n');

      if (!existsSync(gitignorePath)) {
        if (isDryRun) {
          actions.push({
            action: 'gitignore_integrity',
            status: 'preview',
            details: 'Would create .cleo/.gitignore from template',
          });
        } else {
          writeFileSync(gitignorePath, templateContent);
          actions.push({
            action: 'gitignore_integrity',
            status: 'applied',
            details: 'Created .cleo/.gitignore from template',
          });
        }
      } else {
        const installedContent = readFileSync(gitignorePath, 'utf-8');
        if (normalizeContent(installedContent) !== normalizeContent(templateContent)) {
          if (isDryRun) {
            actions.push({
              action: 'gitignore_integrity',
              status: 'preview',
              details: 'Would update .cleo/.gitignore to match template',
            });
          } else {
            writeFileSync(gitignorePath, templateContent);
            actions.push({
              action: 'gitignore_integrity',
              status: 'applied',
              details: 'Updated .cleo/.gitignore to match template',
            });
          }
        } else {
          actions.push({
            action: 'gitignore_integrity',
            status: 'skipped',
            details: '.cleo/.gitignore matches template',
          });
        }
      }
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
    const projectRoot = getProjectRoot(options.cwd);
    const contextPath = join(cleoDir, 'project-context.json');

    if (!existsSync(contextPath)) {
      if (isDryRun) {
        actions.push({
          action: 'project_context_detection',
          status: 'preview',
          details: 'Would detect and create project-context.json',
        });
      } else {
        try {
          const { detectProjectType } = await import('../store/project-detect.js');
          const info = detectProjectType(projectRoot);
          const context = {
            ...info,
            detectedAt: new Date().toISOString(),
          };
          writeFileSync(contextPath, JSON.stringify(context, null, 2));
          actions.push({
            action: 'project_context_detection',
            status: 'applied',
            details: `Detected project type: ${info.type} (${info.testFramework})`,
          });
        } catch (err) {
          actions.push({
            action: 'project_context_detection',
            status: 'error',
            details: `Project detection failed: ${String(err)}`,
          });
        }
      }
    } else {
      // Check if stale (older than 30 days) — auto-refresh if so
      try {
        const context = JSON.parse(readFileSync(contextPath, 'utf-8'));
        if (context.detectedAt) {
          const detectedDate = new Date(context.detectedAt);
          const daysSinceDetection = (Date.now() - detectedDate.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceDetection > 30) {
            if (isDryRun) {
              actions.push({
                action: 'project_context_detection',
                status: 'preview',
                details: `Would refresh project-context.json (${Math.round(daysSinceDetection)} days old)`,
              });
            } else {
              try {
                const { detectProjectType } = await import('../store/project-detect.js');
                const info = detectProjectType(projectRoot);
                const refreshed = {
                  ...info,
                  detectedAt: new Date().toISOString(),
                };
                writeFileSync(contextPath, JSON.stringify(refreshed, null, 2));
                actions.push({
                  action: 'project_context_detection',
                  status: 'applied',
                  details: `Refreshed project-context.json (was ${Math.round(daysSinceDetection)} days old): ${info.type} (${info.testFramework})`,
                });
              } catch (err) {
                actions.push({
                  action: 'project_context_detection',
                  status: 'error',
                  details: `Failed to refresh project-context.json: ${String(err)}`,
                });
              }
            }
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
          status: 'skipped',
          details: 'project-context.json exists',
        });
      }
    }
  } catch {
    // Project context detection is best-effort
  }

  const applied = actions.filter((a) => a.status === 'applied');
  const hasErrors = errors.length > 0 || actions.some((a) => a.status === 'error');
  const upToDate = !actions.some((a) => a.status === 'applied' || a.status === 'preview');

  return {
    success: !hasErrors,
    upToDate,
    dryRun: isDryRun,
    actions,
    applied: applied.length,
    errors,
    storageMigration: storageMigrationResult,
  };
}
