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

  if (preflight.migrationNeeded) {
    if (isDryRun) {
      actions.push({
        action: 'storage_migration',
        status: 'preview',
        details: preflight.summary,
        fix: preflight.fix ?? undefined,
      });
    } else if (autoMigrate) {
      // Auto-migrate: backup first, then migrate
      try {
        const cleoDir = getCleoDirAbsolute(options.cwd);
        const dbPath = join(cleoDir, 'tasks.db');

        // If DB exists, remove it so migration starts fresh
        if (existsSync(dbPath)) {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(dbPath);
        }

        // Temporarily set engine to json so migrate-storage doesn't short-circuit
        const configPath = join(cleoDir, 'config.json');
        let configBackup: string | null = null;
        if (existsSync(configPath)) {
          const { readFileSync } = await import('node:fs');
          configBackup = readFileSync(configPath, 'utf-8');
          const config = JSON.parse(configBackup);
          if (config?.storage?.engine === 'sqlite') {
            config.storage.engine = 'json';
            const { writeFileSync } = await import('node:fs');
            writeFileSync(configPath, JSON.stringify(config, null, 2));
          }
        }

        // Run migration
        const { migrateJsonToSqlite } = await import('../store/migration-sqlite.js');
        const result = await migrateJsonToSqlite(options.cwd);

        // Close db connection so config update doesn't conflict
        const { closeDb } = await import('../store/sqlite.js');
        closeDb();

        // Update config to sqlite
        const { readFileSync: readFs, writeFileSync: writeFs } = await import('node:fs');
        let config: Record<string, unknown> = {};
        if (existsSync(configPath)) {
          try {
            config = JSON.parse(readFs(configPath, 'utf-8'));
          } catch {
            // Start fresh
          }
        }
        if (!config.storage || typeof config.storage !== 'object') {
          config.storage = {};
        }
        (config.storage as Record<string, unknown>).engine = 'sqlite';
        writeFs(configPath, JSON.stringify(config, null, 2));

        if (result.success) {
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
        } else {
          // Migration had errors - restore config if we backed it up
          if (configBackup) {
            writeFs(configPath, configBackup);
          }
          actions.push({
            action: 'storage_migration',
            status: 'error',
            details: `Migration failed: ${result.errors.join('; ')}`,
            fix: preflight.fix ?? undefined,
          });
          errors.push(...result.errors);
        }
      } catch (err) {
        actions.push({
          action: 'storage_migration',
          status: 'error',
          details: `Migration error: ${String(err)}`,
          fix: preflight.fix ?? undefined,
        });
        errors.push(String(err));
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

  // ── Step 2: Schema + structural repairs (JSON-based) ──────────────
  // Only run if data is still in JSON format (not just migrated to SQLite)
  const cleoDir = getCleoDirAbsolute(options.cwd);
  const todoPath = join(cleoDir, 'todo.json');
  if (existsSync(todoPath)) {
    try {
      const { getAccessor } = await import('../store/data-accessor.js');
      const { computeChecksum } = await import('../store/json.js');
      const accessor = await getAccessor(options.cwd);
      const data = await accessor.loadTodoFile();

      // 2a. Schema version check
      const schemaVersion = data._meta?.schemaVersion;
      const currentVersion = '2.10.0';
      if (!schemaVersion) {
        if (isDryRun) {
          actions.push({
            action: 'add_schema_version',
            status: 'preview',
            details: `Would set _meta.schemaVersion to ${currentVersion}`,
          });
        } else {
          data._meta = data._meta ?? {} as typeof data._meta;
          data._meta.schemaVersion = currentVersion;
          actions.push({
            action: 'add_schema_version',
            status: 'applied',
            details: `Set _meta.schemaVersion to ${currentVersion}`,
          });
        }
      } else if (schemaVersion !== currentVersion) {
        actions.push({
          action: 'schema_version_check',
          status: isDryRun ? 'preview' : 'skipped',
          details: `Schema version ${schemaVersion} differs from current ${currentVersion}`,
        });
      } else {
        actions.push({
          action: 'schema_version_check',
          status: 'skipped',
          details: 'Schema version up to date',
        });
      }

      // 2b. Checksum repair
      const storedChecksum = data._meta?.checksum;
      const computedCk = computeChecksum(data.tasks);
      if (storedChecksum !== computedCk) {
        if (isDryRun) {
          actions.push({
            action: 'fix_checksum',
            status: 'preview',
            details: `Would update checksum from ${storedChecksum ?? 'none'} to ${computedCk}`,
          });
        } else {
          data._meta.checksum = computedCk;
          actions.push({
            action: 'fix_checksum',
            status: 'applied',
            details: `Updated checksum to ${computedCk}`,
          });
        }
      }

      // 2c. Fix done tasks missing completedAt
      const doneMissingDate = data.tasks.filter((t) => t.status === 'done' && !t.completedAt);
      if (doneMissingDate.length > 0) {
        if (isDryRun) {
          actions.push({
            action: 'fix_completed_at',
            status: 'preview',
            details: `Would set completedAt for ${doneMissingDate.length} done task(s)`,
          });
        } else {
          const now = new Date().toISOString();
          for (const t of doneMissingDate) {
            t.completedAt = now;
          }
          actions.push({
            action: 'fix_completed_at',
            status: 'applied',
            details: `Set completedAt for ${doneMissingDate.length} done task(s)`,
          });
        }
      }

      // 2d. Fix missing size fields
      const missingSizes = data.tasks.filter((t) => !t.size);
      if (missingSizes.length > 0) {
        if (isDryRun) {
          actions.push({
            action: 'fix_missing_sizes',
            status: 'preview',
            details: `Would set size='medium' for ${missingSizes.length} task(s)`,
          });
        } else {
          for (const t of missingSizes) {
            t.size = 'medium';
          }
          actions.push({
            action: 'fix_missing_sizes',
            status: 'applied',
            details: `Set size='medium' for ${missingSizes.length} task(s)`,
          });
        }
      }

      // Save if changes were made to JSON
      const appliedJson = actions.filter((a) =>
        a.status === 'applied' && !['storage_migration', 'storage_preflight'].includes(a.action),
      );
      if (appliedJson.length > 0 && !isDryRun) {
        data._meta.checksum = computeChecksum(data.tasks);
        data.lastUpdated = new Date().toISOString();
        await accessor.saveTodoFile(data);
      }
    } catch {
      // JSON data may no longer be the primary store (migrated to SQLite).
      // This is expected after migration; not an error.
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

  // ── Step 5: Agent-outputs migration ─────────────────────────────
  try {
    const projectRoot = getProjectRoot(options.cwd);
    const legacyDir = join(projectRoot, 'claudedocs', 'agent-outputs');
    const newDir = join(cleoDir, 'agent-outputs');

    if (existsSync(legacyDir)) {
      if (existsSync(newDir)) {
        // Both exist — warn, do not overwrite
        actions.push({
          action: 'agent_outputs_migration',
          status: 'skipped',
          details: 'Both claudedocs/agent-outputs/ and .cleo/agent-outputs/ exist. Manual cleanup needed.',
        });
      } else {
        if (isDryRun) {
          actions.push({
            action: 'agent_outputs_migration',
            status: 'preview',
            details: 'Would copy claudedocs/agent-outputs/ to .cleo/agent-outputs/',
          });
        } else {
          // Copy all files from old to new
          mkdirSync(newDir, { recursive: true });
          const files = readdirSync(legacyDir);
          for (const file of files) {
            const srcPath = join(legacyDir, file);
            const dstPath = join(newDir, file);
            try {
              copyFileSync(srcPath, dstPath);
            } catch {
              // Skip files that can't be copied (e.g., directories)
              try {
                // If it's a directory, mkdir and copy contents
                const stat = (await import('node:fs')).statSync(srcPath);
                if (stat.isDirectory()) {
                  mkdirSync(dstPath, { recursive: true });
                  const subFiles = readdirSync(srcPath);
                  for (const sf of subFiles) {
                    try { copyFileSync(join(srcPath, sf), join(dstPath, sf)); } catch { /* skip */ }
                  }
                }
              } catch { /* skip */ }
            }
          }

          // Update config if it still points to legacy path
          const configPath = join(cleoDir, 'config.json');
          if (existsSync(configPath)) {
            try {
              const config = JSON.parse(readFileSync(configPath, 'utf-8'));
              const currentDir = config.agentOutputs?.directory ?? config.agentOutputs;
              if (currentDir === 'claudedocs/agent-outputs') {
                if (typeof config.agentOutputs === 'object') {
                  config.agentOutputs.directory = '.cleo/agent-outputs';
                } else {
                  config.agentOutputs = { directory: '.cleo/agent-outputs' };
                }
                writeFileSync(configPath, JSON.stringify(config, null, 2));
              }
            } catch { /* config update is best-effort */ }
          }

          actions.push({
            action: 'agent_outputs_migration',
            status: 'applied',
            details: `Copied ${files.length} items from claudedocs/agent-outputs/ to .cleo/agent-outputs/`,
          });
        }
      }
    } else {
      actions.push({
        action: 'agent_outputs_migration',
        status: 'skipped',
        details: 'No legacy claudedocs/agent-outputs/ directory found',
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
      // Check if stale (older than 30 days)
      try {
        const context = JSON.parse(readFileSync(contextPath, 'utf-8'));
        if (context.detectedAt) {
          const detectedDate = new Date(context.detectedAt);
          const daysSinceDetection = (Date.now() - detectedDate.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceDetection > 30) {
            actions.push({
              action: 'project_context_detection',
              status: 'skipped',
              details: `project-context.json is ${Math.round(daysSinceDetection)} days old. Consider re-running 'cleo init --detect'.`,
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
