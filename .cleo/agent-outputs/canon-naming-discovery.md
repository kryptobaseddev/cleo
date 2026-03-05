# Canon Naming Discovery Report

**Agent**: canon-researcher
**Date**: 2026-03-04
**Scope**: Full codebase scan for all NEXUS-CORE-ASPECTS.md canon terms

---

## 1. Canon Term Usage Map

### 1.1 Thread (as NEXUS concept)

**In docs/concepts/ (canon definition zone):**
- `docs/concepts/NEXUS-CORE-ASPECTS.md:15-19` — Canon definition: "smallest honest unit of work"
- `docs/concepts/NEXUS-CORE-ASPECTS.md:25,55,99,105,107,114,122,134,151,152` — Multiple conceptual references
- `docs/concepts/CLEO-VISION.md:31,271,280,299` — Workshop vocabulary list, neural hierarchy, LOOM pipeline
- `docs/concepts/CLEO-WORLD-MAP.md:80` — Progression chain: "Sticky Note -> Thread -> Loom -> ..."
- `docs/concepts/CLEO-FOUNDING-STORY.md:5,247,259,269` — Metaphorical "losing the thread" (narrative, not canon concept)
- `docs/concepts/CLEO-MANIFESTO.md:276` — Workshop vocabulary listing
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md:40` — Maps Thread to `tasks` domain
- `docs/concepts/CLEO-AWAKENING-STORY.md:9,15,51` — Narrative use
- `docs/concepts/CLEO-CANON-INDEX.md:27` — Workshop lexicon index entry

**In .cleo/ (orchestration protocols):**
- `.cleo/rcasd/T5332/T5332-complete-framework.md:28,59,64` — Tessera Pattern vocabulary table: "One agent's atomic unit of work"
- `.cleo/rcasd/T5332/orchestration-protocol.md:31,39,97,129,160,176,288` — Thread used extensively as orchestration unit

**In docs/mintlify/:**
- `docs/mintlify/concepts/CLEO-VISION.mdx:37,282,291,310` — Mirror of CLEO-VISION.md

**In src/ (TypeScript source):**
- **ZERO references** to Thread as a NEXUS concept. Only `docs/specs/MCP-SERVER-SPECIFICATION.md:1008` references "Thread Safety" (generic programming concept, not canon).

**In tests/:**
- **ZERO references.**

**In packages/:**
- **ZERO references.**

### 1.2 Loom (the aspect)

**In docs/concepts/ (canon definition zone):**
- `docs/concepts/NEXUS-CORE-ASPECTS.md:9,21,23,25,27,29,31,35,55,61,91,122,134,142,152,153` — Canon definition and extensive references: "epic-scale frame"
- `docs/concepts/CLEO-VISION.md:300` — "Loom: an epic-scale frame that holds related Threads under lifecycle discipline"
- `docs/concepts/CLEO-WORLD-MAP.md:80,82` — Progression chain
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md:41,42` — Maps Loom to `pipeline, tasks` domains
- `docs/concepts/CLEO-CANON-INDEX.md:27` — Lexicon index

**In .cleo/ (orchestration protocols):**
- `.cleo/rcasd/T5332/T5332-complete-framework.md:29` — "The EPIC frame holding related Threads"
- `.cleo/rcasd/T5332/orchestration-protocol.md:32,97` — Used extensively

**In src/ (TypeScript source):**
- **ZERO references** to "Loom" (lowercase aspect). No TypeScript code uses this canon term.

### 1.3 LOOM (Logical Order of Operations Methodology — the system)

**IMPORTANT DISTINCTION**: LOOM (all-caps) is a system acronym distinct from Loom (lowercase aspect).

**In docs/concepts/:**
- `docs/concepts/CLEO-VISION.md:28,111,125,147,261,263,265,267,270,280,284,313,592` — Extensively defined as lifecycle methodology system
- `docs/concepts/CLEO-WORLD-MAP.md:31,56,68,173,187` — LOOM as one of four core systems
- `docs/concepts/CLEO-MANIFESTO.md:110,112,116,118,120,162,172,254,258,276,294,380` — Manifesto references
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md:12,29,43,54,218,249,251,526` — System flow mapping

**In packages/:**
- `packages/ct-skills/skills.json:247,260` — LOOM skill definition
- `packages/ct-skills/skills/ct-cleo/SKILL.md:192,194,226` — Skill reference
- `packages/ct-skills/skills/ct-cleo/references/loom-lifecycle.md:1,3,5,10,41` — Dedicated LOOM lifecycle reference doc
- `packages/ct-skills/skills/ct-orchestrator/SKILL.md:58,60,62,64` — Orchestrator LOOM references
- `packages/ct-skills/profiles/recommended.json:3` — "Full LOOM (RCASD-IVTR+C pipeline) skills"
- `packages/ct-skills/profiles/core.json:3` — "Orchestration and LOOM (RCASD-IVTR+C) pipeline awareness"
- `packages/ct-agents/cleo-subagent/AGENT.md:57,59,73` — Subagent LOOM protocol

**In .cleo/:**
- `.cleo/adrs/ADR-021-memory-domain-refactor.md:31,40` — "pipeline = LOOM lifecycle + artifact ledger"
- `.cleo/adrs/ADR-007-domain-consolidation.md:104` — Domain consolidation reference
- `.cleo/rcasd/T5332/T5332-complete-framework.md:61,88,94,118,137,202` — Tessera Pattern uses LOOM extensively
- `.cleo/rcasd/T5332/orchestration-protocol.md:101,139,174,176,182,290,332` — Protocol uses LOOM

**In schemas/:**
- `schemas/system-flow-atlas.schema.json:48,116` — LOOM in enum: `["BRAIN", "LOOM", "NEXUS", "LAFS"]`

**In src/ (TypeScript source):**
- **ZERO references.** LOOM has no runtime representation in TypeScript code.

### 1.4 Tapestry

**In docs/concepts/:**
- `docs/concepts/NEXUS-CORE-ASPECTS.md:31,33,35,41,45,49,55,67,75,77,91,134,153,154` — Canon definition: "composed body of work made from multiple Looms"
- `docs/concepts/CLEO-VISION.md:31,301` — Workshop vocabulary
- `docs/concepts/CLEO-WORLD-MAP.md:80` — Progression chain
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md:42` — Maps to `pipeline, orchestrate` domains
- `docs/concepts/CLEO-CANON-INDEX.md:27` — Lexicon index

**In .cleo/:**
- `.cleo/rcasd/T5332/T5332-complete-framework.md:30` — "Multiple Looms as one campaign"
- `.cleo/rcasd/T5332/orchestration-protocol.md:33,34,37` — Protocol vocabulary

**In src/ (TypeScript source):**
- **ZERO references.**

### 1.5 Tessera

**In docs/concepts/:**
- `docs/concepts/NEXUS-CORE-ASPECTS.md:9,39,41,43,45,49,55,61,69,91,134,143,154` — Canon definition: "reusable composition pattern"
- `docs/concepts/CLEO-VISION.md:31,302` — Workshop vocabulary
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md:43` — Maps to `pipeline, orchestrate, tools` domains
- `docs/concepts/CLEO-CANON-INDEX.md:27` — Lexicon index

**In .cleo/ (where it's most actively used):**
- `.cleo/rcasd/T5332/T5332-complete-framework.md:1,10,12,31,100,216` — THE Tessera Pattern framework doc
- `.cleo/rcasd/T5332/orchestration-protocol.md:1,14,34,392,419` — Full orchestration protocol

**In src/ (TypeScript source):**
- **ZERO references.**

### 1.6 Cogs

**In docs/concepts/:**
- `docs/concepts/NEXUS-CORE-ASPECTS.md:9,57,59,61,67,69,126,144,155` — Canon definition: "discrete callable capabilities"
- `docs/concepts/CLEO-VISION.md:31,303` — Workshop vocabulary
- `docs/concepts/CLEO-WORLD-MAP.md:88` — "Cogs provide the working teeth"
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md:44` — Maps to `tools` domain
- `docs/concepts/CLEO-CANON-INDEX.md:27` — Lexicon index

**In .cleo/:**
- `.cleo/rcasd/T5332/T5332-complete-framework.md:32` — "MCP operations — discrete callable mechanisms"
- `.cleo/rcasd/T5332/orchestration-protocol.md:35` — Protocol vocabulary

**In src/ (TypeScript source):**
- **ZERO references.**

### 1.7 Clicks (as NEXUS concept)

**In docs/concepts/ (canon zone only — distinguishing from UI "click"):**
- `docs/concepts/NEXUS-CORE-ASPECTS.md:65,67,155` — Canon definition: "a single short-lived execution of a Cog"
- `docs/concepts/CLEO-WORLD-MAP.md:89` — "Each short-lived activation of a Cog is a Click"
- `docs/concepts/CLEO-CANON-INDEX.md:27` — Lexicon index

**In docs/mintlify/ (non-canon UI usage):**
- `docs/mintlify/specs/CLEO-WEB-DASHBOARD-UI.md:342,361,568,596,651,798` — These are UI "click" actions (NOT canon concept)

**In src/ (TypeScript source):**
- **ZERO references** as NEXUS concept.

### 1.8 Cascade (as NEXUS concept)

**IMPORTANT**: Distinguished from SQL `CASCADE` (onDelete) and code `cascade` (deletion strategy).

**In docs/concepts/ (canon definition zone):**
- `docs/concepts/NEXUS-CORE-ASPECTS.md:9,71,73,75,77,79,81,91,122,124,145,156` — Canon definition: "descent through gates", "Tapestry in live motion"
- `docs/concepts/CLEO-VISION.md:31,304` — Workshop vocabulary
- `docs/concepts/CLEO-WORLD-MAP.md:80` — Progression chain
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md:45` — Maps to `pipeline, orchestrate, check` domains
- `docs/concepts/CLEO-CANON-INDEX.md:27` — Lexicon index

**In .cleo/:**
- `.cleo/rcasd/T5332/T5332-complete-framework.md:34` — Protocol vocabulary
- `.cleo/rcasd/T5332/orchestration-protocol.md:37` — Protocol vocabulary

**In src/ (TypeScript source — NOT canon usage, these are technical cascade):**
- `src/types/exit-codes.ts:32` — `CASCADE_FAILED = 18` (task deletion cascade, not NEXUS concept)
- `src/core/tasks/deletion-strategy.ts:51-172` — Task cascade deletion logic (technical, not NEXUS concept)
- `src/core/tasks/delete-preview.ts:168-173` — Cascade delete preview (technical)
- `src/dispatch/engines/_error.ts:64` — `E_CASCADE_FAILED: 18` (error code)
- `src/mcp/lib/exit-codes.ts:41,360,375-378` — Cascade error codes (technical)
- `src/cli/renderers/tasks.ts:306` — "Cascade-deleted" display text
- `src/mcp/lib/__tests__/verification-gates.test.ts:620` — "Failure Cascade" test section

**NOTE**: The technical `cascade` in deletion-strategy.ts predates the canon naming and is coincidental. No NEXUS-concept Cascade exists in runtime code.

### 1.9 Tome

**In docs/concepts/:**
- `docs/concepts/NEXUS-CORE-ASPECTS.md:9,85,87,89,91,93,116,128,134,146,157` — Canon definition: "illuminated memory", "living readable canon"
- `docs/concepts/CLEO-VISION.md:31,305` — Workshop vocabulary
- `docs/concepts/CLEO-WORLD-MAP.md:80` — Progression chain
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md:46` — Maps to `memory, nexus` domains
- `docs/concepts/CLEO-CANON-INDEX.md:27` — Lexicon index

**In .cleo/ (heavily used in Tessera Pattern):**
- `.cleo/rcasd/T5332/T5332-complete-framework.md:12,35,59,64,71,73,74,111,128,143,145,146,174,175` — "Tome record" = manifest entry
- `.cleo/rcasd/T5332/orchestration-protocol.md:14,38,49,51,52,74,125,129,155,160,162,164,194,239,264,280,290,304,310,316,329,330` — Tome records throughout protocol

**In src/ (TypeScript source):**
- **ZERO references.**

### 1.10 Sticky Notes / StickyNote / sticky_note

**FULLY IMPLEMENTED in runtime code.** This is the only canon concept with complete TypeScript implementation.

**In src/core/sticky/ (7 implementation files):**
- `src/core/sticky/types.ts` — `StickyNote`, `StickyNoteStatus`, `StickyNoteColor`, `StickyNotePriority`, `CreateStickyParams`, `ListStickiesParams`, `ConvertStickyParams`
- `src/core/sticky/create.ts` — `addSticky()` function
- `src/core/sticky/list.ts` — `listStickies()` function
- `src/core/sticky/show.ts` — `getSticky()` function
- `src/core/sticky/convert.ts` — `convertStickyToTask()`, `convertStickyToMemory()`
- `src/core/sticky/archive.ts` — `archiveSticky()` function
- `src/core/sticky/id.ts` — `generateStickyId()` (SN-001 format)
- `src/core/sticky/index.ts` — Barrel exports

**In src/dispatch/ (domain + engine):**
- `src/dispatch/domains/sticky.ts` — Full `StickyHandler` class with query (list, show) and mutate (add, convert, archive)
- `src/dispatch/engines/sticky-engine.ts` — Engine layer (stickyAdd, stickyList, stickyShow, stickyConvertToTask, stickyConvertToMemory, stickyArchive)
- `src/dispatch/domains/__tests__/sticky.test.ts` — Domain registration tests
- `src/dispatch/registry.ts:2470-2520` — 5 registry entries (2 query, 3 mutate)
- `src/dispatch/types.ts:131` — `'sticky'` in canonical domain list

**In src/store/ (database layer):**
- `src/store/brain-schema.ts:52-58,150-167,240-241` — `brainStickyNotes` table, status/color/priority enums, types
- `src/store/brain-accessor.ts:28-29,338-402` — Full CRUD: addStickyNote, getStickyNote, findStickyNotes, updateStickyNote, deleteStickyNote

**In src/cli/:**
- `src/cli/commands/sticky.ts:26-222` — Full CLI command group (add, list, show, convert, archive)

**In drizzle-brain/ (migration):**
- `drizzle-brain/20260304045002_white_thunderbolt_ross/migration.sql` — CREATE TABLE brain_sticky_notes
- `drizzle-brain/20260304045002_white_thunderbolt_ross/snapshot.json` — Schema snapshot

**In docs/specs/:**
- `docs/specs/STICKY-NOTES-SPEC.md` — Full specification (268 lines)
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md:408-412` — 5 registered operations

**In packages/:**
- `packages/ct-skills/skills/ct-stickynote/` — Dedicated skill package

### 1.11 NEXUS (the Core concept)

**Extensively referenced across the entire codebase.** Key locations:

**In docs/concepts/ (canon):**
- `docs/concepts/NEXUS-CORE-ASPECTS.md:1-159` — The entire canon document
- `docs/concepts/CLEO-VISION.md:30,44,113,129,162,169,215,223,373-540,592` — NEXUS system section
- `docs/concepts/CLEO-WORLD-MAP.md:12,57,69,92,174,188` — NEXUS in world map
- `docs/concepts/CLEO-MANIFESTO.md:3,39,51,76-90,124-130,162,173,260,264,272,274,381,413` — Manifesto references
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md:12,30,54,528` — System mapping
- `docs/concepts/CLEO-CANON-INDEX.md:21,26,27,44,70` — Canon index

**In src/ (39 files total):**
- `src/core/nexus/` — Complete implementation directory (registry.ts, query.ts, deps.ts, permissions.ts, sharing/index.ts, index.ts, ARCHITECTURE.md + 4 test files)
- `src/dispatch/domains/nexus.ts` — Full NexusHandler (660 lines, FULLY IMPLEMENTED — not a stub)
- `src/dispatch/domains/__tests__/nexus.test.ts` — Tests
- `src/cli/commands/nexus.ts` — CLI command group
- `src/types/exit-codes.ts:79` — "NEXUS ERRORS (70-79)" section
- `src/mcp/lib/exit-codes.ts:136,852-932` — NEXUS error category
- `src/dispatch/registry.ts:2330-2432` — Registry entries for nexus domain
- `src/core/init.ts:17,265-282,325,486` — NEXUS registration during init

**In schemas/:**
- `schemas/system-flow-atlas.schema.json:116` — `["BRAIN", "LOOM", "NEXUS", "LAFS"]` enum

### 1.12 MEOW (as acronym/concept)

**ZERO references found anywhere in the codebase.** This term does not appear in any file.

### 1.13 Protocol Chains

**ONE reference found:**
- `docs/mintlify/developer/specifications/ORCHESTRATOR-PROTOCOL.mdx:80` — "Maintains protocol chain integrity" (in ORC-008 requirement)

No other references in src/, docs/concepts/, .cleo/, schemas/, or tests/.

### 1.14 Phase 5 / capstone

**"Phase 5" appears extensively** but in generic numbering context (not as a specific canon term):

**In .cleo/agent-outputs/ (task coordination):**
- Multiple T5323 files reference "Phase 5: Data Portability" as a work phase
- `.cleo/agent-outputs/wave3-dependency-audit.md:17,33,67` — Dependency audit references

**In .cleo/adrs/:**
- `.cleo/adrs/ADR-023-protocol-validation-dispatch.md:240` — "Phase 5: Tests"
- `.cleo/adrs/ADR-007-domain-consolidation.md:745` — Implementation phase

**In .cleo/rcasd/:**
- `.cleo/rcasd/T5149/BRAIN-multi-epic-restructuring-plan.md:74,75,130` — BRAIN Phase 5: Memory Lifecycle

**In docs/mintlify/ (various specs):**
- Multiple specification implementation docs use "Phase 5" as generic numbering

**"capstone":**
- **ZERO references found anywhere in the codebase.**

### 1.15 the legacy pattern / legacy-pattern / legacy-pattern

**ZERO references found anywhere in the codebase.**

### 1.16 cleo-evolution

**ZERO references found anywhere in the codebase.**

---

## 2. TODO Comments Registry

**Comprehensive search of all `*.ts` files in `src/` for `// TODO` or `/* TODO` patterns:**

**ZERO TODO comments found in TypeScript source files.**

The only "TODO" match in all of `src/` was in a markdown file:
- `src/protocols/testing.md:332` — `export TODO_FILE="$TEST_DIR/todo.json"` (variable name in BATS test example, not a TODO comment)

---

## 3. Underscore/Unused Import Registry

The following underscore-prefixed imports were found in `src/`:

### Type-aliasing imports (import type ... as _Type)
These are used for dynamic `node:sqlite` imports where the module may not be available:
- `src/store/sqlite.ts:21` — `import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';`
- `src/store/node-sqlite-adapter.ts:19` — `import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';`
- `src/core/memory/claude-mem-migration.ts:15` — `import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';`
- `src/core/memory/__tests__/claude-mem-migration.test.ts:17` — `import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';`

### Underscore-prefixed module imports (internal modules)
These import from files whose names start with `_` (convention for internal/private modules):
- `src/dispatch/engines/_error.ts` — Imported by 14+ engine files (canonical error helper)
- `src/dispatch/domains/_meta.ts` — Imported by all 10 domain handlers (canonical meta helper)
- `src/store/__tests__/test-db-helper.js` — Imported by 20+ test files (test utility)

**Assessment**: All underscore-prefixed imports are either:
1. Type aliases for conditional `node:sqlite` availability (legitimate pattern)
2. Imports from `_`-prefixed internal module files (legitimate naming convention)

No genuinely unused imports detected.

---

## 4. Sticky Notes Implementation Status

### Files in `src/core/sticky/`

| File | Exports | Status |
|------|---------|--------|
| `types.ts` | `StickyNote`, `StickyNoteStatus`, `StickyNoteColor`, `StickyNotePriority`, `CreateStickyParams`, `ListStickiesParams`, `ConvertStickyParams`, `ConvertedTarget`, `ConvertedTargetType` | Complete |
| `create.ts` | `addSticky()` | Complete |
| `list.ts` | `listStickies()` | Complete |
| `show.ts` | `getSticky()` | Complete |
| `convert.ts` | `convertStickyToTask()`, `convertStickyToMemory()` | Complete |
| `archive.ts` | `archiveSticky()` | Complete |
| `id.ts` | `generateStickyId()` | Complete |
| `index.ts` | Barrel exports (all of the above) | Complete |

### Sticky Domain Wiring

| Layer | File | Status |
|-------|------|--------|
| Domain Handler | `src/dispatch/domains/sticky.ts` | FULLY WIRED — StickyHandler with query(list, show) and mutate(add, convert, archive) |
| Engine | `src/dispatch/engines/sticky-engine.ts` | FULLY WIRED — 6 engine functions |
| Registry | `src/dispatch/registry.ts:2470-2520` | 5 operations registered (2q, 3m) |
| Domain Index | `src/dispatch/domains/index.ts` | sticky registered as canonical domain |
| Types | `src/dispatch/types.ts:131` | 'sticky' in CANONICAL_DOMAINS |
| Database | `src/store/brain-schema.ts` | `brain_sticky_notes` table in brain.db |
| DB Accessor | `src/store/brain-accessor.ts` | Full CRUD operations |
| CLI | `src/cli/commands/sticky.ts` | Complete CLI command group |
| Tests | `src/dispatch/domains/__tests__/sticky.test.ts` | Registry/domain tests present |
| Spec | `docs/specs/STICKY-NOTES-SPEC.md` | Full specification |
| Skill | `packages/ct-skills/skills/ct-stickynote/` | Skill package exists |

**Verdict**: Sticky domain is FULLY WIRED end-to-end (core -> engine -> domain -> registry -> CLI -> tests).

---

## 5. NEXUS Domain Implementation Status

### Status: FULLY IMPLEMENTED (not a stub)

**Domain handler**: `src/dispatch/domains/nexus.ts` (660 lines)
- **Class**: `NexusHandler implements DomainHandler`
- **Query operations** (10): `status`, `list`, `show`, `query`, `deps`, `graph`, `discover`, `search`, `share.status`, `share.remotes`, `share.sync.status`
- **Mutate operations** (13): `init`, `register`, `unregister`, `sync`, `sync.all`, `permission.set`, `share.snapshot.export`, `share.snapshot.import`, `share.sync.gitignore`, `share.remote.add`, `share.remote.remove`, `share.push`, `share.pull`

### Core modules (`src/core/nexus/`):

| File | Purpose | Status |
|------|---------|--------|
| `registry.ts` | Project registration, sync, list, get | Implemented |
| `query.ts` | Cross-project task query parser/resolver | Implemented |
| `deps.ts` | Global dependency graph | Implemented |
| `permissions.ts` | Three-tier permission enforcement | Implemented |
| `sharing/index.ts` | .gitignore sync, sharing status | Implemented |
| `index.ts` | Barrel exports | Implemented |
| `ARCHITECTURE.md` | Architecture guide | Present |

### Tests:
- `src/core/nexus/__tests__/registry.test.ts`
- `src/core/nexus/__tests__/query.test.ts`
- `src/core/nexus/__tests__/permissions.test.ts`
- `src/core/nexus/__tests__/deps.test.ts`
- `src/dispatch/domains/__tests__/nexus.test.ts`
- `src/cli/commands/__tests__/nexus.test.ts`

**Verdict**: NEXUS domain is FULLY IMPLEMENTED with complete business logic in `src/core/nexus/`, domain handler, engine, CLI, and tests. The previous MEMORY.md note saying "NEXUS domain handler: STUB ONLY" is STALE AND INCORRECT.

---

## Summary

### Canon Terms in Runtime Code (src/*.ts)

| Term | In src/? | Notes |
|------|----------|-------|
| Thread | NO | Concept only in docs |
| Loom (aspect) | NO | Concept only in docs |
| LOOM (system) | NO | Concept only in docs/packages |
| Tapestry | NO | Concept only in docs |
| Tessera | NO | Concept only in docs/.cleo |
| Cogs | NO | Concept only in docs |
| Clicks | NO | Concept only in docs |
| Cascade (canon) | NO | Only technical `cascade` in deletion-strategy.ts |
| Tome | NO | Concept only in docs/.cleo |
| Sticky Notes | YES | FULLY IMPLEMENTED (core, engine, domain, CLI, DB) |
| NEXUS | YES | FULLY IMPLEMENTED (core, engine, domain, CLI, DB, tests) |
| MEOW | NO | NOT FOUND ANYWHERE |
| Protocol Chains | NO | 1 reference in mintlify spec |
| Phase 5 | N/A | Generic numbering, not canon concept |
| the legacy pattern | NO | NOT FOUND ANYWHERE |
| cleo-evolution | NO | NOT FOUND ANYWHERE |

### Zero-Hit Terms (not found anywhere in codebase)
1. **MEOW** — Zero references
2. **the legacy pattern / legacy-pattern / legacy-pattern** — Zero references
3. **cleo-evolution** — Zero references
4. **capstone** — Zero references
5. **Tome** — Zero references in src/ (only in docs and .cleo/)
