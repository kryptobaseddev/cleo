# T090 — Paths Centralization

**Status**: complete  
**Agent**: t090-worker  
**Date**: 2026-04-17

## Summary

Created `packages/cleo/src/cli/paths.ts` as the canonical home for all magic
string path constants in the `@cleocode/cleo` package. Refactored 9 source
files to import from the new module instead of embedding literal strings.

## New File

`packages/cleo/src/cli/paths.ts` — exports 17 constants:

### Directory names
| Constant | Value |
|---|---|
| `CLEO_DIR_NAME` | `.cleo` |
| `CONTEXT_STATES_SUBDIR` | `context-states` |
| `AGENTS_SUBDIR` | `agents` |
| `CANT_AGENTS_SUBDIR` | `cant/agents` |
| `WORKFLOWS_SUBDIR` | `workflows` |
| `METRICS_SUBDIR` | `metrics` |
| `TEMPLATES_SUBDIR` | `templates` |
| `BACKUPS_OPERATIONAL_SUBDIR` | `backups/operational` |
| `RESTORE_IMPORTED_SUBDIR` | `restore-imported` |

### DB filenames
| Constant | Value |
|---|---|
| `TASKS_DB_FILENAME` | `tasks.db` |
| `BRAIN_DB_FILENAME` | `brain.db` |
| `CONDUIT_DB_FILENAME` | `conduit.db` |
| `NEXUS_DB_FILENAME` | `nexus.db` |
| `SIGNALDOCK_DB_FILENAME` | `signaldock.db` |

### JSON / Markdown filenames
| Constant | Value |
|---|---|
| `CONFIG_JSON` | `config.json` |
| `PROJECT_INFO_JSON` | `project-info.json` |
| `PROJECT_CONTEXT_JSON` | `project-context.json` |
| `RESTORE_CONFLICTS_MD` | `restore-conflicts.md` |
| `MIGRATE_MEMORY_HASHES_JSON` | `migrate-memory-hashes.json` |
| `COMPLIANCE_JSONL` | `COMPLIANCE.jsonl` |
| `CLEO_INJECTION_MD` | `CLEO-INJECTION.md` |

### Composite lists
| Constant | Purpose |
|---|---|
| `CLI_PROJECT_BACKUP_FILES` | 6 project-relative paths for backup bundles |
| `CLI_GLOBAL_BACKUP_FILES` | 2 global DB filenames for backup bundles |
| `RESTORE_VALID_JSON_FILENAMES` | `Set<string>` for restore target validation |
| `RESTORE_DEFAULT_FILE` | Default file for `cleo restore backup` |

## Files Refactored

| File | Changes |
|---|---|
| `packages/cleo/src/cli/commands/backup.ts` | `checkForExistingData` array, `resolveDbTarget`, `.cleo/` joins for restore-imported, restore-conflicts.md, targetPath; union type for JSON filename |
| `packages/cleo/src/cli/commands/restore.ts` | `VALID_FILENAMES` set, `.cleo/` joins for reportPath, filePath, archivePath; default file for restore backup |
| `packages/cleo/src/cli/commands/agent.ts` | `.cleo/agents` cantDir, cantPath (×3); `.cleo/cant/agents` targetRoot (×2) |
| `packages/cleo/src/cli/commands/detect-drift.ts` | `.cleo/templates/CLEO-INJECTION.md` (×2) |
| `packages/cleo/src/cli/commands/memory-brain.ts` | `.cleo/migrate-memory-hashes.json` stateFile |
| `packages/cleo/src/dispatch/engines/system-engine.ts` | `join(projectRoot, '.cleo', 'tasks.db')`, `join(projectRoot, '.cleo', 'metrics', 'COMPLIANCE.jsonl')` (×2), `join(projectRoot, '.cleo')` for cleoDir and projectCleoDir |
| `packages/cleo/src/dispatch/lib/config-loader.ts` | `join(root, '.cleo', 'config.json')` |
| `packages/cleo/src/dispatch/domains/admin/smoke-provider.ts` | `join(projectRoot, '.cleo')`, `join(projectCleoDir, 'brain.db')` |
| `packages/cleo/src/dispatch/domains/orchestrate.ts` | `join(projectRoot, '.cleo', 'workflows')` |

## Quality Gates

- biome ci: 1441 files, 0 errors (1 pre-existing symlink warning unrelated to this task)
- tsc build: 0 errors
- pnpm run test: 8548 passed | 10 skipped | 32 todo — 0 failures

## Design Decisions

- `RESTORE_VALID_JSON_FILENAMES` typed as `Set<string>` (not `Set<literal>`) so
  that TypeScript strict mode allows `set.has(name)` where `name: string`
  (TS2345 would fire otherwise).
- The new file has zero imports from inside `packages/cleo/src/` to prevent
  circular-import risk. It is a pure constants leaf module.
- DB operation labels (`'tasks.db'`, `'brain.db'`) that appear as structured-data
  identifiers in system-engine.ts check results were intentionally left as
  literals — they are API surface values, not file paths.
