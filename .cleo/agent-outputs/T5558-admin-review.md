# T5558 — admin Domain Review

**Task**: T5558
**Epic**: EPIC-API-CONSOLIDATION
**Date**: 2026-03-08
**Status**: complete

---

## Summary

Current: **50 ops** (26 query + 24 mutate) — note: T5508 measured 43 ops; actual registry count is 50.
Target: ≤30 ops.
Projected after consolidation: **28 ops** (-22).

The admin domain has grown to 50 operations across six functional clusters. The largest absolute cuts come from collapsing the export/import/snapshot explosion (6→2), merging token telemetry ops (6→2), and moving sync and grade ops out of admin entirely.

---

## Prior Analysis Summary (T5508)

T5508 identified 5 consolidation areas targeting 43→28:

1. **Export/Import explosion (6→2)**: Merge `export`, `export.tasks`, `snapshot.export` → one `export` with `format`/`scope` params; same for import side.
2. **ADR over-abstraction (5→3)**: Merge `adr.list` + `adr.find` → `adr.find` with filters; absorb `adr.validate` into `adr.sync`.
3. **Remove TodoWrite integration (3 ops)**: Move `sync`, `sync.status`, `sync.clear` to plugin.
4. **Consolidate health ops (3→1)**: Merge `health` + `doctor` + `fix` → parameterized `health`.
5. **Backup consolidation (2→1)**: Merge `backup` + `backup.restore` + `restore` → one op with `action` param.

This review confirms all 5 areas and extends with token telemetry and grade consolidation.

---

## Actual Operation Inventory

### Query (26 ops)

| # | Operation | Tier | Cluster |
|---|-----------|------|---------|
| 1 | `version` | 0 | system |
| 2 | `health` | 0 | health |
| 3 | `config.show` | 0 | config |
| 4 | `stats` | 0 | system |
| 5 | `context` | 0 | system |
| 6 | `runtime` | 0 | system |
| 7 | `job.status` | 0 | jobs |
| 8 | `job.list` | 0 | jobs |
| 9 | `dash` | 0 | discovery |
| 10 | `log` | 0 | system |
| 11 | `sequence` | 0 | system |
| 12 | `help` | 0 | discovery |
| 13 | `sync.status` | 1 | sync |
| 14 | `archive.stats` | 1 | archive |
| 15 | `adr.find` | 1 | adr |
| 16 | `adr.list` | 2 | adr |
| 17 | `adr.show` | 2 | adr |
| 18 | `doctor` | 0 | health |
| 19 | `export` | 2 | export |
| 20 | `snapshot.export` | 2 | export |
| 21 | `export.tasks` | 2 | export |
| 22 | `grade` | 2 | grade |
| 23 | `grade.list` | 2 | grade |
| 24 | `token.summary` | 2 | token |
| 25 | `token.list` | 2 | token |
| 26 | `token.show` | 2 | token |

### Mutate (24 ops)

| # | Operation | Tier | Cluster |
|---|-----------|------|---------|
| 1 | `init` | 0 | system |
| 2 | `config.set` | 0 | config |
| 3 | `backup` | 0 | backup |
| 4 | `restore` | 0 | backup |
| 5 | `backup.restore` | 0 | backup |
| 6 | `migrate` | 0 | system |
| 7 | `sync` | 0 | sync |
| 8 | `sync.clear` | 1 | sync |
| 9 | `cleanup` | 0 | system |
| 10 | `job.cancel` | 0 | jobs |
| 11 | `safestop` | 0 | system |
| 12 | `inject.generate` | 0 | system |
| 13 | `sequence` | 0 | system |
| 14 | `install.global` | 2 | system |
| 15 | `adr.sync` | 2 | adr |
| 16 | `adr.validate` | 2 | adr |
| 17 | `fix` | 0 | health |
| 18 | `import` | 2 | import |
| 19 | `snapshot.import` | 2 | import |
| 20 | `import.tasks` | 2 | import |
| 21 | `token.record` | 2 | token |
| 22 | `token.delete` | 2 | token |
| 23 | `token.clear` | 2 | token |
| 24 | `detect` | 0 | system |

---

## Decision Matrix

| Operation | Gateway | Tier | Decision | New Form / Reason |
|-----------|---------|------|----------|-------------------|
| `version` | query | 0 | KEEP | Core system info, tier 0 |
| `health` | query | 0 | PARAMETERIZE | Absorb `doctor`; `health {mode:"check"\|"diagnose"\|"repair"}` |
| `doctor` | query | 0 | MERGE into `health` | Duplicate of health.diagnose |
| `fix` | mutate | 0 | MERGE into `health` | Becomes `health {mode:"repair"}` as mutate |
| `config.show` | query | 0 | KEEP | Essential config read |
| `config.set` | mutate | 0 | KEEP | Essential config write |
| `stats` | query | 0 | KEEP | System metrics |
| `context` | query | 0 | KEEP | Session context display |
| `runtime` | query | 0 | KEEP | Runtime environment info |
| `job.status` | query | 0 | MERGE into `job` | `job {action:"status", jobId?}` — collapses job.status + job.list |
| `job.list` | query | 0 | MERGE into `job` | See above |
| `job.cancel` | mutate | 0 | KEEP (rename) | `job {action:"cancel", jobId}` or keep separate — small cluster, keep |
| `dash` | query | 0 | KEEP | Critical agent discovery, tier 0 |
| `log` | query | 0 | KEEP | Audit log access |
| `sequence` (query) | query | 0 | MERGE (deduplicate) | Duplicate name; keep query only, remove mutate |
| `sequence` (mutate) | mutate | 0 | REMOVE (duplicate name) | Same name in both gateways is an API smell; consolidate |
| `help` | query | 0 | KEEP | Critical agent discovery, mandatory |
| `init` | mutate | 0 | KEEP | Project initialization |
| `migrate` | mutate | 0 | KEEP | Schema migration |
| `cleanup` | mutate | 0 | KEEP | Operational hygiene |
| `safestop` | mutate | 0 | KEEP | Graceful shutdown |
| `inject.generate` | mutate | 0 | KEEP | Protocol injection |
| `install.global` | mutate | 2 | KEEP | Global setup refresh |
| `detect` | mutate | 0 | KEEP | Project context refresh |
| `backup` | mutate | 0 | PARAMETERIZE | `backup {action:"create"\|"restore"\|"file-restore"}` — absorbs `restore` and `backup.restore` |
| `restore` | mutate | 0 | MERGE into `backup` | See above |
| `backup.restore` | mutate | 0 | MERGE into `backup` | See above |
| `sync` | mutate | 0 | MOVE TO PLUGIN | TodoWrite integration is external — move to `tools` domain or plugin |
| `sync.status` | query | 1 | MOVE TO PLUGIN | Same — TodoWrite-specific |
| `sync.clear` | mutate | 1 | MOVE TO PLUGIN | Same |
| `archive.stats` | query | 1 | MOVE to `check` domain | Analytics reporting belongs in `check`, not `admin` |
| `adr.list` | query | 2 | MERGE into `adr.find` | `adr.find` with no query = list all; add `limit`/`offset`/`status` params |
| `adr.show` | query | 2 | KEEP | Single-item retrieval always stays |
| `adr.find` | query | 1 | KEEP | Fuzzy search — distinct from list |
| `adr.sync` | mutate | 2 | KEEP | DB sync operation |
| `adr.validate` | mutate | 2 | MERGE into `adr.sync` | `adr.sync {validate:true}` or `adr.sync {mode:"validate"}` |
| `export` | query | 2 | PARAMETERIZE | `export {format:"json"\|"csv"\|"tsv"\|"markdown"\|"todowrite", scope:"tasks"\|"snapshot"\|"package"}` |
| `snapshot.export` | query | 2 | MERGE into `export` | Becomes `export {scope:"snapshot"}` |
| `export.tasks` | query | 2 | MERGE into `export` | Becomes `export {scope:"package"}` |
| `import` | mutate | 2 | PARAMETERIZE | `import {format:..., scope:"tasks"\|"snapshot"\|"package"}` |
| `snapshot.import` | mutate | 2 | MERGE into `import` | Becomes `import {scope:"snapshot"}` |
| `import.tasks` | mutate | 2 | MERGE into `import` | Becomes `import {scope:"package"}` |
| `grade` | query | 2 | MOVE to `check` domain | Behavioral grading is not admin housekeeping |
| `grade.list` | query | 2 | MOVE to `check` domain | Same |
| `token.summary` | query | 2 | PARAMETERIZE | `token {action:"summary"\|"list"\|"show"}` — 3 query ops → 1 |
| `token.list` | query | 2 | MERGE into `token` | See above |
| `token.show` | query | 2 | MERGE into `token` | See above |
| `token.record` | mutate | 2 | PARAMETERIZE | `token {action:"record"\|"delete"\|"clear"}` — 3 mutate ops → 1 |
| `token.delete` | mutate | 2 | MERGE into `token` | See above |
| `token.clear` | mutate | 2 | MERGE into `token` | See above |

---

## Export/Import Consolidation (6→2)

**Current** (6 ops across query + mutate):
- query: `export`, `snapshot.export`, `export.tasks`
- mutate: `import`, `snapshot.import`, `import.tasks`

**Proposed** (2 ops):

```
query  admin export  {format: "json"|"csv"|"tsv"|"markdown"|"todowrite", scope: "tasks"|"snapshot"|"package", file?: string}
mutate admin import  {file: string, scope: "tasks"|"snapshot"|"package", dryRun?: boolean}
```

The `scope` parameter replaces the three-way operation split:
- `scope:"tasks"` = previous `export` / `import`
- `scope:"snapshot"` = previous `snapshot.export` / `snapshot.import`
- `scope:"package"` = previous `export.tasks` / `import.tasks`

**Savings**: -4 ops

---

## Health/Doctor/Fix Merge (3→1 each gateway)

**Current** (3 ops, split across gateways):
- query: `health` (quick status), `doctor` (comprehensive diagnostics)
- mutate: `fix` (auto-repair)

**Proposed** (1 logical op, 2 gateway entries):

```
query  admin health  {mode: "check"|"diagnose"}   # check = quick, diagnose = comprehensive
mutate admin health  {mode: "repair", checks?: string[]}
```

This collapses `health` + `doctor` into one query op with `mode` param, and makes `fix` the mutate form of the same op. The name `health` is already Tier 0 and in agent instructions — using it for all three modes is a natural fit.

**Savings**: -1 query op, -1 mutate op = -2 total

---

## Backup Consolidation (3→1)

**Current** (3 mutate ops):
- `backup` — create snapshot
- `restore` — restore from snapshot
- `backup.restore` — restore individual file from backup

**Proposed** (1 mutate op):

```
mutate admin backup  {action: "create"|"restore"|"file-restore", backupId?: string, file?: string}
```

The existing `validateAdminParams` already handles `restore` with `backupId`; the merged op extends that validation to the `action` discriminant.

**Savings**: -2 ops

---

## ADR Operations (5→3)

**Current** (5 ops):
- query: `adr.list`, `adr.show`, `adr.find`
- mutate: `adr.sync`, `adr.validate`

**Proposed** (3 ops):
- query: `adr.find` (absorbs `adr.list` — `adr.find` with no `query` param lists all; supports `status`/`limit`/`offset` filters already on `adr.list`), `adr.show`
- mutate: `adr.sync {validate?: boolean}` (absorbs `adr.validate` — add `validate:true` flag to run validation only)

`adr.list` vs `adr.find` is the classic list/find duplication. The `adr.find` description already mentions "fuzzy search" — making it the single entry point with an optional `query` param (absent = list all) eliminates the duplicate.

`adr.validate` is idempotent like `adr.sync`; it just skips the write step. A `mode:"validate"|"sync"` param (default `"sync"`) handles both.

**Savings**: -2 ops

---

## Sync Operations — Move to Plugin (3→0)

**Current** (3 ops):
- mutate: `sync`, `sync.clear`
- query: `sync.status`

These three ops exist solely for TodoWrite integration (T5326). TodoWrite is an external tool, not a core CLEO concept. Per T5508's recommendation, these should be moved to the `tools` domain (where `skill.*` and `issue.*` ops live) or extracted to a plugin.

**Recommended action**: Move all three to `tools` domain as `tools.todowrite.*` ops, matching the pattern already used for `tools.skill.*` and `tools.issue.*`.

**Savings for admin**: -3 ops

---

## Grade Operations — Move to `check` Domain (2→0)

**Current** (2 query ops in admin):
- `grade` — grade agent behavioral session
- `grade.list` — list past grade results

Behavioral grading is a compliance/quality check, not system administration. The `check` domain already holds compliance, validation, and verification operations. Moving `grade` and `grade.list` to `check` as `check.grade` and `check.grade.list` (or `check.grade {mode:"run"|"list"}`) gives them a more semantically correct home.

**Savings for admin**: -2 ops

---

## Token Telemetry Consolidation (6→2)

**Current** (6 ops):
- query: `token.summary`, `token.list`, `token.show`
- mutate: `token.record`, `token.delete`, `token.clear`

Token telemetry is genuinely admin-domain (system metrics), so these should stay in admin. However, 6 ops for CRUD + summary is excessive.

**Proposed** (2 ops):

```
query  admin token  {action: "summary"|"list"|"show", tokenId?: string, provider?: string, sessionId?: string, limit?: number, offset?: number}
mutate admin token  {action: "record"|"delete"|"clear", tokenId?: string, ...fields}
```

The `action` discriminant routes internally. This is the same pattern used for `tasks.find` vs `tasks.show` being the only query vs the action-parameterized pattern.

**Savings**: -4 ops

---

## Sequence Deduplication (2→1)

Both `query:sequence` and `mutate:sequence` exist. Having the same operation name in both gateways with no clear semantic distinction is an API smell. The query form (read the current sequence counter) should be the only one. If mutation (force-set sequence) is needed, it belongs under `config.set`.

**Recommended action**: Remove `mutate:sequence`; expose sequence mutation through `config.set {key:"sequence", value:N}`.

**Savings**: -1 op

---

## Archive.stats — Move to `check` Domain (1→0)

`archive.stats` provides analytics about archived tasks. This is a reporting/compliance read, matching the `check` domain's purpose. It is already at Tier 1 (not a core admin op).

**Savings for admin**: -1 op

---

## Projected Final Count

| Cluster | Current | Proposed | Delta |
|---------|---------|---------|-------|
| Discovery (help, dash) | 2 | 2 | 0 |
| System (version, stats, context, runtime, log, init, migrate, cleanup, safestop, inject.generate, sequence, install.global, detect) | 13 | 12 | -1 (sequence mutate removed) |
| Health (health, doctor, fix) | 3 | 2 | -1 (2 gateways of one op) |
| Config (config.show, config.set) | 2 | 2 | 0 |
| Jobs (job.status, job.list, job.cancel) | 3 | 2 | -1 (job.status+list merged) |
| Backup (backup, restore, backup.restore) | 3 | 1 | -2 |
| Sync (sync, sync.status, sync.clear) | 3 | 0 | -3 (moved to tools) |
| ADR (adr.*) | 5 | 3 | -2 |
| Export/Import | 6 | 2 | -4 |
| Token telemetry | 6 | 2 | -4 |
| Grade | 2 | 0 | -2 (moved to check) |
| Archive.stats | 1 | 0 | -1 (moved to check) |
| **Total** | **50** | **28** | **-22** |

**Projected: 28 ops — within the ≤30 target.**

---

## Ops Added to Other Domains

These ops leave admin but need homes:

| Op | Destination | New Name |
|----|-------------|----------|
| `sync` | `tools` | `tools.todowrite.sync` |
| `sync.status` | `tools` | `tools.todowrite.status` |
| `sync.clear` | `tools` | `tools.todowrite.clear` |
| `grade` | `check` | `check.grade` |
| `grade.list` | `check` | `check.grade.list` (or parameterize) |
| `archive.stats` | `check` | `check.archive.stats` |

Net across system: 50 admin → 28 admin + 6 ops distributed to tools/check. No ops are deleted — all functionality is preserved.

---

## Implementation Notes

1. **Parameterization is backward-incompatible**: Agents calling `admin export` today will get the same result. Agents calling `admin snapshot.export` will receive `E_INVALID_OPERATION` unless a deprecation alias is added during transition.

2. **Recommended transition approach**: Add the parameterized forms first, keep old ops as deprecated aliases returning a deprecation warning in `_meta`, then remove aliases in the next major version.

3. **`health` mode naming**: Use `mode:"check"` (quick) and `mode:"diagnose"` (comprehensive) rather than `mode:"health"` and `mode:"doctor"` to avoid embedding the old operation names.

4. **Validation layer**: `validateAdminParams` in `mutate.ts` handles `backup.restore` and `restore` separately today. After consolidation, switch to validating `action` param discriminant.

5. **Token ops location**: Consider whether `token.*` belongs in `check` domain (compliance/metrics) rather than `admin`. Left in admin here because token recording is an administrative write op, but reviewers should evaluate.

---

## References

- T5508: Prior admin domain analysis (5 consolidation areas)
- T5559, T5560, T5561: Sibling domain reviews in this consolidation epic
- `src/dispatch/registry.ts`: Registry source of truth (admin entries at lines 892–2468)
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md`: Canonical operation spec
- `docs/specs/VERB-STANDARDS.md`: Verb standards
