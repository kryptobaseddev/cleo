# ADR-021: Memory Domain Refactor — Cognitive-Only Cutover

**Status**: Accepted
**Date**: 2026-03-03
**Task**: T5241
**Amends**: ADR-007, ADR-009

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context

The memory domain mixed two distinct concerns: research manifest artifacts (MANIFEST.jsonl) and brain.db cognitive memory. The `search` verb in memory operations violated VERB-STANDARDS.md's canonical `find` verb. Legacy operation aliases created documentation drift and confusion about which operations were canonical.

Specifically:
- `memory.brain.search` used the non-canonical `search` verb instead of `find`
- `memory.manifest.*` operations dealt with pipeline artifacts, not cognitive memory
- `memory.inject` was a session concern (protocol injection), not memory
- Old `memory.brain.*` prefixes added unnecessary nesting depth

---

## 2. Decision

### 2.1 Immutable Cutover Rules

1. **memory = cognitive memory ONLY** — All memory domain operations interact exclusively with brain.db (observations, decisions, patterns, learnings)
2. **pipeline = LOOM lifecycle + artifact ledger** — Manifest operations (show, list, find, pending, stats, append, archive) belong to the pipeline domain under the `manifest.*` prefix
3. **session.context.inject replaces memory.inject** — Protocol injection is a session concern, not memory
4. **Single retrieval verb: `find`** — No `search` operation anywhere in the system. The `find` verb is canonical per VERB-STANDARDS.md
5. **3-layer retrieval at memory root** — `memory.find`, `memory.timeline`, `memory.fetch` for reads; `memory.observe` for writes
6. **CLI/MCP parity** — Same domain + operation semantics across both interfaces
7. **ZERO legacy aliases** — Old operation names return `E_INVALID_OPERATION` at runtime. No backward compatibility shims.
8. **B-R-A-I-N = conceptual lens only** — The Brain/Recall/Associations/Insights/Navigation metaphor is informative but NOT a runtime model. The 10 canonical domains are the runtime contract.
9. **4 systems = product architecture overlays**:
   - BRAIN: memory (primary) + memory-linked parts of tasks/session
   - LOOM: pipeline (primary) + check + orchestrate support
   - NEXUS: nexus + sharing
   - LAFS: cross-cutting protocol over all domains
10. **registry.ts is executable SSoT** — All documentation and tooling derive from the registry, not the reverse

### 2.2 Target Operation Sets

#### memory domain (12 query + 5 mutate = 17)

| Gateway | Operation | Description | Required Params |
|---------|-----------|-------------|-----------------|
| query | show | Brain entry lookup by ID | entryId |
| query | find | Cross-table brain.db FTS5 search | query |
| query | timeline | Chronological context around anchor | anchor |
| query | fetch | Batch fetch brain entries by IDs | ids |
| query | stats | Brain.db aggregate statistics | -- |
| query | contradictions | Find contradictory entries | -- |
| query | superseded | Find superseded entries | -- |
| query | decision.find | Search decisions | -- |
| query | pattern.find | Search patterns | -- |
| query | pattern.stats | Pattern statistics | -- |
| query | learning.find | Search learnings | -- |
| query | learning.stats | Learning statistics | -- |
| mutate | observe | Save observation to brain.db | text |
| mutate | decision.store | Store decision | decision, rationale |
| mutate | pattern.store | Store pattern | pattern, context |
| mutate | learning.store | Store learning | insight, source |
| mutate | link | Link brain entry to task | taskId, entryId |

#### pipeline domain additions (5 query + 2 mutate = 7 new)

| Gateway | Operation | Description | Required Params |
|---------|-----------|-------------|-----------------|
| query | manifest.show | Get manifest entry by ID | entryId |
| query | manifest.list | List manifest entries | -- |
| query | manifest.find | Search manifest entries | query |
| query | manifest.pending | Get pending items | -- |
| query | manifest.stats | Manifest statistics | -- |
| mutate | manifest.append | Append to MANIFEST.jsonl | entry |
| mutate | manifest.archive | Archive old entries | beforeDate |

#### session domain addition (1 mutate)

| Gateway | Operation | Description | Required Params |
|---------|-----------|-------------|-----------------|
| mutate | context.inject | Inject protocol content | protocolType |

### 2.3 Removed Operations

These old operation names are dead — they return `E_INVALID_OPERATION`:

- `memory.brain.search` (replaced by `memory.find`)
- `memory.brain.timeline` (replaced by `memory.timeline`)
- `memory.brain.fetch` (replaced by `memory.fetch`)
- `memory.brain.observe` (replaced by `memory.observe`)
- `memory.pattern.search` (replaced by `memory.pattern.find`)
- `memory.learning.search` (replaced by `memory.learning.find`)
- `memory.show` (manifest version, moved to `pipeline.manifest.show`)
- `memory.list` (manifest version, moved to `pipeline.manifest.list`)
- `memory.find` (manifest version, moved to `pipeline.manifest.find`)
- `memory.pending` (moved to `pipeline.manifest.pending`)
- `memory.manifest.read` (moved to `pipeline.manifest.show`)
- `memory.manifest.append` (moved to `pipeline.manifest.append`)
- `memory.manifest.archive` (moved to `pipeline.manifest.archive`)
- `memory.inject` (moved to `session.context.inject`)

---

## 3. Consequences

### Positive
- Clear domain boundaries: memory = cognitive, pipeline = artifacts
- Verb consistency: `find` everywhere, no `search` exception
- Simpler agent instructions: no ambiguity about which ops go where
- registry.ts matches documentation exactly

### Negative
- Breaking change: all consumers of old operation names MUST update
- Temporary compilation errors during cutover window

### Neutral
- Total operation count changes from 198 to 201 (net +3 from manifest split)
- B-R-A-I-N metaphor preserved as conceptual guide in docs

---

## 4. Migration Path

The cutover follows an atomic swap pattern:

1. **Engine layer**: engine-compat.ts updated with brain.db-backed functions using `find` verb
2. **Registry**: Old operations removed, new operations registered in single commit
3. **Domain handlers**: memory.ts rewired to brain.db only; pipeline.ts gains manifest handlers; session.ts gains context.inject
4. **Tests**: All test files updated to new operation names
5. **Documentation**: ADR-007, ADR-009 amended; new constitution and flow atlas created

No deprecation period. Old names fail immediately with `E_INVALID_OPERATION`.

---

## 5. References

- ADR-007: Domain Consolidation (amended by this ADR)
- ADR-009: BRAIN Cognitive Architecture (amended by this ADR)
- VERB-STANDARDS.md: Canonical verb definitions
- CLEO-OPERATION-CONSTITUTION.md: Supersedes CLEO-OPERATIONS-REFERENCE.md
- CLEO-SYSTEM-FLOW-ATLAS.md: Visual system architecture
- T5241: BRAIN/NEXUS cognitive infrastructure task
- T5149: BRAIN Database & Cognitive Infrastructure epic

---

**END OF ADR-021**
