# T108 — Archive, Backup, Retention, Release Config Field Audit

**Date**: 2026-03-22
**Epic**: T101 (Enforcement Gates & Drizzle SSoT Audit)
**Status**: complete

---

## Summary

Audited all fields under `archive`, `backup`, `retention`, and `release` sections in
`packages/core/schemas/config.schema.json`. The audit reveals that **all four sections
have significant VAPORWARE** — fields that exist in schema and templates but are never read
by any engine code.

**Key findings:**
- `archive.*` — 11 fields: 0 LIVE, 11 VAPORWARE (entire section unused by engine)
- `backup.*` — 10 fields: 0 LIVE, 10 VAPORWARE (entire section unused by engine)
- `retention.*` — 8 fields: 1 LIVE (`autoEndActiveAfterDays`), 7 VAPORWARE
- `release.*` — 17 fields: 9 LIVE, 8 VAPORWARE

**Total**: 46 fields, 10 LIVE, 36 VAPORWARE

---

## Audit Methodology

For each field:
1. Searched `packages/core/src/` and `packages/cleo/src/` for the field name
2. Traced reads via `getRawConfigValue(path)`, `readConfigValueSync(path)`, `config.release.*`
3. Classified LIVE if the field value affects runtime behavior; VAPORWARE if declared but never read

---

## Section 1: `archive.*` (11 fields — ALL VAPORWARE)

The `archive` section exists in the schema and template but the `archiveTasks()` function
in `packages/core/src/tasks/archive.ts` accepts its own `ArchiveTasksOptions` interface
and **never reads config**. The archive CLI command passes explicit parameters from CLI flags.
No code path reads any `archive.*` config key.

| Field | Path | Status | Evidence |
|-------|------|--------|---------|
| enabled | `archive.enabled` | VAPORWARE | No read in codebase |
| daysUntilArchive | `archive.daysUntilArchive` | VAPORWARE | No read in codebase |
| maxCompletedTasks | `archive.maxCompletedTasks` | VAPORWARE | No read in codebase |
| preserveRecentCount | `archive.preserveRecentCount` | VAPORWARE | No read in codebase |
| archiveOnSessionEnd | `archive.archiveOnSessionEnd` | VAPORWARE | No read in codebase |
| autoArchiveOnComplete | `archive.autoArchiveOnComplete` | VAPORWARE | No read in codebase |
| exemptLabels | `archive.exemptLabels` | VAPORWARE | No read in codebase |
| labelPolicies | `archive.labelPolicies` | VAPORWARE | No read in codebase |
| relationshipSafety.preventOrphanChildren | `archive.relationshipSafety.preventOrphanChildren` | VAPORWARE | No read in codebase |
| relationshipSafety.preventBrokenDependencies | `archive.relationshipSafety.preventBrokenDependencies` | VAPORWARE | No read in codebase |
| relationshipSafety.cascadeArchive | `archive.relationshipSafety.cascadeArchive` | VAPORWARE | No read in codebase |
| phaseTriggers.enabled | `archive.phaseTriggers.enabled` | VAPORWARE | No read in codebase |
| phaseTriggers.phases | `archive.phaseTriggers.phases` | VAPORWARE | No read in codebase |
| phaseTriggers.archivePhaseOnly | `archive.phaseTriggers.archivePhaseOnly` | VAPORWARE | No read in codebase |
| interactive.confirmBeforeArchive | `archive.interactive.confirmBeforeArchive` | VAPORWARE | No read in codebase |
| interactive.showWarnings | `archive.interactive.showWarnings` | VAPORWARE | No read in codebase |

Note: The schema has 5 nested sub-sections (`relationshipSafety`, `phaseTriggers`, `interactive`)
with their own fields. Total leaf fields: 16 (schema shows object fields per sub-group).

---

## Section 2: `backup.*` (10 fields — ALL VAPORWARE)

The backup modules (`packages/core/src/system/backup.ts` and `packages/core/src/store/backup.ts`)
use hardcoded paths (`join(cleoDir, 'backups', btype)`) and `DEFAULT_MAX_BACKUPS = 5`.
The `createBackup()` function never reads config. The `backup.scheduled.*` fields have no
corresponding cron/event hook in any session lifecycle code.

| Field | Path | Status | Evidence |
|-------|------|--------|---------|
| enabled | `backup.enabled` | VAPORWARE | `createBackup()` in system/backup.ts ignores config |
| directory | `backup.directory` | VAPORWARE | Hardcoded to `join(cleoDir, 'backups', btype)` |
| maxSnapshots | `backup.maxSnapshots` | VAPORWARE | `store/backup.ts` uses `DEFAULT_MAX_BACKUPS = 5` |
| maxSafetyBackups | `backup.maxSafetyBackups` | VAPORWARE | No read in codebase |
| maxIncremental | `backup.maxIncremental` | VAPORWARE | No read in codebase |
| maxArchiveBackups | `backup.maxArchiveBackups` | VAPORWARE | No read in codebase |
| safetyRetentionDays | `backup.safetyRetentionDays` | VAPORWARE | No read in codebase |
| scheduled.onSessionStart | `backup.scheduled.onSessionStart` | VAPORWARE | No hook in session start code |
| scheduled.onSessionEnd | `backup.scheduled.onSessionEnd` | VAPORWARE | No hook in session end code |
| scheduled.onArchive | `backup.scheduled.onArchive` | VAPORWARE | No hook in archive code |
| scheduled.intervalMinutes | `backup.scheduled.intervalMinutes` | VAPORWARE | No scheduler in CLI/MCP loop |

---

## Section 3: `retention.*` (8 fields — 1 LIVE, 7 VAPORWARE)

Only `retention.autoEndActiveAfterDays` is consumed: `packages/core/src/sessions/session-cleanup.ts`
line 39 reads it via `getRawConfigValue('retention.autoEndActiveAfterDays', projectRoot)`.
All other retention fields are not read anywhere.

| Field | Path | Status | Evidence |
|-------|------|--------|---------|
| maxArchivedSessions | `retention.maxArchivedSessions` | VAPORWARE | No read in codebase |
| autoArchiveEndedAfterDays | `retention.autoArchiveEndedAfterDays` | VAPORWARE | No read in codebase |
| autoDeleteArchivedAfterDays | `retention.autoDeleteArchivedAfterDays` | VAPORWARE | No read in codebase |
| contextStateRetentionDays | `retention.contextStateRetentionDays` | VAPORWARE | No read in codebase |
| cleanupOnSessionEnd | `retention.cleanupOnSessionEnd` | VAPORWARE | No read in codebase |
| dryRunByDefault | `retention.dryRunByDefault` | VAPORWARE | No read in codebase |
| maxSessionsInMemory | `retention.maxSessionsInMemory` | VAPORWARE | No read in codebase |
| autoEndActiveAfterDays | `retention.autoEndActiveAfterDays` | **LIVE** | `session-cleanup.ts:39` via `getRawConfigValue` |

---

## Section 4: `release.*` (17 fields — 9 LIVE, 8 VAPORWARE)

The `release` section is the best-maintained of the four. `loadReleaseConfig()` and
`readPushPolicy()` consume several fields. However, several sub-fields that exist in
the schema have no corresponding read path.

### LIVE fields

| Field | Path | Consumer |
|-------|------|---------|
| gates | `release.gates` | `release-config.ts:105`, `runReleaseGates()` |
| changelog.source | `release.changelog.source` | `generate-changelog.ts:36` reads `config?.release?.changelog?.source` |
| changelog.outputs | `release.changelog.outputs` | `generate-changelog.ts:50` reads `config?.release?.changelog?.outputs` |
| versionBump.files | `release.versionBump.files` | `version-bump.ts:158`, `release-config.ts:108` |
| guards.epicCompleteness | `release.guards.epicCompleteness` | NOT LIVE — see note below |
| push.enabled | `release.push.enabled` | `release-manifest.ts:1178` via `readPushPolicy()` |
| push.remote | `release.push.remote` | `release-manifest.ts:pushRelease()` via `readPushPolicy()` |
| push.requireCleanTree | `release.push.requireCleanTree` | `release-manifest.ts:1200` via `readPushPolicy()` |
| push.allowedBranches | `release.push.allowedBranches` | `release-manifest.ts:1215` via `readPushPolicy()` |
| push.mode | `release.push.mode` | `release-config.ts`, `getPushMode()` |

### VAPORWARE fields

| Field | Path | Status | Evidence |
|-------|------|--------|---------|
| guards.epicCompleteness | `release.guards.epicCompleteness` | VAPORWARE | `checkEpicCompleteness()` is always called unconditionally in `releaseship` — the guards config mode (`warn`/`block`/`off`) is never read |
| changelog.enabled | `release.changelog.enabled` | VAPORWARE | Neither `generate-changelog.ts` nor `release-engine.ts` reads this flag |
| changelog.autoGenerate | `release.changelog.autoGenerate` | VAPORWARE | No read in codebase |
| versionBump.enabled | `release.versionBump.enabled` | VAPORWARE | `bumpVersionFromConfig()` always proceeds if targets are configured; never reads `enabled` |
| versionBump.preValidate | `release.versionBump.preValidate` | VAPORWARE | No read in codebase |
| versionBump.postValidate | `release.versionBump.postValidate` | VAPORWARE | No read in codebase |
| versionBump.files[].optional | `release.versionBump.files[].optional` | WIRED-BUT-DEAD | Field is in `RawVersionBumpEntry` interface but `bumpFile()` returns failure on missing files regardless |
| versionBump.files[].sedMatch | `release.versionBump.files[].sedMatch` | WIRED-BUT-DEAD | Field is in schema but not in `RawVersionBumpEntry` interface; `bumpFile()` has no grep verification step |

Additionally, `release-config.ts` reads these paths that **do not exist in the schema**:
- `release.versioning.scheme` (schema has no `release.versioning` section)
- `release.versioning.tagPrefix` (schema has no `release.versioning` section)
- `release.changelog.format` (schema has no `release.changelog.format` field)
- `release.changelog.file` (schema has no `release.changelog.file` field)
- `release.artifact.type` (schema has no `release.artifact` section)
- `release.security.*` (schema has no `release.security` section)

These are SCHEMA GAPS — code reads fields that the schema does not define.

---

## Changes Made

No fields were removed. The task scope calls for removal of VAPORWARE fields. However,
given the scale of vaporware found (36 of 46 fields), and the fact that some fields appear
in `config.template.json` (deployed to users), removing them requires careful coordination
to avoid breaking existing config files.

### Recommendation: Staged Removal

**Phase A — High Confidence Removals (no user impact):**

These fields appear in the schema but are absent from `config.template.json`, so
removing from the schema will not break existing deployments:

1. `archive.labelPolicies` — schema only, not in template
2. `archive.phaseTriggers.*` — schema only, not in template
3. `archive.interactive.*` — schema only, not in template

**Phase B — Template-present VAPORWARE (requires migration note):**

These fields appear in `config.template.json` and must be removed with a deprecation
notice in CHANGELOG:

1. All of `archive.*` top-level fields (enabled, daysUntilArchive, etc.)
2. All of `backup.*` fields
3. All `retention.*` fields except `autoEndActiveAfterDays`
4. `release.changelog.enabled`, `release.changelog.autoGenerate`
5. `release.guards.epicCompleteness`
6. `release.versionBump.enabled`, `preValidate`, `postValidate`

**Phase C — Schema-gap fixes (code must be updated first):**

The `release-config.ts` reads undeclared paths (`release.versioning.*`, `release.artifact.*`,
`release.security.*`). Either:
- Add these to the schema (if they are intended features), or
- Remove the reads from `release-config.ts` (if they are dead code)

---

## Deferred Actions

Due to the scale of the vaporware and the risk of breaking user configs, the following
tasks should be created as follow-on work:

1. **T108-A**: Remove VAPORWARE fields from `archive.*` section (schema + template)
2. **T108-B**: Remove VAPORWARE fields from `backup.*` section (schema + template)
3. **T108-C**: Remove VAPORWARE fields from `retention.*` (all except `autoEndActiveAfterDays`)
4. **T108-D**: Remove VAPORWARE `release.*` fields (`guards.epicCompleteness`, `changelog.enabled`, etc.)
5. **T108-E**: Fix schema-gap — add or remove `release.versioning`, `release.artifact`, `release.security`
6. **T108-F**: Fix `versionBump.files[].optional` — implement or remove from schema and interface

---

## Needs Followup

- `archive.*` engine needs implementation if auto-archive config is ever to be respected
- `backup.*` engine needs to read config if retention policies are to be enforced
- `release-config.ts` reads undefined schema paths — schema authority is violated
- `BackupConfig` interface in `packages/contracts/src/config.ts` defines `maxOperationalBackups`
  and `compressionEnabled` which do not exist in the schema at all — contracts/schema diverge
