# CLEO Canonical Taxonomy

Task: T11186. Checked against `packages/contracts/src/taxonomy.ts` on 2026-11-15.

> Unified classification vocabulary for decisions, documents, tasks, and routing surfaces.

## Overview

Prior to T11186, CLEO had 10+ fragmented classification systems:

| System | Source | Values |
|--------|--------|--------|
| Decision types | `memory-schema.ts` BRAIN_DECISION_TYPES | 5 values |
| Decision categories | `memory-schema.ts` BRAIN_DECISION_CATEGORIES | 3 values |
| Doc kinds | `docs-taxonomy.ts` BUILTIN_DOC_KINDS | 10 values |
| Brain cognitive types | `brain.ts` BrainCognitiveType | 3 values |
| Task labels | `tasks.labels_json` (free-form) | 30+ ad-hoc strings |
| Edge kinds | `operations/brain.ts` BrainEdgeKind | open-ended |
| Pattern types | `memory-schema.ts` BRAIN_PATTERN_TYPES | 5 values |
| Observation types | `memory-schema.ts` BRAIN_OBSERVATION_TYPES | 8 values |
| Memory types | `memory-schema.ts` BRAIN_MEMORY_TYPES | 4 values |
| Link types | `memory-schema.ts` BRAIN_LINK_TYPES | 4 values |

Each system evolved independently with overlapping but incompatible vocabularies.
"architectural" meant one thing in BRAIN and another in ad-hoc labels. "spec"
was both a doc kind and a lifecycle phase with different semantics.

T11186 unifies these into a **single canonical taxonomy** with 5 axes.

## Axes

| Axis | Purpose | Example tags |
|------|---------|-------------|
| `domain` | Architectural subsystem or component area | `cli`, `core`, `brain`, `nexus` |
| `type` | Kind of artifact, decision, or entry | `architectural`, `technical`, `bugfix`, `migration` |
| `lifecycle` | Phase in the RCASD→IVTR pipeline | `research`, `implementation`, `release` |
| `priority` | Severity, urgency, or importance | `p0`, `p1`, `p2`, `p3` |
| `doc_kind` | Document classification | `adr`, `spec`, `research`, `handoff` |

A single tag can belong to multiple axes. For example, `architecture` spans
both `domain` and `type` axes — it classifies both the subsystem area AND
the kind of decision being made.

## Canonical Tag Registry

The single source of truth is `packages/contracts/src/taxonomy.ts`.

### Domain Tags (17 tags)

| Tag | Description |
|-----|-------------|
| `architecture` | Cross-cutting architectural subsystem |
| `cli` | Command-line interface and dispatch |
| `core` | Core engine and shared utilities |
| `contracts` | Type contracts and schemas |
| `caamp` | Hooks, adapters and providers. The registry's description expands CAAMP as "Cross-Agent Adaptive Messaging Protocol"; the package is `@cleocode/caamp`, the provider registry and package manager |
| `skills` | Agent skill definitions |
| `brain` | Cognitive memory system |
| `nexus` | Code intelligence surface |
| `orchestration` | Multi-agent orchestration and LOOM |
| `sessions` | Session lifecycle |
| `tasks` | Task management |
| `docs` | Document storage and retrieval |
| `cleoos` | CleoOS runtime. Still a registry tag, but ADR-098 retired the CleoOS harness; it now mostly collects the legacy `sentient` and `facade` labels |
| `worktrunk` | Git worktree management |
| `agents` | Agent profiles and execution |
| `routing` | Operation routing |
| `studio` | Web UI and dashboard |

### Type Tags (15 tags)

| Tag | Description |
|-----|-------------|
| `architecture` | Cross-cutting architectural decision |
| `architectural` | Architectural decision (preferred form) |
| `technical` | Implementation-scoped technical decision |
| `process` | Workflow or methodology decision |
| `strategic` | Long-horizon direction-setting |
| `tactical` | Short-horizon execution-level |
| `operational` | Infrastructure or deployment |
| `bugfix` | Defect correction |
| `refactor` | Internal restructuring |
| `feature` | New capability |
| `discovery` | Exploratory research |
| `migration` | Data or schema migration |
| `unification` | System consolidation |
| `bootstrap` | Initial setup or scaffolding |
| `release` | Release work (also a lifecycle tag) |

### Lifecycle Tags (8 tags — LOOM order)

1. `research` — Information gathering
2. `consensus` — Multi-agent validation
3. `design` — Architecture decisions
4. `specification` — Technical spec authoring
5. `decomposition` — Task breakdown
6. `implementation` — Code authoring
7. `validation` — Testing and verification
8. `release` — Versioning and publishing

### Priority Tags (4 tags)

`p0` > `p1` > `p2` > `p3`

### Doc-Kind Tags (9 tags)

`adr`, `spec`, `research`, `handoff`, `note`, `llmreadme`, `designmd`, `changeset`, `changelog`

## Using the Taxonomy

### In decisions

```typescript
import { TaxonomyRegistry } from '@cleocode/contracts';

// storeDecision() validates type against canonical taxonomy automatically
await storeDecision(projectRoot, {
  type: 'architectural',  // ✓ canonical type tag
  decision: 'Use PostgreSQL for primary storage',
  rationale: 'ACID compliance, JSONB support, PostGIS...',
  confidence: 'high',
});
```

Invalid types are rejected:

```
TaxonomyError: Invalid decision type 'design-pattern'.
Valid types: architecture, architectural, technical, process, ...
Use 'cleo taxonomy list --axis type' to see all valid type tags.
```

The `cleo taxonomy` command named in this message does not exist; read the
tags from `CANONICAL_TYPE_TAGS` and `TaxonomyRegistry` in
`packages/contracts/src/taxonomy.ts` (and `decisions.ts:613`).

### In task labels

Task labels (`labels_json`) can use any canonical tag. The ad-hoc label
normalization map below says which canonical tag each old label means; for
example `["sentient", "prime-tier1"]` means `["cleoos", "p0"]`.

`scripts/backfill-taxonomy.py` does not change live labels: it opens the
legacy `.cleo/tasks.db` and `.cleo/brain.db` (line 22), not `.cleo/cleo.db`.
Do not rely on it; T14609 tracks the fix.

### In documents

Document kinds use the `doc_kind` axis tags, which absorb the prior
`docs-taxonomy.ts`:

```bash
cleo docs add T1234 ./decision.md --type adr --title "Docs taxonomy"
cleo docs add T1234 ./gateway.md --type spec --slug gateway-protocol
```

Slugs follow the naming rule (D11210): no task id, session id or date. The
doc-kind registry is `BUILTIN_DOC_KINDS` in `packages/contracts/src/docs-taxonomy.ts`;
list the kinds with `cleo docs schema`.

## Migration Guide

### For existing ad-hoc labels

There is no working automatic migration for existing labels today. `scripts/backfill-taxonomy.py` does not change live labels: it opens the
legacy `.cleo/tasks.db` and `.cleo/brain.db` (line 22), not `.cleo/cleo.db`.
Do not rely on it; T14609 tracks the fix.

### For decision types

Existing BRAIN decisions use `architecture`, `technical`, `process`, `tactical`
— these ARE canonical tags (the `architecture` tag spans domain+type axes).
No migration needed.

### For code references

Replace direct references to `BRAIN_DECISION_TYPES` with `CANONICAL_TYPE_TAGS`:

```typescript
// Before:
import { BRAIN_DECISION_TYPES } from '../store/memory-schema.js';

// After:
import { CANONICAL_TYPE_TAGS } from '@cleocode/contracts';
```

## Ad-Hoc Label Normalization Map

| Ad-hoc | Canonical |
|--------|-----------|
| `sentient` | `cleoos` |
| `facade` | `cleoos` |
| `pm-core-v2` | `core` |
| `foundation` | `core` |
| `schema` | `contracts` |
| `cant`, `pi`, `cant-dsl` | `caamp` |
| `worktrunk-ssot` | `worktrunk` |
| `prime-tier1` | `p0` |
| `hygiene` | `bugfix` |
| `exploration`, `openprose` | `discovery` |
| `migrations` | `migration` |
| `wave-N`, `wave.N` | `implementation` |
| `testing` | `validation` |
| `rfc` | `specification` |

## Commands

There is no `cleo taxonomy` command, although two error messages name one
(`packages/contracts/src/taxonomy.ts:611`, `packages/core/src/memory/decisions.ts:613`).
Validation runs inside the code that writes tags: `storeDecision()` rejects a
non-canonical decision type. There is no working tool that normalizes
existing task labels (T14609).

## Architecture

```
packages/contracts/src/taxonomy.ts     ← Single source of truth
packages/core/src/memory/decisions.ts  ← Validation at creation time
scripts/backfill-taxonomy.py           ← Legacy label backfill (reads tasks.db/brain.db; T14609)
docs/reference/taxonomy.md             ← This document
```

## Related

- **T10516**: Saga — Docs CLI ergonomics and decision routing
- **T10520**: Epic — Decision-routing ergonomics
- **T11044**: Inventory of decision-store routing and help gaps
- **T11143**: Decision-to-doc routing path map
- `packages/contracts/src/docs-taxonomy.ts`: the doc-kind registry (`BUILTIN_DOC_KINDS`)
