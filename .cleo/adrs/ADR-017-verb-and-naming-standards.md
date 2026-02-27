# ADR-017: Verb and Naming Standards

**Date**: 2026-02-26
**Status**: accepted
**Accepted**: 2026-02-26
**Amends**: ADR-006 (§3 ADR Lifecycle Tooling), ADR-008 (§14 File Naming, §15.2 Verb Standards)
**Related ADRs**: ADR-006, ADR-007, ADR-008, ADR-009
**Related Tasks**: T4732, T4791, T4792, T4942
**Summary**: Establishes the canonical naming, verb, and frontmatter standards for CLEO ADRs. Extends architecture_decisions DB with lifecycle tracking columns and adds cognitive search fields (summary, keywords, topics) to enable agent-native ADR discovery via admin.adr.find.
**Keywords**: naming, verbs, frontmatter, adr, schema, db, cognitive-search, dispatch
**Topics**: admin, naming, storage, schema

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context

CLEO's naming conventions have no dedicated ADR. Verb standards and naming conventions are scattered across:

- **ADR-008 §14-15.2**: 1,657-line mega-document with only 14 of 36 canonical verbs in §15.2; naming conventions buried in §14
- **docs/specs/VERB-STANDARDS.md**: v2026.2.25, 36 verbs, the actual enforcement spec
- **docs/mintlify/specs/VERB-STANDARDS.md**: v2026.2.20, only 27 verbs, drifted from canonical
- **ADR-007 §3.x**: MCP dot-notation naming embedded in the domain-architecture ADR

Additionally:

- **ADR frontmatter** uses 22 different field names with no schema and no validation, inconsistent enums (`Proposed` vs `proposed`, `Implemented` not in DB enum)
- **`architecture_decisions` SQLite table** exists as scaffolding-only: Drizzle schema and migration exist, but zero CRUD operations, zero dispatch operations, zero task links built
- **Status enum inconsistency**: `Implemented` (not in DB enum), `Proposed` (capital P), `proposed -- HITL gate required` (prose conditions mixed into status enum field)

## 2. Decision

**ADR-017 SHALL own all naming, verb, and frontmatter standards.** Specifically:

- `docs/specs/VERB-STANDARDS.md` is the enforcement spec for the 36-verb canon; ADR-017 §1 is the authority position
- `src/dispatch/registry.ts` is the canonical runtime implementation of MCP operation naming
- ADR-008 §14 and §15.2 defer to ADR-017; those sections retain summary tables for quick reference only
- The `architecture_decisions` DB table is extended (partial amendment to ADR-006 §3) to support full lifecycle tracking

## §1 Core Verb Canon

The 36 canonical verbs are defined in `docs/specs/VERB-STANDARDS.md`. All new operations MUST use these verbs. See that document for complete enforcement rules, usage examples, and backward-compatibility aliases.

| Verb | Replaces | Domain.Operation Example |
|------|----------|--------------------------|
| `add` | create, install | `tasks.add`, `tools.skill.add` |
| `show` | get | `tasks.show`, `session.show` |
| `list` | — | `tasks.list`, `session.list` |
| `find` | search, query | `tasks.find`, `memory.find` |
| `update` | configure, modify, edit | `tasks.update` |
| `delete` | remove, uninstall | `tasks.delete` |
| `archive` | — | `tasks.archive` |
| `restore` | unarchive, reopen, uncancel | `tasks.restore` |
| `complete` | end, done, finish | `tasks.complete` |
| `start` | focus-set | `tasks.start`, `session.start` |
| `stop` | focus-clear, end | `tasks.stop`, `session.end` |
| `status` | show (for state) | `session.status` |
| `validate` | check (compliance) | `check.schema`, `check.protocol` |
| `record` | log (events) | `session.record.decision` |
| `resume` | continue, reopen | `session.resume` |
| `suspend` | pause, hibernate | `session.suspend` |
| `reset` | clear, wipe | `lifecycle.reset` |
| `init` | setup, bootstrap | `admin.init` |
| `enable` | activate, on | `tools.skill.enable` |
| `disable` | deactivate, off | `tools.skill.disable` |
| `backup` | snapshot, save | `admin.backup` |
| `migrate` | upgrade, transform | `admin.migrate` |
| `verify` | check (artifacts) | `check.verify` |
| `inject` | insert, load | `memory.inject` |
| `run` | exec (compound only) | `check.test.run` |
| `end` | — (MCP session only) | `session.end` |
| `link` | connect, associate | `memory.link` |
| `configure` | setup, config | `tools.skill.configure` |
| `check` | ping, probe (liveness) | `admin.health` |
| `repair` | fix, heal | `admin.repair` |
| `resolve` | settle, fix (conflicts) | `issues.resolve` |
| `unlink` | disconnect, detach | `memory.unlink` |
| `compute` | calculate, derive | `tasks.compute` |
| `schedule` | defer, plan, queue | `tasks.schedule` |
| `cancel` | abort, kill | `tasks.cancel` |
| `sync` | pull, push, reconcile | `admin.sync` |
| `inspect` | diagnose, debug | `admin.inspect` |

## §2 MCP Operation Naming

All MCP operations MUST follow dot-notation:

```
{domain}.{action}              → tasks.add, session.start
{domain}.{sub}.{action}        → session.record.decision, tools.skill.list
```

Rules:
- 9 canonical domains only: `tasks`, `session`, `memory`, `check`, `pipeline`, `orchestrate`, `tools`, `admin`, `nexus`
- Operations use verbs from §1 only
- Subdomain operations use max 3 levels: `{domain}.{sub}.{action}`
- Reference: ADR-007 §3.1 for domain definitions; `src/dispatch/registry.ts` for canonical runtime list

## §3 TypeScript Identifier Conventions

| Pattern | Usage | Example |
|---------|-------|---------|
| `camelCase` | functions, variables, object keys | `taskId`, `addTask()` |
| `PascalCase` | types, interfaces, classes | `TaskRow`, `AdminHandler` |
| `UPPER_SNAKE_CASE` | constants, enum values | `TASK_STATUSES`, `ExitCode` |
| `kebab-case.ts` | utility files | `dependency-check.ts` |
| `camelCase.ts` | single-operation modules | `add.ts`, `validate.ts` |
| `index.ts` | barrel exports | `src/core/tasks/index.ts` |

**Canonical Reference**: ADR-008 §14. ADR-017 owns this standard; ADR-008 §14 retains the summary table.

## §4 File Naming Conventions

Rules:
- Utility files: `kebab-case.ts`
- Single-operation modules: `camelCase.ts`
- Barrel exports: always `index.ts`
- Test files: `*.test.ts` (unit), `*.integration.test.ts` (integration)
- ADR markdown files: `ADR-NNN-{kebab-description}.md`

**Canonical Reference**: ADR-008 §14. ADR-017 owns this standard.

## §5 ADR Frontmatter Standard (Amendment to ADR-006 §3)

This section partially amends ADR-006 §3 (ADR Lifecycle Tooling). ADR-006 §3 defines the original 9-column `architecture_decisions` table. ADR-017 §5 extends it with 6 new columns and 2 new junction tables.

### §5.1 Canonical Frontmatter Fields

**Required** (all ADRs):
```
**Date**: YYYY-MM-DD
**Status**: proposed | accepted | superseded | deprecated
```

**Conditional** (required when applicable):
```
**Accepted**: YYYY-MM-DD        ← Required when Status = accepted
**Supersedes**: ADR-NNN[, ...]  ← Required when this supersedes others
**Superseded By**: ADR-NNN      ← Required when Status = superseded
```

**Optional**:
```
**Amends**: ADR-NNN             ← Partial amendment (scope-limited)
**Amended By**: ADR-NNN[, ...]  ← Inverse of Amends
**Related ADRs**: ADR-NNN[, ...]
**Related Tasks**: T####[, ...] ← Unified — replaces: Task, Epic, References, Research, Related Epics
**Gate**: HITL | automated
**Gate Status**: pending | passed | waived
```

**Retired fields** (do not use in new ADRs):
`Task`, `Epic`, `References`, `Research`, `Related Epics`, `Related Task Epic`, `Consensus`, `Source Documents`, `Lifecycle Ratification`, `Consensus Manifest`

### §5.1.1 Cognitive Search Fields (Amendment T4942)

Three additional **optional** frontmatter fields enable agent-native ADR discovery without reading full content:

```
**Summary**: 1-3 sentence plain-language decision summary.
**Keywords**: comma-separated freeform tags (e.g., 'sqlite, migration, storage')
**Topics**: comma-separated controlled-vocabulary domain tags
```

**Summary**: Free-text, 1–3 sentences. Written for agents, not humans. Should answer "what problem does this ADR solve and what was decided?" in a single short paragraph.

**Keywords**: Freeform comma-separated tags. Lower-case preferred. Used for fuzzy match scoring. Examples: `sqlite, migration, drizzle, schema, storage, validation, naming, verbstandards`.

**Topics**: Controlled vocabulary from the 9 canonical CLEO domains plus cross-cutting terms:
- Canonical domains: `tasks`, `session`, `memory`, `check`, `pipeline`, `orchestrate`, `tools`, `admin`, `nexus`
- Cross-cutting: `storage`, `testing`, `migration`, `naming`, `security`, `performance`, `schema`, `lifecycle`

Multiple topics as comma-separated list: `storage, migration, admin`

**Rationale for optional not required**: Backfill requires LLM assistance or human effort. Making these required would block new ADR creation. They are enrichment fields; the core ADR format remains Date + Status.

### §5.2 Status Enum

Status values MUST match DB enum exactly:
- `proposed` — drafted, pending review (lowercase only)
- `accepted` — approved via consensus or HITL (lowercase only)
- `superseded` — replaced by newer ADR
- `deprecated` — no longer applicable

MUST NOT use: `Proposed` (capital), `Implemented` (not in enum), prose conditions in status field.

Use `**Gate**: HITL` and `**Gate Status**: pending` for conditions.

### §5.3 DB Schema Extension

The `architecture_decisions` table (ADR-006 §3) is extended with:

**6 new columns** (added to existing 9):
- `date TEXT NOT NULL` — maps to `**Date**` frontmatter
- `accepted_at TEXT` — maps to `**Accepted**` frontmatter
- `gate TEXT CHECK(gate IN ('HITL', 'automated'))` — maps to `**Gate**`
- `gate_status TEXT CHECK(gate_status IN ('pending', 'passed', 'waived'))` — maps to `**Gate Status**`
- `amends_id TEXT` — maps to `**Amends**` frontmatter (single ADR ID)
- `file_path TEXT NOT NULL` — relative path to `.md` file in `.cleo/adrs/`

**New junction table `adr_task_links`**:
```sql
adr_id TEXT NOT NULL REFERENCES architecture_decisions(id)
task_id TEXT NOT NULL   -- soft ref (no FK — tasks can be purged)
link_type TEXT CHECK(link_type IN ('related', 'governed_by', 'implements'))
PRIMARY KEY (adr_id, task_id)
```

**New cross-reference table `adr_relations`**:
```sql
from_adr_id TEXT NOT NULL REFERENCES architecture_decisions(id)
to_adr_id TEXT NOT NULL REFERENCES architecture_decisions(id)
relation_type TEXT CHECK(relation_type IN ('supersedes', 'amends', 'related'))
PRIMARY KEY (from_adr_id, to_adr_id, relation_type)
```

### §5.4 Cognitive Search DB Extension (Amendment T4942)

The `architecture_decisions` table is further extended with 3 cognitive search columns:

**3 new search columns** (added to existing 15 from §5.3):
- `summary TEXT` — maps to `**Summary**` frontmatter
- `keywords TEXT` — maps to `**Keywords**` frontmatter (comma-separated string)
- `topics TEXT` — maps to `**Topics**` frontmatter (comma-separated string)

**`admin.adr.find` dispatch operation** (Tier 1 — accessible from check/memory tier):

```typescript
cleo_query({
  domain: 'admin',
  operation: 'adr.find',
  params: {
    query: string,        // Required: search terms
    topics?: string,      // Optional: comma-separated topic filter (AND semantics)
    keywords?: string,    // Optional: comma-separated keyword filter (AND semantics)
    status?: string,      // Optional: status filter
  }
})
```

**CLI equivalent**: `ct adr find <query> [--topics <topics>] [--keywords <keywords>] [--status <status>]`

**Search algorithm**: In-memory fuzzy scoring over parsed frontmatter fields. Chosen over SQLite FTS5 because:
- ADR set is small (<50) — in-memory is faster with no cold-start cost
- FTS5 virtual tables require DDL outside drizzle-kit schema management
- In-memory scoring allows field-weighted ranking without SQL complexity

**Score weights**:
| Field | Score per matched term |
|-------|----------------------|
| keywords (exact tag) | 40 |
| topics (exact tag) | 30 |
| title (contains) | 20 |
| summary (contains) | 10 |
| id (contains) | 5 |

**RCASD Pipeline auto-linking**: When `advanceStage()` transitions FROM `architecture_decision`, `linkPipelineAdr()` scans `.cleo/adrs/` for ADRs referencing the pipeline's task ID in `Related Tasks`, upserts them in DB, and creates `adr_task_links` with `link_type='implements'`. Non-fatal: pipeline progression is never blocked by ADR linking failure.

### §5.5 DB vs MANIFEST.jsonl — Two-Tier Storage (per ADR-009 §3.1)

The ADR system uses the same hybrid model as all BRAIN memory: **SQLite is the runtime store, JSONL is the portable export format**.

| | `architecture_decisions` (DB) | `.cleo/adrs/MANIFEST.jsonl` |
|---|---|---|
| **Written by** | `admin.adr.sync` (`ct adr sync`) | `npm run adr:manifest` |
| **Read by** | `admin.adr.find/list/show` | `npm run adr:validate`, offline tooling |
| **Fields** | Full — includes summary, keywords, topics, content, task links | Summary — metadata only, no full content |
| **Searchable** | ✅ score-weighted fuzzy via `admin.adr.find` | ❌ read-only JSONL |
| **Includes archive/** | ❌ active ADRs only | ✅ all ADRs including superseded |
| **Requires DB** | ✅ yes | ❌ no — works on any filesystem |

**Rule**: `ct adr sync` updates both in one pass — DB first, then MANIFEST.jsonl. Run it once after editing ADR frontmatter. `npm run adr:manifest` is a thin alias that calls the same core function.

---

## 3. Authority Hierarchy

```
ADR-017 (this doc)           → owns naming/verb/frontmatter standards
    ↓ references
docs/specs/VERB-STANDARDS.md → 36-verb enforcement spec
    ↓ implements
src/dispatch/registry.ts     → canonical runtime operation naming
    ↓ organizes
ADR-007                      → 9-domain architecture (domain namespace authority)
    ↓ extends
ADR-006 §3                   → architecture_decisions table (§5.3 adds to this)
    ↓ validates
schemas/adr-frontmatter.schema.json → frontmatter validation schema
```

---

## 4. Rationale

### 4.1 Why a dedicated ADR?

ADR-008 is 1,657 lines with 14 of 36 verbs. Naming buried in a mega-doc means agents miss it. A dedicated ADR creates a clear entry point and enables automated validation tooling.

### 4.2 Why extend ADR-006 §3?

The scaffolding-only `architecture_decisions` table cannot support automated frontmatter sync without `date`, `file_path`, and gate tracking. The extension preserves the original 9-column design.

### 4.3 Why retire field proliferation?

22 field names for 3 concepts creates validation complexity and forces agents to guess. The canonical 9 fields cover all cases with clear, unambiguous semantics.

---

## 5. Consequences

### 5.1 Positive

- Single authoritative source for all naming decisions
- Automated frontmatter validation via `schemas/adr-frontmatter.schema.json`
- ADR-to-task traceability via `adr_task_links`
- Agent-accessible queries via `admin.adr.list` / `admin.adr.show`

### 5.2 Negative

- Backfill required for all 15 existing ADRs (one-time migration)
- ADR-008 §14 and §15.2 become references, not authorities (acceptable: retain summary tables)

---

## 6. Compliance Criteria

1. `npm run adr:validate` → 0 violations
2. `npm run adr:manifest` → `.cleo/adrs/MANIFEST.jsonl` with 15+ entries
3. `cleo_mutate({domain:'admin', operation:'adr.sync'})` populates DB table
4. `cleo_query({domain:'admin', operation:'adr.list', params:{status:'accepted'}})` returns results
5. All 15 active ADRs have canonical frontmatter
6. `docs/mintlify/specs/VERB-STANDARDS.md` matches `docs/specs/VERB-STANDARDS.md`
7. `npx tsc --noEmit` exits 0
8. `npx vitest run` exits 0

---

**END OF ADR-017**
