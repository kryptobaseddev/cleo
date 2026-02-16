# ADR-002: Hybrid Storage Strategy (JSON + SQLite + JSONL)

**Task**: T4576
**Date**: 2026-02-14
**Decision Date**: 2026-02-16
**Status**: accepted
**Supersedes**: ADR-001 (partially — retains JSON for config/logs, introduces SQLite for task domain)

> **Note**: Approved as part of Wave 5 kickoff (T4644). The hybrid storage strategy was accepted
> after comprehensive review of all three research deliverables and validation of the
> drizzle-orm + sql.js technology choice.

## Context

ADR-001 decided to keep all data as JSON/JSONL. Since that decision, CLEO has grown significantly:

- **663 active tasks** (882 KB todo.json), **4,165 archived** (5.4 MB), **6,082 audit entries** (3.2 MB)
- **11 cross-file foreign key patterns** enforced only at application level
- **Full-file rewrite** on every single mutation (even one task status change rewrites 882 KB)
- **Unbounded growth** in archive and audit log files with no rotation
- **File-level locking** creates serialization bottleneck for multi-session access
- **JSONL append in TypeScript is actually a full read-rewrite** (defeating the append-only benefit)
- **No indexed queries** — every operation does full JSON parse then linear scan
- **TypeScript conversion underway** (T4454) — opportunity to introduce proper data layer

A comprehensive analysis was conducted with agent teams producing three research deliverables (see References). The analysis inventoried all 30+ data files, researched SQLite usage in CLI tools, and ran a competitive challenge analysis across three options.

## Decision Drivers

- Solo developer + AI agent workflow (not multi-user)
- TypeScript V2 conversion in progress (T4454)
- Cross-platform: Linux, macOS, Windows — zero native binding failures
- CAAMP and LAFS ecosystems are JSON-native
- Git-trackable state for config files
- Multi-session concurrent access (2-5 Claude Code sessions)
- Growing data volumes (task counts, audit logs)
- 37 existing JSON Schema validation files

## Options Evaluated

### Option 1: Stay JSON/JSONL (ADR-001 status quo)

Works at current scale but has documented scalability bottlenecks. Full-file rewrite for every mutation, no indexed queries, unbounded file growth, application-level referential integrity only.

**Verdict**: Adequate today, deteriorating over the next 6-12 months of use.

### Option 2: Full SQLite Migration

Replace all JSON/JSONL with domain-specific SQLite databases. Solves scalability and query issues but introduces: binary files in git (can't diff/merge), native binding pain (better-sqlite3) or WASM cold start (sql.js), CAAMP/LAFS impedance mismatch, massive migration effort, config in a database (no industry precedent).

**Verdict**: Over-engineered. Solves problems that only exist in one data domain while creating new problems everywhere else.

### Option 3: Targeted Hybrid (Selected)

Categorize data by access pattern. Use the right storage for each category:

| Category | Storage | Rationale |
|----------|---------|-----------|
| Config & state | JSON | Human-readable, small, git-tracked, CAAMP/LAFS native |
| Task domain | SQLite | Relational, heavily queried, concurrent access, growing |
| Append-only logs | JSONL | High-volume, write-once, concurrent-safe |
| Transient caches | In-memory | Rebuilt from source, no persistence needed |

## Decision

**Option 3: Targeted Hybrid.** Introduce SQLite for the task domain only. Everything else stays in its current format.

### What Changes

One new file: `.cleo/tasks.db` (SQLite via drizzle-orm + sql.js WASM)

Contains data currently spread across 4 JSON files:
- `todo.json` (active tasks, hierarchy, dependencies)
- `todo-archive.json` (archived tasks)
- `sessions.json` (session state, focus history)
- Dependency graph cache (currently rebuilt per process)

### What Stays the Same

| File | Format | Why |
|------|--------|-----|
| `config.json` (global + project) | JSON | Human-editable, git-tracked, CAAMP native |
| `project-info.json` | JSON | Small, metadata only |
| `.sequence` | JSON | Tiny, atomic counter |
| `.context-state.json` | JSON | Tiny, ephemeral |
| `todo-log.jsonl` (renamed) | JSONL | Append-only audit trail |
| `COMPLIANCE.jsonl` | JSONL | Append-only metrics |
| `SESSIONS.jsonl` | JSONL | Append-only session metrics |
| `TOKEN_USAGE.jsonl` | JSONL | Append-only token tracking |
| `MANIFEST.jsonl` | JSONL | Append-only agent output manifest |
| `rcsd/*/_manifest.json` | JSON | Small per-epic files |
| `research/*.json` | JSON | Write-once research data |
| `backup-manifest.json` | JSON | Backup tracking |

### Schema Design for tasks.db

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','active','blocked','done')),
  priority TEXT,
  type TEXT DEFAULT 'task',
  parent_id TEXT REFERENCES tasks(id),
  phase TEXT,
  size TEXT,
  position INTEGER,
  position_version INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  archived_at TEXT,
  archive_reason TEXT,
  origin TEXT,
  labels_json TEXT,
  notes_json TEXT,
  acceptance_json TEXT,
  metadata_json TEXT
);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE task_relations (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  related_to TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relation_type TEXT DEFAULT 'relates',
  PRIMARY KEY (task_id, related_to)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','suspended','ended','archived')),
  agent_id TEXT,
  scope_json TEXT,
  focus_history_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  current_focus TEXT REFERENCES tasks(id)
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_phase ON tasks(phase);
CREATE INDEX idx_tasks_archived ON tasks(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX idx_deps_target ON task_dependencies(depends_on);
CREATE INDEX idx_sessions_status ON sessions(status);
```

### Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| ORM | drizzle-orm | Type-safe schema, auto-migration via drizzle-kit, SQL-first, lightweight (~50KB) |
| Driver | sql.js (WASM) | Zero native bindings, cross-platform, no node-gyp. Performance penalty irrelevant at CLEO scale |
| Fallback | None | sql.js works everywhere — no fallback chain needed |

**Explicitly NOT using**: better-sqlite3 (native binding failures), @libsql/client (Turso-oriented), kysely (less migration tooling).

### Config Format

**No change.** Config stays JSON. Evaluated TOML and YAML — neither justified the parser dependency or migration effort. CLEO's config schema (2535 lines) has deep nesting that TOML handles poorly. JSON Schema validation (37 files) is too valuable to lose.

If comments become a pain point, adopt JSONC (JSON with Comments) as a minor parser change.

## Migration Plan

### Phase 1: Fix JSONL Append (Zero Risk)

Fix the TypeScript `appendJsonl()` to do a true file append instead of read-rewrite. Add log rotation for unbounded JSONL files. Rename `todo-log.json` to `todo-log.jsonl` to reflect actual format.

No schema changes, no new dependencies. Pure bug fix.

### Phase 2: Introduce tasks.db

- Add drizzle-orm + sql.js as dependencies
- Define drizzle schema matching the SQL above
- Create migration from todo.json + todo-archive.json + sessions.json → tasks.db
- Build TaskStore abstraction (same interface as current JSON store)
- Run both stores in parallel (dual-write) during transition
- Add `ct export --json` and `ct import --json` for human inspection and backup

### Phase 3: Deprecate JSON Task Files

- Remove dual-write, make tasks.db the sole source
- Deprecate todo.json, todo-archive.json, sessions.json
- Keep JSON export command for debugging
- Update backup system to use SQLite `.backup()` API
- Remove JSON Schema files for deprecated formats

## Consequences

### Positive

- Single task update is O(1) instead of rewriting 882 KB file
- Indexed queries for status/label/phase/parent filtering
- Foreign key enforcement on parent_id, dependencies, relations
- Active + archived tasks in one database (no cross-file ID uniqueness check)
- Sessions and tasks in same DB enables transactional focus changes
- Dependency graph queries via SQL instead of JSON parse + walk
- WAL mode handles multi-session concurrent reads
- drizzle-kit manages schema migrations automatically

### Negative

- tasks.db is not git-diffable (binary file)
- Developers need sqlite3 CLI or `ct export` for debugging
- Two data access patterns in the codebase (JSON + SQLite)
- ~50ms WASM cold start on first SQLite access per process
- Migration effort for existing installations

### Neutral

- Config, logs, metrics, RCSD manifests, research data: zero change
- CAAMP and LAFS interop: zero change (they don't touch task storage)
- Existing BATS tests for non-task operations: zero change

## Review Checklist

- [ ] Review storage landscape analysis (30+ files inventoried)
- [ ] Review SQLite CLI research (prior art, library comparison)
- [ ] Review competitive analysis (challenge matrix, worst-case scenarios)
- [ ] Validate drizzle-orm + sql.js as technology choice
- [ ] Confirm Phase 1 (JSONL fix) can proceed independently
- [ ] Confirm tasks.db schema covers all current todo.json fields
- [ ] Assess migration path for existing installations

## References

### Research Deliverables (linked to T4576)

1. **Storage Landscape Analysis**: `claudedocs/agent-outputs/storage-landscape-analysis.md`
   - Full inventory of 30+ data files, schemas, access patterns, relational needs, concurrency analysis
2. **SQLite CLI Research**: `claudedocs/agent-outputs/sqlite-cli-research.md`
   - Prior art (7 tools), 5 TypeScript SQLite libraries compared, operational concerns, performance benchmarks
3. **Competitive Analysis**: `claudedocs/agent-outputs/storage-competitive-analysis.md`
   - 3-option comparison with challenge matrix, worst-case scenarios, recommendation

### Related

- ADR-001: `docs/adrs/ADR-001-storage-architecture.md` (superseded for task domain)
- T4454: CLEO V2 Full TypeScript System epic
- T4466: V2-P3 Port orchestration and skill dispatch
- T4576: Review task for this ADR
