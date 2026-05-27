# T109: Remaining Config Sections Audit

**Epic**: T101 (Enforcement Gates & Drizzle SSoT Audit)
**Date**: 2026-03-22
**Agent**: claude-sonnet-4-6

## Scope

Sections NOT covered by T105–T108:
`tools`, `testing`, `analyze`, `graphRag`, `cli`, `output`, `display`, `logging` (legacy),
`gitCheckpoint`, `directories`, `documentation`, `contextAlerts`, `pinoLogging`, `defaults`,
`contributor`, `storage`, `agentOutputs`, `research`, `project`, `orchestrator`, `contextStates`,
`multiSession`, `retention`, `session` (schema-only extra fields), `enforcement.files`,
`enforcement.relates`

---

## Section-by-Section Audit

### 1. `tools` (16 fields across 4 objects)

Schema defines: `jsonProcessor`, `schemaValidator`, `testRunner`, `linter.bash`
Each has: `name`, `command`, `installCommand`, `required`

| Field group | Status | Evidence |
|-------------|--------|----------|
| `tools.jsonProcessor.*` (4 fields) | VAPORWARE | `grep config.tools` — zero results |
| `tools.schemaValidator.*` (4 fields) | VAPORWARE | Zero results |
| `tools.testRunner.*` (4 fields) | VAPORWARE | Zero results |
| `tools.linter.bash.*` (4 fields) | VAPORWARE | Zero results |

**Finding**: Designed for platform-detection abstraction; never wired. `platform.ts` uses hardcoded checks.

**Action**: Remove entire `tools` section from schema, template.

---

### 2. `testing` (14 fields across 3 objects)

Schema defines: `framework.{name,fileExtension,installCommand,runCommand,watchCommand,coverageCommand,configFile}`, `directories.{unit,integration,golden,fixtures}`, `skillName`, `dispatchKeywords`, `tempPathPattern`

| Field group | Status | Evidence |
|-------------|--------|----------|
| All 14 fields | VAPORWARE | `grep -rn "config\.testing"` — zero results. Codebase-map reads `projectContext.testing` from `project-context.json`, not `config.json`. |

**Action**: Remove entire `testing` section from schema, template.

---

### 3. `analyze` (15 fields across 4 objects)

| Field | Status | Evidence |
|-------|--------|----------|
| `analyze.lockAwareness.enabled` | LIVE | `sessions/hitl-warnings.ts:84` |
| `analyze.lockAwareness.warnOnly` | LIVE | `sessions/hitl-warnings.ts:93` |
| `analyze.lockAwareness.staleThreshold` | VAPORWARE | Not read |
| `analyze.phaseBoost.current` | VAPORWARE | `tasks/analyze.ts` uses hardcoded priority logic |
| `analyze.phaseBoost.adjacent` | VAPORWARE | Same |
| `analyze.phaseBoost.distant` | VAPORWARE | Same |
| `analyze.sizeStrategy` | VAPORWARE | `orchestration/critical-path.ts` uses its own hardcoded weights |
| `analyze.sizeWeights.small` | VAPORWARE | Same |
| `analyze.sizeWeights.medium` | VAPORWARE | Same |
| `analyze.sizeWeights.large` | VAPORWARE | Same |
| `analyze.staleDetection.enabled` | VAPORWARE | Not read |
| `analyze.staleDetection.pendingDays` | VAPORWARE | Not read |
| `analyze.staleDetection.noUpdateDays` | VAPORWARE | Not read |
| `analyze.staleDetection.blockedDays` | VAPORWARE | Not read |
| `analyze.staleDetection.urgentNeglectedDays` | VAPORWARE | Not read |

**Action**: Remove `phaseBoost`, `sizeStrategy`, `sizeWeights`, `staleDetection`, `lockAwareness.staleThreshold`. Keep `analyze.lockAwareness.{enabled,warnOnly}`.

---

### 4. `graphRag` (9 fields across 3 objects)

| Field group | Status | Evidence |
|-------------|--------|----------|
| `hierarchyBoost.*` (5 fields) | VAPORWARE | `graph-rag.ts:258` hardcodes `siblingBoost = 0.15`, `cousinBoost = 0.08` as function defaults. No `readConfigValueSync('graphRag.*')` exists. |
| `contextPropagation.*` (3 fields) | VAPORWARE | Same |
| `minScore` | VAPORWARE | Same |

**Action**: Remove entire `graphRag` section from schema, template.

---

### 5. `cli` (8 fields across 3 objects)

| Field | Status | Evidence |
|-------|--------|----------|
| `cli.aliases` | VAPORWARE | CLI aliases are hardcoded in `packages/cleo/src/cli/index.ts`. Config aliases never read. |
| `cli.plugins.enabled` | VAPORWARE | No plugin system implemented. |
| `cli.plugins.directories` | VAPORWARE | Same |
| `cli.plugins.autoDiscover` | VAPORWARE | Same |
| `cli.debug.enabled` | VAPORWARE | Not read |
| `cli.debug.validateMappings` | VAPORWARE | Not read |
| `cli.debug.checksumVerify` | VAPORWARE | Not read |
| `cli.debug.showTimings` | VAPORWARE | Not read |

**Action**: Remove entire `cli` section from schema and templates.

---

### 6. `output` (8 fields)

| Field | Status | Evidence |
|-------|--------|----------|
| `output.defaultFormat` | WIRED-BUT-DEAD | ENV_MAP in `config.ts:73–74`. In `CleoConfig` defaults. No CLI formatter reads `config.output.defaultFormat` — format is CLI-flag driven. |
| `output.showColor` | WIRED-BUT-DEAD | ENV_MAP only. No rendering consumer reads this field. |
| `output.showUnicode` | WIRED-BUT-DEAD | ENV_MAP only. No consumer. |
| `output.showProgressBars` | WIRED-BUT-DEAD | ENV_MAP only. No consumer. |
| `output.dateFormat` | WIRED-BUT-DEAD | ENV_MAP. Also: schema enum values (`iso8601`,`relative`,`unix`,`locale`) differ from contract type (`relative`,`iso`,`short`,`long`). |
| `output.csvDelimiter` | VAPORWARE | Not in ENV_MAP. Not read anywhere. |
| `output.showCompactTitles` | VAPORWARE | Not read anywhere. |
| `output.maxTitleLength` | VAPORWARE | Not read anywhere. |

**Action**: Remove `csvDelimiter`, `showCompactTitles`, `maxTitleLength` (pure vaporware). The 5 ENV-mapped fields are wired-but-dead — flag the `dateFormat` enum mismatch between schema and contract for a follow-up cleanup task.

---

### 7. `display` (3 fields)

| Field | Status | Evidence |
|-------|--------|----------|
| `display.showArchiveCount` | VAPORWARE | Zero results across all source |
| `display.showLogSummary` | VAPORWARE | Zero results |
| `display.warnStaleDays` | VAPORWARE | Zero results |

**Action**: Remove entire `display` section from schema and templates.

---

### 8. `logging` — legacy JSONL section (4 fields)

Schema describes as "Legacy JSONL change history settings… no longer actively used."

| Field | Status | Evidence |
|-------|--------|----------|
| `logging.enabled` | VAPORWARE | Not read |
| `logging.retentionDays` | VAPORWARE | Not read |
| `logging.level` (values: `minimal`/`standard`/`verbose`) | VAPORWARE | Pino logger reads `config.logging.level` which maps to `pinoLogging.level`, not legacy level |
| `logging.logSessionEvents` | VAPORWARE | Not read |

**Action**: Remove entire `logging` (legacy) section from schema. Remove from template.

---

### 9. `gitCheckpoint` (4 fields)

| Field | Status | Evidence |
|-------|--------|----------|
| `gitCheckpoint.enabled` | LIVE | `store/git-checkpoint.ts:157,298` |
| `gitCheckpoint.debounceMinutes` | LIVE | `git-checkpoint.ts:158,316` |
| `gitCheckpoint.messagePrefix` | LIVE | `git-checkpoint.ts:159,364,366` |
| `gitCheckpoint.noVerify` | LIVE | `git-checkpoint.ts:160` |

**Finding**: All 4 fields LIVE. No action needed.

---

### 10. `directories` (10+ fields)

| Field | Status | Evidence |
|-------|--------|----------|
| `directories.agentOutputs` | LIVE (deprecated) | `paths.ts:211–212` — Priority 3 fallback |
| `directories.data` | VAPORWARE | Not read |
| `directories.schemas` | VAPORWARE | Not read |
| `directories.backups.root` | VAPORWARE | Not read |
| `directories.backups.types` | VAPORWARE | Not read |
| `directories.templates` | VAPORWARE | Not read |
| `directories.research.output` | VAPORWARE | Not read |
| `directories.research.archive` | VAPORWARE | Not read |
| `directories.metrics` | VAPORWARE | Not read |
| `directories.documentation` | VAPORWARE | Not read |
| `directories.skills` | VAPORWARE | Not read |
| `directories.sync` | VAPORWARE | Not read |

**Action**: Retain `directories.agentOutputs` only. Remove all other `directories.*` fields. The `directories` object itself shrinks to `{ agentOutputs?: string }`.

---

### 11. `documentation` (4 fields across 2 objects)

| Field | Status | Evidence |
|-------|--------|----------|
| `documentation.driftDetection.enabled` | VAPORWARE | `detect-drift` command reads no config |
| `documentation.driftDetection.autoCheck` | VAPORWARE | `docs-sync.ts:258` takes as function parameter, never reads from config |
| `documentation.driftDetection.criticalCommands` | VAPORWARE | Same |
| `documentation.gapValidation.enabled` | VAPORWARE | Schema notes "Reserved for T2530 implementation" |

**Action**: Remove entire `documentation` section from schema and templates.

---

### 12. `contextAlerts` (4 fields)

| Field | Status | Evidence |
|-------|--------|----------|
| `contextAlerts.enabled` | LIVE | `context-alert.ts:195` |
| `contextAlerts.triggerCommands` | LIVE | `context-alert.ts:200–205` |
| `contextAlerts.suppressDuration` | LIVE | `context-alert.ts:231–238` |
| `contextAlerts.minThreshold` | WIRED-BUT-DEAD | `context-alert.ts:143` defines `minThreshold: AlertLevel = 'warning'` as a function default; no code reads `readConfigValueSync('contextAlerts.minThreshold')` to wire the config value to this parameter |

**Finding**: 3 of 4 fields LIVE. `minThreshold` is in schema and template but never read.

**Action**: Remove `contextAlerts.minThreshold` from schema and template.

---

### 13. `pinoLogging` (4 fields)

| Field | Status | Evidence |
|-------|--------|----------|
| `pinoLogging.level` | LIVE | Merged into `CleoConfig.logging` by `config.ts:184–188`; `logger.ts:99` |
| `pinoLogging.filePath` | LIVE | `logger.ts:54` |
| `pinoLogging.maxFileSize` | LIVE | `logger.ts:75` |
| `pinoLogging.maxFiles` | LIVE | `logger.ts:80` |

**Finding**: All 4 fields LIVE. No action needed.

---

### 14. `defaults` (3 fields)

| Field | Status | Evidence |
|-------|--------|----------|
| `defaults.priority` | LIVE | `tasks/enforcement.ts:42` reads `getRawConfigValue('defaults.priority', cwd)` |
| `defaults.phase` | VAPORWARE | Not read anywhere |
| `defaults.labels` | VAPORWARE | Not read anywhere |

**Action**: Remove `defaults.phase` and `defaults.labels` from schema and templates.

---

### 15. `contributor` (3 fields)

| Field | Status | Evidence |
|-------|--------|----------|
| `contributor.isContributorProject` | LIVE | `system/health.ts:506`, `injection.ts:224` |
| `contributor.devCli` | LIVE | `system/health.ts:507,518` |
| `contributor.verifiedAt` | WIRED-BUT-DEAD | Written by `scaffold.ts:322,342` but never read by any consumer |

**Action**: Remove `contributor.verifiedAt` from schema and template.

---

### 16. `storage` (1 field)

| Field | Status | Evidence |
|-------|--------|----------|
| `storage.engine` | WIRED-BUT-DEAD | `upgrade.ts:322–325` writes it. `doctor/checks.ts:429` reads OLD field `config.storageEngine` (different key). No consumer reads `storage.engine` to route DB operations — SQLite is always used. |

**Finding**: The field is declarative intent, not a runtime switch.

**Action**: Retain but add `x-deprecated` marker indicating SQLite is always the engine and this field has no behavioral effect.

---

### 17. `agentOutputs` (8 fields)

| Field | Status | Evidence |
|-------|--------|----------|
| `agentOutputs.directory` | LIVE | `paths.ts:198` |
| `agentOutputs.manifestFile` | LIVE | `paths.ts:251` |
| `agentOutputs.archiveDir` | VAPORWARE | Not read; `paths.ts` hardcodes `MANIFEST.archive.jsonl` |
| `agentOutputs.archiveDays` | VAPORWARE | Not read |
| `agentOutputs.manifest.maxEntries` | VAPORWARE | Not read |
| `agentOutputs.manifest.thresholdBytes` | VAPORWARE | Not read |
| `agentOutputs.manifest.archivePercent` | VAPORWARE | Not read |
| `agentOutputs.manifest.autoRotate` | VAPORWARE | Not read |

**Action**: Remove `archiveDir`, `archiveDays`, and entire `manifest` sub-object from schema and template.

---

### 18. `research` (deprecated, 6 fields)

| Field | Status | Evidence |
|-------|--------|----------|
| `research.outputDir` | LIVE (deprecated) | `paths.ts:205–207` |
| `research.manifestFile` | LIVE (deprecated) | `paths.ts:251` |
| `research.archiveDir` | VAPORWARE | Not read |
| `research.archiveDays` | VAPORWARE | Not read |
| `research.manifest.*` (4 fields) | VAPORWARE | Not read |

**Action**: Retain `outputDir` and `manifestFile`. Remove `archiveDir`, `archiveDays`, entire `manifest` sub-object.

---

### 19. `project` (complex nested state section)

| Field group | Status | Evidence |
|-------------|--------|----------|
| `project.status.health` | VAPORWARE | Written by doctor but never read from config to affect behavior |
| `project.status.lastCheck` | VAPORWARE | Not read |
| `project.status.schemaVersions.*` | VAPORWARE | `doctor/project-cache.ts` maintains its own object |
| `project.status.validation.*` | VAPORWARE | Not read |
| `project.status.injection.*` | VAPORWARE | Written but never read back |

**Finding**: The `project` section is state-storage pollution in the behavior config. No consumer reads `config.project.*` to alter runtime behavior.

**Action**: Remove entire `project` section from schema and template.

---

### 20. `orchestrator` (9 fields across 3 objects)

| Field | Status | Evidence |
|-------|--------|----------|
| `orchestrator.contextThresholds.warning` | LIVE | `skills/orchestrator/startup.ts:37–38` |
| `orchestrator.contextThresholds.critical` | LIVE | Same |
| `orchestrator.autoStopOnCritical` | VAPORWARE | Not read anywhere |
| `orchestrator.hitlSummaryOnPause` | VAPORWARE | Not read anywhere |
| `orchestrator.validation.customGates` | VAPORWARE | Schema marks `x-deprecated: true`; not read |
| `orchestrator.validation.requireManifestEntry` | VAPORWARE | Not read |
| `orchestrator.validation.requireWaveOrder` | VAPORWARE | Not read |
| `orchestrator.handoff.preferWaveBoundaries` | VAPORWARE | Not read |
| `orchestrator.handoff.includeKeyFindings` | VAPORWARE | Not read |

**Action**: Retain `orchestrator.contextThresholds.{warning,critical}`. Remove `autoStopOnCritical`, `hitlSummaryOnPause`, `validation`, `handoff` sub-objects.

---

### 21. `contextStates` (6 fields)

| Field | Status | Evidence |
|-------|--------|----------|
| All 6 fields | VAPORWARE | `context/index.ts` and `system-engine.ts` hardcode `join(cleoDir, 'context-states', 'context-state-{sessionId}.json')`. No code reads `config.contextStates.*`. |

**Action**: Remove entire `contextStates` section from schema and templates.

---

### 22. `multiSession` (13 fields)

| Field | Status | Evidence |
|-------|--------|----------|
| All 13 fields | VAPORWARE | Zero results from `grep maxConcurrentSessions`, `grep scopeValidation`, `grep allowNestedScopes`, etc. The separate `session.multiSession` boolean in `CleoConfig` is a different key at a different path. |

**Action**: Remove entire `multiSession` section from schema and templates.

---

### 23. `retention` (8 fields)

| Field | Status | Evidence |
|-------|--------|----------|
| `retention.autoEndActiveAfterDays` | LIVE | `sessions/session-cleanup.ts:39` reads `getRawConfigValue('retention.autoEndActiveAfterDays')` |
| `retention.maxArchivedSessions` | VAPORWARE | Not read |
| `retention.autoArchiveEndedAfterDays` | VAPORWARE | Not read |
| `retention.autoDeleteArchivedAfterDays` | VAPORWARE | Not read |
| `retention.contextStateRetentionDays` | VAPORWARE | Not read |
| `retention.cleanupOnSessionEnd` | VAPORWARE | Not read |
| `retention.dryRunByDefault` | VAPORWARE | Not read |
| `retention.maxSessionsInMemory` | VAPORWARE | Not read |

**Action**: Retain `retention.autoEndActiveAfterDays`. Remove all 7 other fields.

---

### 24. `session` — schema-only extra fields

`CleoConfig.session` contract has only: `autoStart`, `requireNotes`, `multiSession`.
The schema adds many more.

| Schema field | Status | Evidence |
|--------------|--------|----------|
| `session.requireSession` | VAPORWARE | Not read; enforcement reads `enforcement.session.requiredForMutate` |
| `session.requireSessionNote` | VAPORWARE | Not read |
| `session.requireNotesOnComplete` | VAPORWARE | Not read |
| `session.warnOnNoFocus` | VAPORWARE | Not read |
| `session.allowNestedSessions` | VAPORWARE | Not read |
| `session.allowParallelAgents` | VAPORWARE | Not read |
| `session.autoStartSession` | VAPORWARE | Not read |
| `session.autoDiscoveryOnStart` | VAPORWARE | Not read |
| `session.sessionTimeoutHours` | VAPORWARE | Not read |
| `session.enforcement` | LIVE | `session-enforcement.ts:54` reads `readConfigValueSync('session.enforcement', 'strict')` |
| `session.maxConcurrent` | VAPORWARE | Not read |

**Action**: Remove 10 vaporware fields from `session` schema. Retain `session.enforcement`.

---

### 25. `enforcement.files` and `enforcement.relates`

| Field | Status | Evidence |
|-------|--------|----------|
| `enforcement.files.autoExtract` | VAPORWARE | `grep -rn "autoExtract"` — zero source results |
| `enforcement.files.patterns` | VAPORWARE | Zero results |
| `enforcement.relates.autoExtract` | VAPORWARE | Zero results |
| `enforcement.relates.bidirectional` | VAPORWARE | Zero results (other `bidirectional` uses in codebase are for nexus/DB, not config) |

**Action**: Remove both `enforcement.files` and `enforcement.relates` sub-objects from schema and templates.

---

## Summary

### Vaporware Count by Section

| Section | Total Fields | LIVE | WIRED-BUT-DEAD | VAPORWARE |
|---------|-------------|------|----------------|-----------|
| `tools` | 16 | 0 | 0 | 16 |
| `testing` | 14 | 0 | 0 | 14 |
| `analyze` | 15 | 2 | 0 | 13 |
| `graphRag` | 9 | 0 | 0 | 9 |
| `cli` | 8 | 0 | 0 | 8 |
| `output` | 8 | 0 | 5 | 3 |
| `display` | 3 | 0 | 0 | 3 |
| `logging` (legacy) | 4 | 0 | 0 | 4 |
| `gitCheckpoint` | 4 | 4 | 0 | 0 |
| `directories` | 12 | 1 | 0 | 11 |
| `documentation` | 4 | 0 | 0 | 4 |
| `contextAlerts` | 4 | 3 | 1 | 0 |
| `pinoLogging` | 4 | 4 | 0 | 0 |
| `defaults` | 3 | 1 | 0 | 2 |
| `contributor` | 3 | 2 | 1 | 0 |
| `storage` | 1 | 0 | 1 | 0 |
| `agentOutputs` | 8 | 2 | 0 | 6 |
| `research` | 6 | 2 | 0 | 4 |
| `project` | ~14 | 0 | 0 | ~14 |
| `orchestrator` | 9 | 2 | 0 | 7 |
| `contextStates` | 6 | 0 | 0 | 6 |
| `multiSession` | 13 | 0 | 0 | 13 |
| `retention` | 8 | 1 | 0 | 7 |
| `session` (extra fields) | 11 | 1 | 0 | 10 |
| `enforcement.files` | 2 | 0 | 0 | 2 |
| `enforcement.relates` | 2 | 0 | 0 | 2 |
| **TOTAL** | **~200** | **25** | **8** | **~157** |

**~157 vaporware fields removed** from the schema across these sections.

---

## Changes Made

### Schema: `packages/core/schemas/config.schema.json`
- Removed: `tools`, `testing`, `graphRag`, `cli`, `display`, `logging` (legacy), `documentation`, `contextStates`, `multiSession`, `project` — entire sections
- Removed from `analyze`: `phaseBoost`, `sizeStrategy`, `sizeWeights`, `staleDetection`, `lockAwareness.staleThreshold`
- Removed from `output`: `csvDelimiter`, `showCompactTitles`, `maxTitleLength`
- Removed from `directories`: all fields except `agentOutputs`
- Removed from `contextAlerts`: `minThreshold`
- Removed from `defaults`: `phase`, `labels`
- Removed from `contributor`: `verifiedAt`
- Removed from `agentOutputs`: `archiveDir`, `archiveDays`, `manifest` sub-object
- Removed from `research`: `archiveDir`, `archiveDays`, `manifest` sub-object
- Removed from `orchestrator`: `autoStopOnCritical`, `hitlSummaryOnPause`, `validation`, `handoff`
- Removed from `retention`: all fields except `autoEndActiveAfterDays`
- Removed from `session`: all schema-only extra fields except `enforcement`
- Removed from `enforcement`: `files` and `relates` sub-objects
- Added `x-deprecated` note to `storage.engine`

### Template: `packages/core/templates/config.template.json`
- Removed all corresponding fields and sections

### Template: `packages/core/templates/global-config.template.json`
- Removed `display`, `cli`, `multiSession` sections
- Removed `output.csvDelimiter`, `output.showCompactTitles`, `output.maxTitleLength`
