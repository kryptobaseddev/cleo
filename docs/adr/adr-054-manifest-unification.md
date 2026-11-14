# ADR-054: Manifest/RCASD Architecture Unification

- **Status**: Accepted
- **Date**: 2026-04-20
- **Epic**: T1093
- **Supersedes**: ADR-027 §6.2 (migration execution guidance)

## Context

CLEO accumulated four parallel stores for agent-produced artifacts, all live simultaneously:

| Store | State before T1093 | Role |
|-------|--------------------|------|
| `pipeline_manifest` SQLite table (tasks.db) | 1 row — effectively empty | Canonical per ADR-027, not used by agents |
| `.cleo/agent-outputs/MANIFEST.jsonl` | 319 rows, actively written every hour | Legacy append-only file agents still target |
| `.cleo/rcasd/<TaskID>/<phase>/*.md` | 36 task dirs, 192 md files | RCASD lifecycle buckets, no DB registration |
| `.cleo/agent-outputs/*.md` (loose) | 401 files | Ad-hoc dumps, zero registration |

ADR-027 specified `MANIFEST.jsonl` retirement into `pipeline_manifest` but the migration code was never executed against live data, and no CLI surface exposed the canonical store. The `orchestrator.md` protocol told agents to run `cleo manifest show` — a command that did not exist. The compiled `cleo-subagent.md` still instructed `echo '{...}' >> MANIFEST.jsonl`, contradicting the `.cant` source which already specified `pipeline.manifest.append`.

## Decision

1. **`pipeline_manifest` table in tasks.db is the single source of truth.** All manifest entries MUST land here. No new writes to `MANIFEST.jsonl`, no new entries in `.cleo/agent-outputs/`.
2. **Top-level `cleo manifest` CLI command group** dispatches to `pipeline.manifest.*` operations: `show | list | find | stats | append | archive`.
3. **RCASD folding**: `.cleo/rcasd/<TaskID>/<phase>/*.md` files are ingested into `pipeline_manifest` with `metadata_json.phase` set to the RCASD stage (research, specification, architecture, decomposition, consensus, implementation, validation, testing, release, contribution). The filesystem convention remains valid for human navigation but the DB is authoritative.
4. **Loose md ingestion**: `.cleo/agent-outputs/*.md` files (non-subdir) are ingested with type inferred from filename conventions. A `cleo migrate manifest-ingest [--rcasd|--loose|--all]` CLI surface exposes this.
5. **Deprecation**: `cleo research manifest` prints a stderr deprecation warning and delegates to `cleo manifest list`. Removal in the next CalVer bump after one release cycle.
6. **Agent compilation**: `cleo-subagent.cant` OUT-002 constraint (`cleo manifest append`) is re-established in the compiled `.claude/agents/cleo-subagent.md`. The legacy `echo >> MANIFEST.jsonl` pattern is removed.

## Consequences

### Immediate (v2026.4.102)

- 593 entries migrated (192 rcasd + 401 loose md) via `cleo migrate manifest-ingest --all`
- `cleo manifest {show,list,find,stats,append,archive}` available globally
- `cleo research manifest` deprecation warning active
- Compiled `cleo-subagent.md` updated to use CLI append

### Follow-ups (filed as T1093 children)

- T1119: JSONL migration CLI (`cleo migrate manifest-jsonl`) + rename `MANIFEST.jsonl` → `MANIFEST.jsonl.migrated`. 319 legacy entries not yet in DB.
- T1097 un-skip: re-enable T1006 `NexusHandler: query top-entries` tests once brain_page_nodes query lands
- T1097 un-skip: re-enable T1057 `TC-002: exports map validation` tests once `@cleocode/nexus` package.json exports ship

### Validation findings exposed during T1093

21 P0/P1 CLEO guardrail findings logged to BRAIN (see observations O-mo7yr348-0 through O-mo84xjqi-0), including:

- CLEO_OWNER_OVERRIDE unauthenticated env var (#24 → T1118)
- Agent branch-switch capability (#21 → T1118)  
- Agent lifecycle-skip authority unscoped (#9/#10)
- State SSoT disagreement across `tasks.pipelineStage` / `lifecycle_pipelines` / child rollup (#13)
- Smoke-test vs installed-binary divergence (#17)
- Multi-agent shared working tree pollution (#18)
- Null agent identity on evidence captures (#3)

## References

- ADR-027 (superseded §6.2)
- CLEO-MANIFEST-SCHEMA-SPEC.md
- CLEO-OPERATION-CONSTITUTION.md §6.5 (pipeline domain)
- T1093 epic
- T1096 unification spec (`docs/specs/T1096-manifest-unification-spec.md`)
- T1094 inventory (`.cleo/agent-outputs/T1094-inventory.md`)
- T1095 drift map (`.cleo/agent-outputs/T1095-drift-map.md`)
- T1118 epic (harness-agnostic branch + override protection)
