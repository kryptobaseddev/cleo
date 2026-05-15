# CLEO-PRIME Sentience Decomposition — Tier 3 Peer-Graph Identity + Tier 8.2 Memory-Git

**Spec status**: PLANNING ONLY — no `cleo add` invoked, no state mutated.
**Authored**: 2026-05-15 by cleo-prime (orchestrator) for owner review.
**Source plan**: `docs/plans/CLEO-PRIME-SENTIENT-MASTERPLAN.md` §5 Tier 3 (entire) + §5 Tier 8.2 + §16.A + §16.C + §16.G.
**Anti-overlap**: Tiers 1, 2, 4, 5, 6, 7, 8.1, 8.3, 9, 10, 11, 12, 13, 14 are out of scope and cited only as `depends-on:` references.

**CLEO task model recap (ADR-066)**
- Types: epic | task | subtask. Kinds: work | research | experiment | bug | spike | release.
- Severity: P0–P3. Size: small | medium | large. Sizing replaces time estimates.
- `--acceptance` REQUIRED, pipe-separated.
- Evidence atoms per ADR-051: `commit:<sha>;files:<list>`, `tool:test`, `tool:lint;tool:typecheck`, `decision:<id>;note:...`, `test-run:<json>`.

**Conventions used below**
- Every code-touching subtask carries evidence atoms appropriate to its deliverable.
- Migration subtasks always require both `commit:<sha>` + `files:<list>` AND a `tool:test` atom against the `drizzle-migrate` test suite.
- Module subtasks always require `tool:lint;tool:typecheck` plus a sibling `__tests__/<module>.test.ts` (filed as its own subtask with `tool:test`).
- IDs `E-PRIME-T03-*` and `E-PRIME-T08a-*` are placeholders — real IDs assigned at `cleo add` time.

---

# Tier Epic: E-PRIME-T03 — Peer-Graph Identity

## Epic Identity

| Field | Value |
|---|---|
| ID | `E-PRIME-T03` (placeholder) |
| Title | Peer-Graph Identity: peers · memory blocks · growing personas · drift detection · sigil/diary/skills/rapport |
| Type | `epic` |
| Kind | `work` |
| Severity | `P1` |
| Size | `large` |
| Parent | `E-PRIME-SENTIENCE` (top-level masterplan epic) |
| Depends-on | `E-PRIME-T01` (Trust Foundation), `E-PRIME-T02` (Provenance), partial `E-PRIME-T06` (Tier 6 PSYCHE evaluator emits sigil deltas — soft dep) |
| Wave | masterplan Wave 3 |
| References | §5 Tier 3.1–3.6, §16.A (corrections), §16.C (Letta v2 surface) |

## Vision

Every CANT persona becomes a first-class peer with editable memory blocks (Letta v2 surface), a mental model that grows from BRAIN queries at spawn, drift detection against the seed prompt, and a sibling identity record (sigil history · diary · skill mastery · rapport graph) — all rooted in a canonical peer-ID substrate.

## Acceptance Criteria

`canonicalPeerId() helper exists in packages/contracts/src/peer.ts and is exported | brain.db contains the 9 new tables (peers, peer_cards, peer_models, sessions, session_peers, memory_blocks, memory_block_history, sigil_history, agent_diary, agent_skills, agent_rapport) migrated forward and back without data loss | cleo peer card <id> returns non-empty rendered markdown | spawn prompt for any growth-enabled CANT agent contains both # Core Memory and # Mental Model — Living Knowledge blocks (regex assertable) | agent calling memory.edit_block('current-goal', '...') causes next briefing to reflect new content | memory_apply_patch with the 4 unified-diff headers (Add/Update/Delete/Move) atomically mutates ≥2 blocks in one tool call | after 5 sessions with growth-enabled agent, cleo agent diff <id> shows non-trivial textual diff against seed | when drift > driftAlertThreshold, sentient/events.ts emits IdentityDriftAlert and cleo agent doctor surfaces it | cleo agent reflect <id> writes a brain_agent_diary row at session-end | skill invocation updates brain_agent_skills.invocations and mastery_score | cleo agent rapport <id> returns non-empty graph from brain_agent_rapport | optimistic-lock CAS on brain_memory_blocks throws E_BLOCK_CAS_MISMATCH on stale write and writes monotonic sequence_number to history`

## Milestone Gates

| Gate | Metric | Baseline | Target |
|---|---|---|---|
| M0 | `canonicalPeerId()` exported from `@cleocode/contracts` | absent | exported, 100% callers migrated |
| M1 | Count of distinct peer rows in `brain_peers` | 0 | ≥ 3 (orchestrator + 2 workers) |
| M2 | Spawn-prompt regex `/# Core Memory/` matches | false | true on every growth-enabled spawn |
| M3 | Count of agents with non-empty `brain_memory_blocks` rows | 0 | ≥ 5 after Phase 2 lands |
| M4 | `memory_apply_patch` accepts all 4 header types in one call (test) | n/a | green |
| M5 | Drift detection emits `IdentityDriftAlert` events per 100 sessions | 0 | ≥ 1 (in seeded harness) |
| M6 | Sigil history rows per active peer per week | 0 | ≥ 1 |
| M7 | `cleo agent mastery <id>` returns non-empty rows for ≥ 1 peer | empty | populated |
| M8 | `brain_memory_block_history.sequence_number` monotonic per block | n/a | enforced by unique index + test |

## Phase Tasks

### Phase 0 — Contracts & canonicalPeerId

**Task E-PRIME-T03-P0** — Contracts groundwork for peer canonicalization
- Type: `task` · Kind: `work` · Severity: `P1` · Size: `small`
- Files: `packages/contracts/src/peer.ts`, `packages/contracts/src/index.ts`
- Depends-on: —
- Acceptance: `canonicalPeerId(input) returns deterministic ID for human/agent/external | unit tests cover all three branches plus malformed inputs | exported from packages/contracts/src/index.ts`
- Evidence atoms: `commit:<sha>;files:packages/contracts/src/peer.ts,packages/contracts/src/index.ts`, `tool:test`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P0.1 — Implement `canonicalPeerId()` helper
- Files: `packages/contracts/src/peer.ts`
- Acceptance: `function canonicalPeerId(input: { kind: PeerKind; email?: string; name?: string; provider?: string; id?: string }): string returning 'human:<email>' | 'agent:<peerKind>:<name>' | 'external:<provider>:<id>' | throws E_PEER_ID_INVALID on missing required field`
- Evidence: `commit:<sha>;files:packages/contracts/src/peer.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P0.2 — Tests for `canonicalPeerId()`
- Files: `packages/contracts/src/__tests__/peer.test.ts`
- Acceptance: `≥6 vitest cases covering human, agent, external, missing-field error, normalization (lowercase email, trim), idempotency`
- Evidence: `commit:<sha>;files:packages/contracts/src/__tests__/peer.test.ts`, `tool:test`

#### Subtask E-PRIME-T03-P0.3 — Re-export `PeerRow`, `PeerCardRow`, `PeerModelRow`, `SessionRow`, `SessionPeerRow` from contracts
- Files: `packages/contracts/src/peer.ts`, `packages/contracts/src/index.ts`
- Acceptance: `row-type interfaces match drizzle schema 1:1 | export verified by tsc --noEmit | downstream packages (core, cleo) can import without resolution errors`
- Evidence: `commit:<sha>;files:packages/contracts/src/peer.ts,packages/contracts/src/index.ts`, `tool:typecheck`

---

### Phase 1 — Peer-graph schema (drizzle migration + module)

**Task E-PRIME-T03-P1** — 5 peer-graph tables on brain.db
- Type: `task` · Kind: `work` · Severity: `P1` · Size: `medium`
- Files: `packages/core/migrations/drizzle-brain/<ts>_peer_tables/migration.sql`, `packages/core/src/store/memory-schema.ts`, `packages/core/src/memory/{peers,peer-cards,peer-tom,sessions}.ts`
- Depends-on: `E-PRIME-T03-P0`
- Acceptance: `5 tables present in brain.db post-migrate (peers, peer_cards, peer_models, sessions, session_peers) | reverse migration drops them cleanly | drizzle schema reflects table definitions exactly | unique constraint enforced on (observer, subject, dimension) for brain_peer_models`
- Evidence: `commit:<sha>;files:<migration+schema files>`, `tool:test`

#### Subtask E-PRIME-T03-P1.1 — Drizzle migration: 5 peer-graph tables (single migration folder)
- Files: `packages/core/migrations/drizzle-brain/<ts>_peer_tables/migration.sql`
- Acceptance: `migration creates brain_peers, brain_peer_cards, brain_peer_models, brain_sessions, brain_session_peers with columns + indexes + UNIQUE constraints per §5 Tier 3.1 | drizzle-kit generate diff matches schema.ts | down migration removes all 5`
- Evidence: `commit:<sha>;files:packages/core/migrations/drizzle-brain/<ts>_peer_tables/migration.sql`, `tool:test`

#### Subtask E-PRIME-T03-P1.2 — Extend `memory-schema.ts` with the 5 peer tables
- Files: `packages/core/src/store/memory-schema.ts`
- Acceptance: `drizzle table objects exported with TS types matching contracts row-types | foreign-key relations declared where applicable | bitemporal valid_from/valid_to columns on brain_peer_cards`
- Evidence: `commit:<sha>;files:packages/core/src/store/memory-schema.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P1.3 — Module `peers.ts` (CRUD + canonical-ID upsert)
- Files: `packages/core/src/memory/peers.ts`
- Acceptance: `upsertPeer(input) idempotent on canonical ID | getPeer(id) returns typed row | listPeers(filter) supports kind filter | seed_prompt_hash stored on first insert and never silently overwritten (explicit reseed function)`
- Evidence: `commit:<sha>;files:packages/core/src/memory/peers.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P1.4 — Tests for `peers.ts`
- Files: `packages/core/src/memory/__tests__/peers.test.ts`
- Acceptance: `≥5 vitest cases covering upsert idempotency, kind enum validation, seed hash immutability, list filter`
- Evidence: `commit:<sha>;files:packages/core/src/memory/__tests__/peers.test.ts`, `tool:test`

#### Subtask E-PRIME-T03-P1.5 — Module `peer-cards.ts`
- Files: `packages/core/src/memory/peer-cards.ts`
- Acceptance: `renderCard(peerId, project, dimension) returns rendered markdown | upsertCard handles bitemporal valid_to=NULL→close-out on update | embedding column populated by lazy enqueue (does not block write)`
- Evidence: `commit:<sha>;files:packages/core/src/memory/peer-cards.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P1.6 — Tests for `peer-cards.ts`
- Files: `packages/core/src/memory/__tests__/peer-cards.test.ts`
- Acceptance: `≥4 cases: upsert closes prior bitemporal row, listCards filters by (peer,project,dimension), render returns non-empty markdown, malformed dimension throws`
- Evidence: `commit:<sha>;files:packages/core/src/memory/__tests__/peer-cards.test.ts`, `tool:test`

#### Subtask E-PRIME-T03-P1.7 — Module `peer-tom.ts` (theory-of-mind beliefs)
- Files: `packages/core/src/memory/peer-tom.ts`
- Acceptance: `upsertBelief(observer, subject, dimension, value, confidence) respects UNIQUE constraint | listBeliefs(observerId) returns paginated rows | confidence ∈ [0,1] validation`
- Evidence: `commit:<sha>;files:packages/core/src/memory/peer-tom.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P1.8 — Tests for `peer-tom.ts`
- Files: `packages/core/src/memory/__tests__/peer-tom.test.ts`
- Acceptance: `≥4 cases including UNIQUE constraint enforcement on (observer,subject,dimension), confidence range validation`
- Evidence: `commit:<sha>;files:packages/core/src/memory/__tests__/peer-tom.test.ts`, `tool:test`

#### Subtask E-PRIME-T03-P1.9 — Module `sessions.ts` (multi-peer sessions + junction)
- Files: `packages/core/src/memory/sessions.ts`
- Acceptance: `openSession({peers, project}) returns session row, inserts junction rows per peer with role+timeStart | closeSession(id) sets ended_at + junction timeEnd for all active peers | listSessions(peerId) returns participation history`
- Evidence: `commit:<sha>;files:packages/core/src/memory/sessions.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P1.10 — Tests for `sessions.ts`
- Files: `packages/core/src/memory/__tests__/sessions.test.ts`
- Acceptance: `≥5 cases including multi-peer open/close, idempotent close, listSessions ordering by recency`
- Evidence: `commit:<sha>;files:packages/core/src/memory/__tests__/sessions.test.ts`, `tool:test`

#### Subtask E-PRIME-T03-P1.11 — Adopt `parent_session_id` lineage chain (Hermes-Agent §16.B steal)
- Files: `packages/core/src/store/memory-schema.ts`, `packages/core/src/memory/sessions.ts`, sibling migration column add
- Acceptance: `brain_sessions.parent_session_id (TEXT NULLable, FK to brain_sessions.id) added | sessions.ts honors parent on open() | tests cover orphan + chain-depth-3 traversal`
- Evidence: `commit:<sha>;files:<schema+module>`, `tool:test`

#### Subtask E-PRIME-T03-P1.12 — Migrate existing `peerId='global'` defaults to canonical IDs (data backfill script, dry-run by default)
- Files: `packages/core/scripts/backfill-peer-ids.mjs`, `packages/core/scripts/__tests__/backfill-peer-ids.test.mjs`
- Acceptance: `--dry-run prints proposed rewrites without writing | --apply executes inside single TX | idempotent on re-run | reports count by table | covers all writer tables enumerated in §13`
- Evidence: `commit:<sha>;files:<script+tests>`, `tool:test`

---

### Phase 2 — Memory blocks (Letta v2 surface)

**Task E-PRIME-T03-P2** — `brain_memory_blocks` + 5 memory tools + `memory_apply_patch`
- Type: `task` · Kind: `work` · Severity: `P1` · Size: `large`
- Files: `packages/core/migrations/drizzle-brain/<ts>_memory_blocks/migration.sql`, `packages/core/src/memory/{memory-blocks,memory-patch}.ts`, `packages/core/src/llm/{role-executor,tool-loop}.ts`
- Depends-on: `E-PRIME-T03-P1`
- Acceptance: `13-column brain_memory_blocks + brain_memory_block_history present | optimistic lock throws E_BLOCK_CAS_MISMATCH | history sequence_number monotonic + UNIQUE per block_id | all 5 v2 tools callable through CANT toolset | memory_apply_patch parses all 4 header types (Add/Update/Delete/Move to) in one call`
- Evidence: `commit:<sha>;files:<list>`, `tool:test`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.1 — Drizzle migration: `brain_memory_blocks` (13 columns) + `brain_memory_block_history` (with `sequence_number` UNIQUE index per `block_id`)
- Files: `packages/core/migrations/drizzle-brain/<ts>_memory_blocks/migration.sql`
- Acceptance: `13 columns of brain_memory_blocks present per §5 Tier 3.2 schema verbatim | history table includes sequence_number INTEGER NOT NULL + UNIQUE(block_id, sequence_number) | UNIQUE(peer_id,project,label) on blocks | down migration drops both`
- Evidence: `commit:<sha>;files:<migration>`, `tool:test`

#### Subtask E-PRIME-T03-P2.2 — Extend `memory-schema.ts` with both tables
- Files: `packages/core/src/store/memory-schema.ts`
- Acceptance: `drizzle definitions match SQL 1:1 | exported types match contracts re-exports`
- Evidence: `commit:<sha>;files:packages/core/src/store/memory-schema.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.3 — Module `memory-blocks.ts` (CRUD scaffold + label kind validation)
- Files: `packages/core/src/memory/memory-blocks.ts`
- Acceptance: `getBlock(peerId, label) returns typed row or null | listBlocks(peerId, project) returns ordered set | label kind validator accepts persona/human/project/current-goal/open-questions/recent-decisions/scratchpad/shared:<topic>`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-blocks.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.4 — Optimistic-lock CAS + monotonic history chain (§16.C)
- Files: `packages/core/src/memory/memory-blocks.ts` (CAS + writeHistory in single TX)
- Acceptance: `writeBlock(prev_version, new_content) throws E_BLOCK_CAS_MISMATCH when prev_version !== current.version | history row inserted in same TX with sequence_number = (max for block_id) + 1 | prev_value column captures pre-write content | reason column populated from caller arg`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-blocks.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.5 — Tests for CAS + history chain
- Files: `packages/core/src/memory/__tests__/memory-blocks.test.ts`
- Acceptance: `≥8 cases: insert, read, edit-bumps-version, CAS-mismatch-throws, append-auto-truncates, history-sequence-monotonic, history-sequence-unique-per-block, concurrent-edit-loser-throws`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P2.6 — Tool `memory.read_blocks()`
- Files: `packages/core/src/memory/memory-tools.ts`
- Acceptance: `returns Map<label, content> for current peer | no LLM call | respects locked column (still returns) | unit test covers empty + multi-block`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-tools.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.7 — Tool `memory.edit_block(label, new_content)` (delegates to CAS path)
- Files: `packages/core/src/memory/memory-tools.ts`
- Acceptance: `writes a brain_observations row with type='memory-edit' | uses current version as CAS guard | rejects on locked=1`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-tools.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.8 — Tool `memory.append_block(label, delta)` (auto-truncate oldest lines)
- Files: `packages/core/src/memory/memory-tools.ts`
- Acceptance: `appends delta, truncates from top to max_size_tokens (default 2000) | always safe under concurrency (no CAS required, retry on conflict) | observation type='memory-append'`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-tools.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.9 — Tool `memory.search_archival(query, limit?, peer_scope?)` (vector + BM25 over BRAIN)
- Files: `packages/core/src/memory/memory-tools.ts`
- Acceptance: `dispatches to existing brain-search.ts | respects peer_scope (own | shared | global) | returns ≤ limit rows ranked by hybrid score`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-tools.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.10 — Tool `memory.recall_messages(filter)` (filters `brain_observations`)
- Files: `packages/core/src/memory/memory-tools.ts`
- Acceptance: `filters by peerId, type, sinceTs, limit | returns chronological order | no LLM call`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-tools.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.11 — Tests for the 5 memory tools (one test file, all 5 covered)
- Files: `packages/core/src/memory/__tests__/memory-tools.test.ts`
- Acceptance: `each of 5 tools has ≥2 cases (happy + error) | concurrency: append racing edit does not corrupt`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P2.12 — `memory_apply_patch` parser — 4 unified-diff headers
- Files: `packages/core/src/memory/memory-patch.ts`
- Acceptance: `parseMemoryPatch(text) recognizes *** Add Block:, *** Update Block:, *** Delete Block:, *** Move to: | returns array of typed patch ops | rejects malformed/duplicate block IDs in same patch | line-level error reporting`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-patch.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.13 — `memory_apply_patch` applier (atomic multi-block TX)
- Files: `packages/core/src/memory/memory-patch.ts`
- Acceptance: `applies all parsed ops in single SQLite TX | per-op CAS where applicable | rolls back entire patch on any failure | writes one brain_observations row of type='memory-patch' summarizing the patch`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-patch.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.14 — Tests for `memory_apply_patch`
- Files: `packages/core/src/memory/__tests__/memory-patch.test.ts`
- Acceptance: `≥10 cases: parse-each-header, parse-mixed, parse-malformed, apply-add, apply-update-CAS-fail-rolls-back, apply-delete, apply-move, atomicity-on-failure, idempotency-on-replay-rejected, sequence_number-bumped-once-per-block`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P2.15 — Memory toolset binding for CANT — `buildMemoryToolset(peerId, project)`
- Files: `packages/core/src/llm/role-executor.ts`
- Acceptance: `returns toolset including read_blocks, edit_block, append_block, search_archival, recall_messages, memory_apply_patch | peerId baked into closures | gated by CANT tool permissions`
- Evidence: `commit:<sha>;files:packages/core/src/llm/role-executor.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.16 — Dispatch `memory.*` tool calls in tool-loop
- Files: `packages/core/src/llm/tool-loop.ts`
- Acceptance: `name-prefixed memory.* calls routed to bound toolset | structured errors surfaced with code (E_BLOCK_CAS_MISMATCH, E_BLOCK_LOCKED, E_MEMORY_PATCH_PARSE) | existing non-memory tool dispatch untouched`
- Evidence: `commit:<sha>;files:packages/core/src/llm/tool-loop.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.17 — Tests: tool-loop dispatch of memory tools (round-trip)
- Files: `packages/core/src/llm/__tests__/tool-loop-memory.test.ts`
- Acceptance: `≥4 cases: edit_block dispatched → row inserted, CAS error surfaces to caller, memory_apply_patch dispatched atomically, unknown memory.* tool returns E_UNKNOWN_TOOL`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P2.18 — Inject `# Core Memory` block into spawn briefing
- Files: `packages/core/src/sessions/briefing.ts`
- Acceptance: `briefing for any peer with rows in brain_memory_blocks contains a # Core Memory section listing labelled blocks in canonical order (persona, human, project, current-goal, open-questions, recent-decisions, scratchpad, then shared:* alphabetical) | regex /# Core Memory\n/ matches`
- Evidence: `commit:<sha>;files:packages/core/src/sessions/briefing.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P2.19 — Tests: spawn-briefing contains Core Memory block
- Files: `packages/core/src/sessions/__tests__/briefing-core-memory.test.ts`
- Acceptance: `≥3 cases: peer with all kinds, peer with subset, peer with zero blocks (no section emitted)`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

---

### Phase 3 — CANT growth + spawn-time mental-model resolution

**Task E-PRIME-T03-P3** — `CantMentalModelRef.growth` field + spawn-time resolution
- Type: `task` · Kind: `work` · Severity: `P1` · Size: `medium`
- Files: `packages/cant/src/{types,parse,composer,mental-model}.ts`
- Depends-on: `E-PRIME-T03-P2`
- Acceptance: `CantMentalModelRef.growth typed per §5 Tier 3.3 | parser accepts growth: subblock | composer resolves at spawn time | mental-model.ts exposes resolveGrowthQueries | backwards-compat: agents without growth unchanged`
- Evidence: `commit:<sha>;files:<list>`, `tool:test`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P3.1 — `packages/cant/src/types.ts` — add `growth?: { enabled, sourceQueries, consolidationInterval, driftAlertThreshold, seedPromptHash? }` + `CantBrainQuery`
- Files: `packages/cant/src/types.ts`
- Acceptance: `types match §5 Tier 3.3 verbatim | CantBrainQuery enumerates table, filter, limit, rankBy, embeddingTarget | growth is optional`
- Evidence: `commit:<sha>;files:packages/cant/src/types.ts`, `tool:typecheck`

#### Subtask E-PRIME-T03-P3.2 — Tests: `types.ts` compile-time guards
- Files: `packages/cant/src/__tests__/types-growth.test.ts`
- Acceptance: `≥3 cases via tsd-style assertion: growth optional, sourceQueries required when growth.enabled, BrainCognitiveType enum exhausts`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P3.3 — `packages/cant/src/parse.ts` — parse `growth:` subblock
- Files: `packages/cant/src/parse.ts`
- Acceptance: `growth: subblock recognized inside mentalModelRef: | sourceQueries: array parsed | unknown growth.* fields produce structured CantParseError`
- Evidence: `commit:<sha>;files:packages/cant/src/parse.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P3.4 — Tests: `parse.ts` growth subblock
- Files: `packages/cant/src/__tests__/parse-growth.test.ts`
- Acceptance: `≥5 cases: full growth block, growth.enabled=false stub, missing sourceQueries when enabled (error), unknown key (error), no-growth backwards-compat`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P3.5 — `packages/cant/src/composer.ts` — spawn-time growth resolution
- Files: `packages/cant/src/composer.ts`
- Acceptance: `if growth.enabled, composer calls resolveGrowthQueries(growth, peerId, project) | renders results as # Mental Model — Living Knowledge block | hashes rendered content → returns mentalModelDigest | agents without growth return unchanged prompt`
- Evidence: `commit:<sha>;files:packages/cant/src/composer.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P3.6 — Tests: composer growth resolution
- Files: `packages/cant/src/__tests__/composer-growth.test.ts`
- Acceptance: `≥4 cases: growth-disabled passthrough, growth-enabled renders block, digest hash deterministic, sourceQueries=empty yields empty block`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P3.7 — `packages/cant/src/mental-model.ts` — `resolveGrowthQueries(growth, peerId, project)`
- Files: `packages/cant/src/mental-model.ts`
- Acceptance: `dispatches each CantBrainQuery against brain via context-provider-brain | applies minConfidence, sinceDays, tags, roleMatch filters | rankBy honored (recency, retrievalCount, confidence, embedding) | respects limit per query`
- Evidence: `commit:<sha>;files:packages/cant/src/mental-model.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P3.8 — Tests: `resolveGrowthQueries`
- Files: `packages/cant/src/__tests__/mental-model-resolve.test.ts`
- Acceptance: `≥6 cases: each table (observations/learnings/patterns/decisions), each rankBy, peerId=@self resolution, limit honored, empty result, malformed filter rejected`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

---

### Phase 4 — Identity drift detection

**Task E-PRIME-T03-P4** — `persona-evolution.ts` + drift event + CLI
- Type: `task` · Kind: `work` · Severity: `P2` · Size: `medium`
- Files: `packages/core/src/agents/persona-evolution.ts`, `packages/core/src/sentient/events.ts`
- Depends-on: `E-PRIME-T03-P3`
- Acceptance: `drift = 1 − cosineSimilarity(current, seed) computed post-session | IdentityDriftAlert emitted when drift > driftAlertThreshold | cleo agent diff <id> shows seed vs current rendered persona`
- Evidence: `commit:<sha>;files:<list>`, `tool:test`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P4.1 — `persona-evolution.ts` — re-render + embed + cosine compare
- Files: `packages/core/src/agents/persona-evolution.ts`
- Acceptance: `evaluateDrift(peerId) returns {drift: number, currentDigest, seedDigest, threshold} | uses brain-embedding.ts for vectors | no side effects (pure compute)`
- Evidence: `commit:<sha>;files:packages/core/src/agents/persona-evolution.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P4.2 — Tests: drift compute correctness
- Files: `packages/core/src/agents/__tests__/persona-evolution.test.ts`
- Acceptance: `≥5 cases: identical content drift=0, totally different ≈1, threshold-exceeded triggers emit (with spy), missing seed throws E_DRIFT_NO_SEED, threshold default = 0.3`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P4.3 — `sentient/events.ts` — `IdentityDriftAlert` variant
- Files: `packages/core/src/sentient/events.ts`
- Acceptance: `IdentityDriftAlert variant added with {peerId, drift, threshold, currentDigest, seedDigest, observedAt} | discriminated union exhaustiveness check passes`
- Evidence: `commit:<sha>;files:packages/core/src/sentient/events.ts`, `tool:typecheck`

#### Subtask E-PRIME-T03-P4.4 — Wire post-session drift check into session-close hook
- Files: `packages/core/src/sessions/close.ts` (or equivalent; add new module if absent)
- Acceptance: `growth-enabled agent session close triggers evaluateDrift in fire-and-forget worker | does not block close on error | structured log on emit`
- Evidence: `commit:<sha>;files:<file>`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P4.5 — Tests: post-session drift hook
- Files: `packages/core/src/sessions/__tests__/close-drift.test.ts`
- Acceptance: `≥3 cases: close emits event when drift exceeds threshold, no emit when under, close does not throw on evaluate error`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

---

### Phase 5 — Sibling identity tables: sigil · diary · skills · rapport

**Task E-PRIME-T03-P5** — 4 sibling tables + 4 modules
- Type: `task` · Kind: `work` · Severity: `P2` · Size: `large`
- Files: 1 migration folder, 4 modules under `packages/core/src/memory/`
- Depends-on: `E-PRIME-T03-P1`
- Acceptance: `4 tables created + 4 modules cover ingest + read | sigil hooked into dialectic evaluator (Tier 6 soft-dep; if Tier 6 not ready, dispatch via direct call from manual cleo agent reflect) | skills updated on invocation outcome | rapport recorded on handoff/review/spawn-child/consensus events`
- Evidence: `commit:<sha>;files:<list>`, `tool:test`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P5.1 — Drizzle migration: 4 sibling tables
- Files: `packages/core/migrations/drizzle-brain/<ts>_identity_tables/migration.sql`
- Acceptance: `brain_sigil_history, brain_agent_diary, brain_agent_skills, brain_agent_rapport created per §5 Tier 3.5 verbatim | UNIQUE(peer_id, skill_id) on brain_agent_skills | down migration drops all 4`
- Evidence: `commit:<sha>;files:<migration>`, `tool:test`

#### Subtask E-PRIME-T03-P5.2 — Extend `memory-schema.ts` with the 4 sibling tables
- Files: `packages/core/src/store/memory-schema.ts`
- Acceptance: `4 drizzle tables exported, types match contracts re-exports`
- Evidence: `commit:<sha>;files:packages/core/src/store/memory-schema.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P5.3 — Module `sigil-history.ts`
- Files: `packages/core/src/memory/sigil-history.ts`
- Acceptance: `recordSnapshot(peerId, snapshot, delta?, trigger) appends row | listHistory(peerId) returns reverse-chrono | delta_json defaults to null when no prior snapshot`
- Evidence: `commit:<sha>;files:<file>`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P5.4 — Tests: `sigil-history.ts`
- Files: `packages/core/src/memory/__tests__/sigil-history.test.ts`
- Acceptance: `≥4 cases including first snapshot has null delta, trigger enum validated, listHistory ordering`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P5.5 — Module `agent-diary.ts`
- Files: `packages/core/src/memory/agent-diary.ts`
- Acceptance: `writeEntry(peerId, sessionId, content, diary_type, confidence) inserts row | confidence ∈ [0,1] | listEntries(peerId, filter) supports diary_type filter`
- Evidence: `commit:<sha>;files:<file>`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P5.6 — Tests: `agent-diary.ts`
- Files: `packages/core/src/memory/__tests__/agent-diary.test.ts`
- Acceptance: `≥4 cases including diary_type enum, confidence validation, validated_at write+read`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P5.7 — Module `agent-skills.ts` (mastery counters)
- Files: `packages/core/src/memory/agent-skills.ts`
- Acceptance: `recordInvocation(peerId, skillId, outcome) updates invocations + (successes | failures) + recomputes mastery_score using EWMA over recent N | listSkills(peerId) ordered by mastery_score desc`
- Evidence: `commit:<sha>;files:<file>`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P5.8 — Tests: `agent-skills.ts`
- Files: `packages/core/src/memory/__tests__/agent-skills.test.ts`
- Acceptance: `≥5 cases including mastery formula stability, UNIQUE(peer,skill) enforcement, failure-then-success raises score, listSkills ordering`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P5.9 — Module `agent-rapport.ts`
- Files: `packages/core/src/memory/agent-rapport.ts`
- Acceptance: `recordInteraction(actor, observed, interaction_type, outcome) inserts row | aggregateRapport(peerId) returns map of observed→{accepted, rejected, partial} counts | interaction_type enum validated`
- Evidence: `commit:<sha>;files:<file>`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P5.10 — Tests: `agent-rapport.ts`
- Files: `packages/core/src/memory/__tests__/agent-rapport.test.ts`
- Acceptance: `≥4 cases including enum validation, aggregation correctness, empty-result safety`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P5.11 — Hook: skill invocation → `agent-skills.recordInvocation` (via tool-loop completion callback)
- Files: `packages/core/src/llm/tool-loop.ts`
- Acceptance: `every tool invocation that maps to a skill ID emits recordInvocation with outcome derived from tool-call result | no skill_id → no-op`
- Evidence: `commit:<sha>;files:packages/core/src/llm/tool-loop.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P5.12 — Hook: spawn/handoff/review/consensus → `agent-rapport.recordInteraction`
- Files: `packages/core/src/orchestrate/spawn-ops.ts`, `packages/core/src/conduit/ops.ts`
- Acceptance: `each of 4 events writes one rapport row | actor/observed inferred from envelope | outcome inferred from terminal state`
- Evidence: `commit:<sha>;files:<files>`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P5.13 — Tests: spawn/handoff/review/consensus rapport hooks
- Files: `packages/core/src/orchestrate/__tests__/rapport-hooks.test.ts`
- Acceptance: `≥4 cases — one per interaction_type, asserting row inserted with correct outcome`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

---

### Phase 6 — CLI surface (peer · agent · memory extensions)

**Task E-PRIME-T03-P6** — New `cleo peer` command + extensions to `cleo agent` and `cleo memory`
- Type: `task` · Kind: `work` · Severity: `P2` · Size: `medium`
- Files: `packages/cleo/src/cli/commands/peer.ts`, extensions to `agent.ts` + `memory.ts`
- Depends-on: `E-PRIME-T03-P5`
- Acceptance: `cleo peer (list|card|beliefs|activity) green | cleo agent (diff|reflect|mastery|rapport|doctor) green | cleo memory (blocks|edit|log|block read|block append|block replace|block summarize) green | all dispatch through LAFS envelopes`
- Evidence: `commit:<sha>;files:<list>`, `tool:test`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.1 — `cleo peer list`
- Files: `packages/cleo/src/cli/commands/peer.ts`
- Acceptance: `--kind filter | JSON + human modes | returns canonical IDs`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/peer.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.2 — `cleo peer card <id>`
- Files: `packages/cleo/src/cli/commands/peer.ts`
- Acceptance: `returns rendered card markdown for default dimension | --dimension flag | --project flag | empty returns structured null, not error`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/peer.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.3 — `cleo peer beliefs <id>`
- Files: `packages/cleo/src/cli/commands/peer.ts`
- Acceptance: `lists ToM beliefs where observer=id (default) | --as-subject flips to subject-side`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/peer.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.4 — `cleo peer activity <id>`
- Files: `packages/cleo/src/cli/commands/peer.ts`
- Acceptance: `lists session participation | --limit + --since flags`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/peer.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.5 — Tests: `cleo peer` (all 4 subcommands)
- Files: `packages/cleo/src/cli/commands/__tests__/peer.test.ts`
- Acceptance: `≥6 cases covering happy paths + missing peer error envelope`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P6.6 — `cleo agent diff <id>` (seed vs current)
- Files: `packages/cleo/src/cli/commands/agent.ts`
- Acceptance: `prints unified-diff style output between rendered seed and current persona | --json mode`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/agent.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.7 — `cleo agent reflect <id>` (write diary entry)
- Files: `packages/cleo/src/cli/commands/agent.ts`
- Acceptance: `invokes reflection prompt via role-executor, writes brain_agent_diary row | --type flag chooses diary_type | --confidence flag (default 0.7)`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/agent.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.8 — `cleo agent mastery <id>`
- Files: `packages/cleo/src/cli/commands/agent.ts`
- Acceptance: `lists skills with mastery_score desc | --min-score filter | shows invocations/successes/failures`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/agent.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.9 — `cleo agent rapport <id>`
- Files: `packages/cleo/src/cli/commands/agent.ts`
- Acceptance: `outputs rapport graph (text table + JSON) | --observed-as-actor flips direction`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/agent.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.10 — `cleo agent doctor <id>` (surfaces IdentityDriftAlert + missing-seed + skill outliers)
- Files: `packages/cleo/src/cli/commands/agent.ts`
- Acceptance: `checks: seed exists, drift below threshold, ≥1 active memory block, ≥1 diary entry in past 7 days | each check pass/fail/skip with remediation hint`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/agent.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.11 — Tests: `cleo agent` extensions (5 new subcommands)
- Files: `packages/cleo/src/cli/commands/__tests__/agent-identity.test.ts`
- Acceptance: `≥10 cases, ≥2 per subcommand`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P6.12 — `cleo memory block read --peer <id> --label <l>`
- Files: `packages/cleo/src/cli/commands/memory.ts`
- Acceptance: `prints block content with version + last-updated | --json mode | missing returns LAFS error envelope`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/memory.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.13 — `cleo memory block append --peer <id> --label <l> --content <t>`
- Files: `packages/cleo/src/cli/commands/memory.ts`
- Acceptance: `appends, prints new version + truncation report`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/memory.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.14 — `cleo memory block replace --peer <id> --label <l> --old <s> --new <s>`
- Files: `packages/cleo/src/cli/commands/memory.ts`
- Acceptance: `enforces CAS via --old | E_BLOCK_CAS_MISMATCH surfaces with remediation hint`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/memory.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.15 — `cleo memory block summarize --peer <id> --label <l> --max <n>`
- Files: `packages/cleo/src/cli/commands/memory.ts`
- Acceptance: `LLM-driven compaction via executeForRole('consolidation') | dry-run by default; --apply persists | preserves frontmatter`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/memory.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P6.16 — Tests: `cleo memory block *` (4 subcommands)
- Files: `packages/cleo/src/cli/commands/__tests__/memory-block.test.ts`
- Acceptance: `≥8 cases, ≥2 per subcommand including CAS-mismatch path`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

---

### Phase 7 — Acceptance gate harness + green-on-build

**Task E-PRIME-T03-P7** — Wire epic acceptance into a single end-to-end test
- Type: `task` · Kind: `work` · Severity: `P1` · Size: `small`
- Files: `packages/core/src/__tests__/e2e/peer-graph-identity.e2e.test.ts`
- Depends-on: `E-PRIME-T03-P6`
- Acceptance: `single test exercises: spawn growth-enabled agent → memory_apply_patch adds two blocks → close session → cleo peer card returns non-empty → drift compute returns ≤ threshold (seed) | cleo agent reflect writes diary row | skill invocation updates mastery | rapport row written on handoff`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P7.1 — Author the e2e test
- Files: `packages/core/src/__tests__/e2e/peer-graph-identity.e2e.test.ts`
- Acceptance: `all 8 acceptance criteria of the epic asserted in one file | seeded fixture brain.db | cleanup on teardown`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T03-P7.2 — Add `brain-doctor` job entry for new tables (defer wiring of CI workflow to Tier 1 §6.2 — depends-on cite only)
- Files: `packages/core/src/memory/brain-doctor.ts`
- Acceptance: `brain-doctor checks include: brain_peers row count > 0, brain_memory_blocks UNIQUE constraint integrity, brain_memory_block_history sequence_number monotonic per block_id`
- Evidence: `commit:<sha>;files:packages/core/src/memory/brain-doctor.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T03-P7.3 — Tests for new `brain-doctor` checks
- Files: `packages/core/src/memory/__tests__/brain-doctor-identity.test.ts`
- Acceptance: `≥3 cases: passes on healthy db, fails on missing peers, fails on broken sequence chain`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

---

# Tier Epic: E-PRIME-T08a — Memory-Git Per Peer

## Epic Identity

| Field | Value |
|---|---|
| ID | `E-PRIME-T08a` (placeholder) |
| Title | Memory-Git: per-peer git repo for memory-block history |
| Type | `epic` |
| Kind | `work` |
| Severity | `P2` |
| Size | `medium` |
| Parent | `E-PRIME-SENTIENCE` |
| Depends-on | `E-PRIME-T03` (memory blocks must exist) |
| Wave | masterplan Wave 4 |
| References | §5 Tier 8.2, §16.G (Letta uses MemFS not git — CLEO uses git intentionally; aligns with ADR-062 merge-not-cherry-pick) |

## Vision

Every peer keeps a versioned git history of its memory blocks at `~/.local/share/cleo/memory-versions/<peer-id>/`, with subagent branches that merge (not cherry-pick) back to the parent peer's main on phase-lead aggregation — same discipline as ADR-062 for code worktrees.

## Acceptance Criteria

`packages/core/src/memory/memory-git.ts exists with 6 exported operations | every brain_memory_blocks write fires async commitSnapshot | per-peer repo created lazily under ~/.local/share/cleo/memory-versions/<peer-id>/ | subagent spawn sets MEMORY_GIT_BRANCH=subagent-<id> in env | phase-lead aggregation calls mergeSubagent which does git merge --no-ff (NOT cherry-pick) | cleo memory log <peer> shows git-style history | cleo memory diff <peer> <sha1> <sha2> shows block-level diff | cleo memory revert <peer> <sha> restores DB state to that snapshot | revert is auditable via brain_observations row of type='memory-revert' | repo size ≤ 5 MB per peer per year on synthetic 1-year load`

## Milestone Gates

| Gate | Metric | Baseline | Target |
|---|---|---|---|
| M0 | `memory-git.ts` exported from `@cleocode/core` | absent | exported with 6 ops |
| M1 | `cleo memory log <peer>` returns ≥ 1 commit per active peer | 0 | ≥ 1 per active peer |
| M2 | Memory-git commit count per peer per week | 0 | ≥ 5 (one per session) |
| M3 | Subagent merge: zero cherry-pick calls in code path | n/a | grep audit returns 0 |
| M4 | Storage per peer per year (synthetic test) | n/a | ≤ 5 MB |
| M5 | Revert end-to-end: DB state matches git snapshot | n/a | bit-for-bit on labelled blocks |

## Phase Tasks

### Phase 0 — Module scaffold + lazy repo init

**Task E-PRIME-T08a-P0** — Memory-git module scaffold + lazy `initPeerRepo`
- Type: `task` · Kind: `work` · Severity: `P2` · Size: `small`
- Files: `packages/core/src/memory/memory-git.ts`
- Depends-on: `E-PRIME-T03-P2`
- Acceptance: `initPeerRepo(peerId) creates ~/.local/share/cleo/memory-versions/<canonicalPeerId>/ on first call | sets git config user.name=cleo-memory + user.email=memory@cleocode.local | idempotent`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-git.ts`, `tool:test`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P0.1 — Module scaffold + `initPeerRepo(peerId)`
- Files: `packages/core/src/memory/memory-git.ts`
- Acceptance: `path resolution uses env-paths canonical layout (matches worktree convention) | shell out to git via execa | atomic on race`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-git.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P0.2 — Tests for `initPeerRepo`
- Files: `packages/core/src/memory/__tests__/memory-git-init.test.ts`
- Acceptance: `≥4 cases: first init creates repo, second init no-op, malformed peerId rejected, path traversal blocked`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

---

### Phase 1 — Snapshot + diff + revert ops

**Task E-PRIME-T08a-P1** — `commitSnapshot`, `diffBlocks`, `revertPeer`
- Type: `task` · Kind: `work` · Severity: `P2` · Size: `medium`
- Files: `packages/core/src/memory/memory-git.ts`
- Depends-on: `E-PRIME-T08a-P0`
- Acceptance: `commitSnapshot writes one .md file per block + commits | diffBlocks(peerId, sha1, sha2) returns block-level diff via git diff | revertPeer(peerId, sha) checks out tree + replays into DB via memory-blocks.writeBlock with CAS bypass + writes brain_observations row type='memory-revert'`
- Evidence: `commit:<sha>;files:<list>`, `tool:test`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P1.1 — `commitSnapshot(peerId, blocks)`
- Files: `packages/core/src/memory/memory-git.ts`
- Acceptance: `writes blocks/<label>.md per block with frontmatter (peer, version, updated_at) | commits with message memory-snapshot: <reason or 'auto'> | trailers include Peer-Id + Trigger`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-git.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P1.2 — Tests for `commitSnapshot`
- Files: `packages/core/src/memory/__tests__/memory-git-snapshot.test.ts`
- Acceptance: `≥4 cases: first snapshot, repeat snapshot with no changes is empty commit or skip, frontmatter shape, trailer presence`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T08a-P1.3 — `diffBlocks(peerId, sha1, sha2)`
- Files: `packages/core/src/memory/memory-git.ts`
- Acceptance: `returns { byLabel: Map<label, unifiedDiff>, summary: { added, modified, deleted } } | sha1='HEAD~1' default | handles missing sha with structured error`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-git.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P1.4 — Tests for `diffBlocks`
- Files: `packages/core/src/memory/__tests__/memory-git-diff.test.ts`
- Acceptance: `≥4 cases: added block, modified block, deleted block, no-change`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T08a-P1.5 — `revertPeer(peerId, sha)`
- Files: `packages/core/src/memory/memory-git.ts`
- Acceptance: `git checkout tree of <sha> into temp | parses each blocks/<label>.md | writes via memory-blocks API with system_updated_by='memory-git:revert:<sha>' | logs brain_observations row type='memory-revert' | rolls back on any failure`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-git.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P1.6 — Tests for `revertPeer`
- Files: `packages/core/src/memory/__tests__/memory-git-revert.test.ts`
- Acceptance: `≥4 cases: revert restores prior state, audit observation written, missing sha → structured error, mid-revert failure rolls back atomically`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

---

### Phase 2 — Subagent branching + ADR-062 merge

**Task E-PRIME-T08a-P2** — `subagentBranch` + `mergeSubagent` (merge --no-ff, NOT cherry-pick)
- Type: `task` · Kind: `work` · Severity: `P2` · Size: `medium`
- Files: `packages/core/src/memory/memory-git.ts`, `packages/core/src/orchestrate/spawn-ops.ts`, `packages/core/src/orchestrate/wave-rollup.ts`
- Depends-on: `E-PRIME-T08a-P1`
- Acceptance: `subagentBranch(peerId, subagentId) creates subagent-<id> branch off main | spawn-ops injects MEMORY_GIT_BRANCH env var | mergeSubagent(peerId, branch) runs git merge --no-ff (audited: grep returns zero cherry-pick) | wave-rollup aggregates per-subagent branches at phase-lead`
- Evidence: `commit:<sha>;files:<list>`, `tool:test`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P2.1 — `subagentBranch(peerId, subagentId)`
- Files: `packages/core/src/memory/memory-git.ts`
- Acceptance: `branch name = subagent-<subagentId> | starts from current main HEAD | idempotent | returns branch ref`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-git.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P2.2 — Tests for `subagentBranch`
- Files: `packages/core/src/memory/__tests__/memory-git-branch.test.ts`
- Acceptance: `≥3 cases: branch created, idempotent re-call, malformed subagentId rejected`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T08a-P2.3 — `mergeSubagent(peerId, branch)` using `git merge --no-ff` (ADR-062)
- Files: `packages/core/src/memory/memory-git.ts`
- Acceptance: `runs git merge --no-ff <branch> on main | NO call to git cherry-pick anywhere in code path (CI grep guard) | structured conflict envelope on merge conflict (no auto-resolve) | deletes branch on success`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-git.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P2.4 — Tests for `mergeSubagent`
- Files: `packages/core/src/memory/__tests__/memory-git-merge.test.ts`
- Acceptance: `≥5 cases: clean fast-forward-avoided (--no-ff), conflict surfaces envelope, branch deleted on success, branch retained on failure, grep audit confirms zero cherry-pick`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T08a-P2.5 — Spawn-ops injects `MEMORY_GIT_BRANCH=subagent-<id>` into subagent env
- Files: `packages/core/src/orchestrate/spawn-ops.ts`
- Acceptance: `every subagent spawn calls subagentBranch first | MEMORY_GIT_BRANCH set in injected env | --no-worktree spawn (CLI flag) also skips memory-git branching | logged in spawn audit`
- Evidence: `commit:<sha>;files:packages/core/src/orchestrate/spawn-ops.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P2.6 — Tests: spawn-ops branch injection
- Files: `packages/core/src/orchestrate/__tests__/spawn-memory-branch.test.ts`
- Acceptance: `≥3 cases: branch env set, --no-worktree skips, branch ref appears in audit log`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T08a-P2.7 — `wave-rollup` calls `mergeSubagent` on phase-lead aggregation
- Files: `packages/core/src/orchestrate/wave-rollup.ts`
- Acceptance: `rollup walks subagent set | merges each subagent branch back to parent main | aborts wave on any conflict surfacing structured envelope to caller`
- Evidence: `commit:<sha>;files:packages/core/src/orchestrate/wave-rollup.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P2.8 — Tests: wave-rollup memory-git aggregation
- Files: `packages/core/src/orchestrate/__tests__/wave-rollup-memory.test.ts`
- Acceptance: `≥3 cases: 3-subagent fan-in clean merge, one-conflict aborts wave, no-memory-changes path (no merges, no error)`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

---

### Phase 3 — Hook into `memory-blocks` write path

**Task E-PRIME-T08a-P3** — Every write to `brain_memory_blocks` fires async `commitSnapshot`
- Type: `task` · Kind: `work` · Severity: `P2` · Size: `small`
- Files: `packages/core/src/memory/memory-blocks.ts`
- Depends-on: `E-PRIME-T08a-P1`
- Acceptance: `each writeBlock/patch invocation enqueues async commitSnapshot | failure does NOT block the SQLite write | failure logged + recorded in brain_observations type='memory-git-error' | bounded concurrency via Letta-style asyncio.Semaphore equivalent (Hermes safe_create_task pattern, §16.C)`
- Evidence: `commit:<sha>;files:<list>`, `tool:test`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P3.1 — Add async hook + bounded queue
- Files: `packages/core/src/memory/memory-blocks.ts`
- Acceptance: `fire-and-forget queue with concurrency cap 5 (configurable via env MEMORY_GIT_CONCURRENCY) | dedup on (peerId, transaction) within 100ms window`
- Evidence: `commit:<sha>;files:packages/core/src/memory/memory-blocks.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P3.2 — Tests: hook fires + does not block
- Files: `packages/core/src/memory/__tests__/memory-blocks-git-hook.test.ts`
- Acceptance: `≥4 cases: hook fires after write, write succeeds even when git call rejects, dedup within window, concurrency cap enforced`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

---

### Phase 4 — CLI surface

**Task E-PRIME-T08a-P4** — `cleo memory log` / `diff` / `revert`
- Type: `task` · Kind: `work` · Severity: `P2` · Size: `small`
- Files: extensions to `packages/cleo/src/cli/commands/memory.ts`
- Depends-on: `E-PRIME-T08a-P1`
- Acceptance: `cleo memory log <peer> green | cleo memory diff <peer> <sha1> <sha2> green | cleo memory revert <peer> <sha> green and writes audit observation | all 3 LAFS-compliant envelopes`
- Evidence: `commit:<sha>;files:<list>`, `tool:test`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P4.1 — `cleo memory log <peer>`
- Files: `packages/cleo/src/cli/commands/memory.ts`
- Acceptance: `prints git-log style output | --limit + --since flags | --json mode`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/memory.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P4.2 — `cleo memory diff <peer> <sha1> <sha2>`
- Files: `packages/cleo/src/cli/commands/memory.ts`
- Acceptance: `prints unified diff per block | --label filter | --json mode emits structured diff per block`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/memory.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P4.3 — `cleo memory revert <peer> <sha>`
- Files: `packages/cleo/src/cli/commands/memory.ts`
- Acceptance: `--dry-run by default; --apply required to persist | confirmation prompt unless --yes | audit observation row asserted in test`
- Evidence: `commit:<sha>;files:packages/cleo/src/cli/commands/memory.ts`, `tool:lint;tool:typecheck`

#### Subtask E-PRIME-T08a-P4.4 — Tests for the 3 CLI subcommands
- Files: `packages/cleo/src/cli/commands/__tests__/memory-git.test.ts`
- Acceptance: `≥6 cases — ≥2 per subcommand, covering JSON + human modes + error envelopes`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

---

### Phase 5 — Storage budget + audit verification

**Task E-PRIME-T08a-P5** — Synthetic storage budget test + cherry-pick grep guard
- Type: `task` · Kind: `work` · Severity: `P3` · Size: `small`
- Files: `packages/core/src/memory/__tests__/memory-git-budget.test.ts`, `scripts/ci/memory-git-cherrypick-guard.sh`
- Depends-on: `E-PRIME-T08a-P4`
- Acceptance: `synthetic 52-week test produces ≤ 5 MB per peer | CI guard greps codebase for git cherry-pick in memory-git code paths and fails on hit`
- Evidence: `commit:<sha>;files:<list>`, `tool:test`

#### Subtask E-PRIME-T08a-P5.1 — Synthetic storage budget test
- Files: `packages/core/src/memory/__tests__/memory-git-budget.test.ts`
- Acceptance: `seeds 5 sessions/week × 52 weeks of varied block edits | asserts du -sh on peer dir < 5 MB`
- Evidence: `commit:<sha>;files:<test>`, `tool:test`

#### Subtask E-PRIME-T08a-P5.2 — CI cherry-pick guard
- Files: `scripts/ci/memory-git-cherrypick-guard.sh`, `.github/workflows/ci.yml` (extension)
- Acceptance: `script greps packages/core/src/memory/ + packages/core/src/orchestrate/ for git cherry-pick | exits 1 on hit | CI step added | local pnpm run test invokes it`
- Evidence: `commit:<sha>;files:<script+ci>`, `tool:test`

---

## Cross-epic summary (counts)

| Epic | Phases | Tasks | Subtasks | Migrations | New modules | New tests | New CLI subcommands |
|---|---|---|---|---|---|---|---|
| E-PRIME-T03 | 8 (P0–P7) | 8 | 60 | 3 (peers, memory_blocks, identity siblings) | 12 | 22 test files | 14 (4 peer + 5 agent + 4 memory block + extension hook) |
| E-PRIME-T08a | 6 (P0–P5) | 6 | 20 | 0 (reuses T03 schema) | 1 (memory-git.ts) | 11 test files | 3 (log, diff, revert) |
| **Total** | **14** | **14** | **80** | **3** | **13** | **33** | **17** |

## Key risks

1. **Letta v2 patch-header parser fidelity** — the 4-header format must match Letta's `base.py:453-485` byte-for-byte or agents trained on Letta v2 will silently drop ops. Spec a golden-file harness in P2.14.
2. **Cherry-pick contamination** — devs naturally reach for `git cherry-pick`; the §16.G correction insists on `merge --no-ff` to preserve SHAs. The grep guard in P5.2 is non-negotiable.
3. **Embedding load on drift detection** — re-embedding every session's mental-model block could overwhelm the embedding service. Phase 4 must rate-limit via Hermes `safe_create_task` semaphore pattern.
4. **Storage drift on memory-git** — text blocks dedup well, but binary frontmatter could break the 5 MB/year budget. Test in P5.1.
5. **Backfill peerId from `'global'`** — P1.12 is destructive-ish; dry-run is the default for a reason. Owner review before `--apply`.
6. **CANT growth subblock parse compatibility** — agents without growth must keep working (acceptance: backwards-compat test in P3.4).
7. **Optimistic-lock starvation** — high-frequency `memory.append_block` calls under concurrency may deadlock with `memory.edit_block` CAS retries. The append path is intentionally CAS-free per §16.C; verify in P2.5.

## Deferred follow-ups (NOT in this decomposition)

- Tier 3 group-manager strategies (§16.C — round_robin/supervisor/dynamic/sleeptime). Cite as `depends-on: E-PRIME-T09-GROUPS`.
- Tier 3.2 `shared:<topic>` block as Group association (§16.C 4-way M:N graph). Today decomposed as label-prefix; full Group↔Block↔Agent↔Identity graph deferred.
- Letta `memory_finish_edits` sentinel — out of scope (CLEO tool-loop already terminates on no-tool-call; not the same primitive).
- Hindsight 4-network column on `brain_memory_blocks` — that's Tier 5.2's job.
- Honcho dialectic evaluator emitting sigil deltas to `brain_sigil_history` — depends on E-PRIME-T06 (Tier 6 PSYCHE harden).
- Skill-distillation Markdown emission — Tier 8.3, separate epic.
- Continuous idle-dream tick — Tier 8.1, separate epic.

## Open questions for owner

1. **Block label canonical order** in spawn `# Core Memory` injection — confirm: persona → human → project → current-goal → open-questions → recent-decisions → scratchpad → shared:* alphabetical?
2. **Drift threshold default** — proposed 0.3 (cosine distance). Acceptable?
3. **Memory-git path** — `~/.local/share/cleo/memory-versions/<canonical-peer-id>/` confirmed (matches worktree env-paths convention)?
4. **CAS error code** — `E_BLOCK_CAS_MISMATCH` proposed. Confirm vs. existing error catalog.
5. **`memory_finish_edits` sentinel** — should CLEO mirror Letta's explicit terminator, or rely on no-tool-call termination?
6. **Cherry-pick guard scope** — grep only memory-git paths, or repo-wide? (Repo-wide may flag legitimate non-memory uses elsewhere.)
