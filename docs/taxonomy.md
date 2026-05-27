# CLEO Canonical Taxonomy (T11186)

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
| `caamp` | Cross-Agent Adaptive Messaging Protocol |
| `skills` | Agent skill definitions |
| `brain` | Cognitive memory system |
| `nexus` | Code intelligence surface |
| `orchestration` | Multi-agent orchestration and LOOM |
| `sessions` | Session lifecycle |
| `tasks` | Task management |
| `docs` | Document storage and retrieval |
| `cleoos` | CleoOS runtime and gateway |
| `worktrunk` | Git worktree management |
| `agents` | Agent profiles and execution |
| `routing` | Operation routing |
| `studio` | Web UI and dashboard |

### Type Tags (13 tags)

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

### In task labels

Task labels (`labels_json`) can use any canonical tag. The backfill script
normalizes ad-hoc labels to canonical form:

```bash
# Preview changes:
python3 scripts/backfill-taxonomy.py --dry-run

# Apply:
python3 scripts/backfill-taxonomy.py
```

Before:
```json
["sentient", "prime-tier1", "not-pi"]
```

After:
```json
["cleoos", "not-pi", "p0"]
```

### In documents

Document kinds use the `doc_kind` axis tags, which absorb the prior
`docs-taxonomy.ts`:

```bash
cleo docs add --type adr --slug t9788-docs-taxonomy
cleo docs add --type spec --slug gateway-protocol
```

## Migration Guide

### For existing ad-hoc labels

The `scripts/backfill-taxonomy.py` script handles normalization automatically.
Labels without a canonical mapping are passed through unchanged.

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

## CLI Commands

```bash
# List all canonical tags
cleo taxonomy list

# List tags by axis
cleo taxonomy list --axis type
cleo taxonomy list --axis domain
cleo taxonomy list --axis lifecycle

# Validate a tag
cleo taxonomy validate architectural  # → valid (type)
cleo taxonomy validate sentient       # → not canonical; maps to 'cleoos'

# Normalize ad-hoc labels
cleo taxonomy normalize sentient,prime-tier1,not-pi
# → cleoos, p0, not-pi

# Run backfill
python3 scripts/backfill-taxonomy.py --dry-run
python3 scripts/backfill-taxonomy.py
```

## Architecture

```
packages/contracts/src/taxonomy.ts     ← Single source of truth
packages/core/src/memory/decisions.ts  ← Validation at creation time
scripts/backfill-taxonomy.py           ← Ad-hoc → canonical normalization
docs/taxonomy.md                       ← This document
```

## Related

- **T10516**: Saga — Docs CLI ergonomics and decision routing
- **T10520**: Epic — Decision-routing ergonomics
- **T11044**: Inventory of decision-store routing and help gaps
- **T11143**: Decision-to-doc routing path map
- **docker/docs-taxonomy.ts**: Prior doc-kind registry (absorbed)
