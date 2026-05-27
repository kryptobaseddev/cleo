# T11007 Audit: getCleoDirAbsolute Callsite Enumeration

**Date**: 2026-05-27
**Task**: T11007
**Parent Epic**: T10297 (EP-ORPHAN-KILL)
**Scope**: All non-test source files under packages/core/src/, packages/cleo/src/, scripts/

---

## Baseline Summary

| Category | Count | Description |
|----------|-------|-------------|
| (a) Direct | 79 | Callsites that directly invoke `getCleoDirAbsolute(...)` |
| (b) Helper delegates | 9 | Wrapper functions in paths.ts / rcasd-paths.ts that internally call `getCleoDirAbsolute` |
| (c) Indirect via getCleoDir | 37 | Callsites using `getCleoDir(...)` which delegates to `getCleoDirAbsolute` when cwd is provided |
| **TOTAL** | **125** | All non-test source callsites |

**Key finding**: 5 of the 37 `getCleoDir()` callsites pass NO cwd argument — these return a RELATIVE `.cleo` path (or CLEO_DIR env) and do NOT go through `getCleoDirAbsolute`'s strict ancestor-walk. These are in `metrics/common.ts` (4 sites) and `checkpoint.ts` (1 site). These are a separate concern from the main migration path.

---

## Category (a): Direct `getCleoDirAbsolute` Consumers (79)

### With `cwd` (44)

```
packages/cleo/src/dispatch/domains.ts:792:a
packages/core/src/docs/docs-update.ts:204:a
packages/core/src/identity/cleo-identity.ts:90:a
packages/core/src/lifecycle/consolidate-rcasd.ts:274:a
packages/core/src/lifecycle/consolidate-rcasd.ts:342:a
packages/core/src/lifecycle/evidence.ts:172:a
packages/core/src/lifecycle/index.ts:390:a
packages/core/src/lifecycle/rcasd-index.ts:133:a
packages/core/src/lifecycle/rcasd-index.ts:287:a
packages/core/src/lifecycle/rcasd-index.ts:303:a
packages/core/src/lifecycle/rcasd-paths.ts:77:a
packages/core/src/lifecycle/rcasd-paths.ts:205:a
packages/core/src/memory/index.ts:95:a
packages/core/src/migration/index.ts:278:a
packages/core/src/migration/index.ts:308:a
packages/core/src/nexus/sharing/index.ts:240:a
packages/core/src/observability/log-reader.ts:34:a
packages/core/src/project-info.ts:101:a
packages/core/src/release/release-manifest.ts:1086:a
packages/core/src/remote/index.ts:83:a
packages/core/src/remote/index.ts:99:a
packages/core/src/remote/index.ts:124:a
packages/core/src/remote/index.ts:141:a
packages/core/src/remote/index.ts:176:a
packages/core/src/remote/index.ts:227:a
packages/core/src/remote/index.ts:314:a
packages/core/src/sessions/session-grade.ts:356:a
packages/core/src/sessions/session-grade.ts:370:a
packages/core/src/setup/sections/verification.ts:365:a
packages/core/src/skills/orchestrator/startup.ts:66:a
packages/core/src/snapshot/index.ts:182:a
packages/core/src/store/attachment-store.ts:167:a
packages/core/src/store/memory-sqlite.ts:58:a
packages/core/src/store/memory-sqlite.ts:675:a
packages/core/src/store/migration-sqlite.ts:159:a
packages/core/src/store/migration-sqlite.ts:529:a
packages/core/src/store/sqlite.ts:74:a
packages/core/src/store/worktree-isolation-guard.ts:51:a
packages/core/src/system/storage-preflight.ts:48:a
packages/core/src/validation/schema-integrity.ts:217:a
```

### With `projectRoot` (29)

```
packages/core/src/agents/variable-substitution.ts:430:a
packages/core/src/memory/dream-cycle.ts:505:a (dynamic import)
packages/core/src/project-info.ts:42:a
packages/core/src/project-info.ts:69:a
packages/core/src/release/plan.ts:956:a
packages/core/src/release/plan.ts:1732:a
packages/core/src/release/release-manifest.ts:1351:a
packages/core/src/scaffold/ensure-config.ts:229:a
packages/core/src/scaffold/ensure-config.ts:268:a
packages/core/src/scaffold/ensure-config.ts:362:a
packages/core/src/scaffold/ensure-dirs.ts:46:a
packages/core/src/scaffold/ensure-dirs.ts:72:a
packages/core/src/scaffold/ensure-dirs.ts:183:a
packages/core/src/scaffold/ensure-dirs.ts:211:a
packages/core/src/scaffold/ensure-skills.ts:28:a
packages/core/src/scaffold/migrate-worktree-include.ts:81:a
packages/core/src/scaffold/project-detection.ts:20:a
packages/core/src/scaffold/project-detection.ts:68:a
packages/core/src/scaffold/project-detection.ts:212:a
packages/core/src/scaffold/project-detection.ts:270:a
packages/core/src/scaffold/project-detection.ts:340:a
packages/core/src/scaffold/project-detection.ts:371:a
packages/core/src/scaffold/project-detection.ts:414:a
packages/core/src/scaffold/project-detection.ts:457:a
packages/core/src/scaffold/project-detection.ts:488:a
packages/core/src/scaffold/project-detection.ts:519:a
packages/core/src/setup/sections/identity.ts:142:a
packages/core/src/system/platform-paths.ts:118:a
packages/core/src/tasks/gate-runner.ts:256:a (dynamic import)
```

### With `options.cwd` (4)

```
packages/core/src/upgrade.ts:160:a
packages/core/src/upgrade.ts:192:a
packages/core/src/upgrade.ts:405:a
packages/core/src/upgrade.ts:1287:a
```

### With `root` (2)

```
packages/core/src/memory/pipeline-manifest-sqlite.ts:1097:a
packages/core/src/scaffold/project-detection.ts:118:a
```

### With `projectPath` (1)

```
packages/core/src/system/project-health.ts:701:a
```

### No args / bootstrap (2)

```
packages/core/src/init.ts:696:a
packages/core/src/init.ts:743:a  (bootstrap:true)
```

---

## Category (b): Helper Delegates (9)

Wrapper functions that internally call `getCleoDirAbsolute`:

```
packages/core/src/paths.ts:266:b     getCleoDir(cwd) → getCleoDirAbsolute(cwd)
packages/core/src/paths.ts:841:b     getTaskPath() → join(getCleoDirAbsolute(cwd), 'tasks.db')
packages/core/src/paths.ts:859:b     getConfigPath() → join(getCleoDirAbsolute(cwd), 'config.json')
packages/core/src/paths.ts:877:b     getSessionsPath() → join(getCleoDirAbsolute(cwd), 'sessions.json')
packages/core/src/paths.ts:895:b     getTasksArchivePath() → join(getCleoDirAbsolute(cwd), 'tasks-archive.json')
packages/core/src/paths.ts:916:b     getCleoLogPath() → join(getCleoDirAbsolute(cwd), 'logs', 'cleo.log')
packages/core/src/paths.ts:934:b     getBackupDir() → join(getCleoDirAbsolute(cwd), 'backups', 'operational')
packages/core/src/lifecycle/rcasd-paths.ts:50:b   getRcasdDir() → join(getCleoDirAbsolute(cwd), DEFAULT_DIR)
packages/core/src/lifecycle/rcasd-paths.ts:63:b   getRcasdPath() → join(getCleoDirAbsolute(cwd), DEFAULT_DIR, normalized)
```

---

## Category (c): Indirect via `getCleoDir` (37)

### With `cwd` argument → delegates to `getCleoDirAbsolute` (31)

```
packages/core/src/context/index.ts:117:c
packages/core/src/context/index.ts:207:c
packages/core/src/issue/template-parser.ts:194:c
packages/core/src/issue/template-parser.ts:220:c
packages/core/src/metrics/aggregation.ts:19:c
packages/core/src/metrics/aggregation.ts:49:c
packages/core/src/metrics/aggregation.ts:118:c
packages/core/src/metrics/aggregation.ts:254:c
packages/core/src/metrics/aggregation.ts:305:c
packages/core/src/metrics/aggregation.ts:363:c
packages/core/src/metrics/aggregation.ts:386:c
packages/core/src/metrics/otel-integration.ts:18:c
packages/core/src/metrics/token-estimation.ts:52:c
packages/core/src/release/release-config.ts:26:c
packages/core/src/release/release-config.ts:54:c
packages/core/src/release/version-bump.ts:53:c
packages/core/src/sessions/context-alert.ts:18:c
packages/core/src/sessions/context-alert.ts:55:c
packages/core/src/sessions/context-alert.ts:62:c
packages/core/src/sessions/context-alert.ts:81:c
packages/core/src/sessions/context-monitor.ts:80:c
packages/core/src/sessions/hitl-warnings.ts:30:c
packages/core/src/sessions/hitl-warnings.ts:111:c
packages/core/src/sessions/session-enforcement.ts:21:c
packages/core/src/store/git-checkpoint.ts:300:c
packages/core/src/store/git-checkpoint.ts:349:c
packages/core/src/store/git-checkpoint.ts:400:c
packages/core/src/store/git-checkpoint.ts:436:c
packages/core/src/store/sqlite-backup.ts:700:c
packages/core/src/store/sqlite-backup.ts:739:c
packages/core/src/store/sqlite-backup.ts:771:c
```

### NO `cwd` — returns RELATIVE `.cleo` (does NOT hit `getCleoDirAbsolute`) (5)

```
packages/cleo/src/cli/commands/checkpoint.ts:32:c
packages/core/src/metrics/common.ts:15:c
packages/core/src/metrics/common.ts:24:c
packages/core/src/metrics/common.ts:29:c
packages/core/src/metrics/common.ts:34:c
```

### Internal fallback within `getCleoDirAbsolute` itself (1)

```
packages/core/src/paths.ts:323:c
```

---

## Notes

1. **Total baseline**: 125 non-test source callsites reach (or define) `getCleoDirAbsolute` across 3 categories.
2. **5 no-cwd `getCleoDir()` sites**: These return a relative `.cleo` path and do NOT go through the strict `getCleoDirAbsolute` ancestor-walk. They are in `metrics/common.ts` (4) and `checkpoint.ts` (1). These are a separate migration concern.
3. **Dynamic import sites**: `memory/dream-cycle.ts:505` and `tasks/gate-runner.ts:256` use `await import('../paths.js')` to lazily load `getCleoDirAbsolute`. These need careful migration to ensure the dynamic import resolves the new API.
4. **Highest-density files**: `scaffold/project-detection.ts` (11 sites), `remote/index.ts` (7 sites), `metrics/aggregation.ts` (7 sites), `upgrade.ts` (4 sites).
5. **`context/index.ts`**: Has a LOCAL `getCleoDir` function (line 11) shadowing the paths.ts export — this is a separate shadow concern for the migration.
6. **Existing `getCleoDirAbsolute` definition**: `paths.ts:322` with full ancestor-walk + worktree guard (`_cwdHasGitAncestor`). This is the function being migrated away from in favor of `resolveCanonicalCleoDir`.

