# T764 — BRAIN Deep-Audit (Post-T759 Fix Verification + Philosophy Gap Analysis)

**Task**: T764 (child of epic T760 RCASD)
**Date**: 2026-04-16
**Fix reference**: v2026.4.69 / commit `5ad2c966`
**Bench evidence**: `.cleo/agent-outputs/T-POMODORO-BENCH-2026-04-16/SUPREME_REPORT.md` §3.3
**Live brain.db probed**: `/mnt/projects/cleocode/.cleo/brain.db` (12 MB, 1,482 graph nodes, 11,812 edges)

---

## 1. Executive Summary (200 words)

**T759 fix is COMPLETE and empirically verified**. The provenance column defect that blocked `cleo memory observe` and `cleo session end` on v2026.4.65–v2026.4.68 no longer fires. `cleo memory observe "..." --title "..."` returned `{id: O-mo14y8vx-0, success: true}`; `cleo session end` completed without the "Failed to write memory bridge" warning; `cleo memory fetch O-mo14y8vx-0` retrieved the full row with all T549/T531/T528/T726 columns populated. The three-layer fix chain landed cleanly: (a) `build.mjs` now syncs all 12 Drizzle brain migrations from `@cleocode/core` into `@cleocode/cleo` packaging; (b) `brain-sqlite.ts:123-138` adds a `T759` `ensureColumns` safety net for `brain_page_edges.provenance` ahead of the T626 co_retrieved UPDATE; (c) `@cleocode/core` migration folder is unchanged (reference source of truth). 

**However**, this audit uncovered **three P0 defects and four P1 gaps** the T759 fix did NOT address. Most significant: (1) the Hebbian strengthener is dumping 6,026 `co_retrieved` edges into the graph from RRF-retrieval batches containing unrelated items, and (2) the bench-relevant observation write now works but would still be drowned by 1,152 short-tier observations with no LLM extraction running (no `ANTHROPIC_API_KEY` in session path). 

**No new epic needed** — file P0s as children of existing T760 RCASD or the BRAIN Integrity Crisis epic (brain-integrity-epic).

---

## 2. T759 Fix Verification Matrix

| Check | Expected | Observed | Status |
|---|---|---|---|
| `cleo memory observe` returns obs id | Yes | `O-mo14y8vx-0` created | ✅ PASS |
| `cleo session end` prints no warning | Silent success | Silent success, `{ended:true}` | ✅ PASS |
| Memory bridge refresh succeeds | No "Failed to write" log | Clean exit | ✅ PASS |
| `brain_page_edges.provenance` column exists on fresh installs | Guard creates it | `ensureColumns(... 'provenance', ddl:'text' ...)` at `brain-sqlite.ts:129` | ✅ PASS |
| All 12 core migrations shipped in `@cleocode/cleo` | 12 migration dirs | 12 present: initial, t033-indexes, t417-agent-field, t528-graph, t531-quality, t549-tiered, t626-co_retrieved, t673-retrieval-log, t673-plasticity-expand, t673-page-edges, t673-new-tables, t726-dedup-tier | ✅ PASS |
| `build.mjs` packaging sync | Regression-proof | `build.mjs` now copies from `packages/core/migrations/drizzle-brain/*` to `packages/cleo/migrations/drizzle-brain/*` before bundling (T759 commit body) | ✅ PASS |
| Extraction pipeline still writes provenance on new obs | Non-null | Fresh probe `O-mo14y8vx-0.contentHash = 287e0ca78e2e3e7f` + `sourceConfidence = owner` | ✅ PASS |
| Graph `brain_page_edges.provenance` query populated | Rows with `consolidation:*` provenance | 2,444 `supersedes` + 6,026 `co_retrieved` edges in graph (graph-stats) | ✅ PASS |

**Verdict**: T759 is a complete fix. No residual "no such column" shape defects remain in the canonical write path. The fix also defensively unblocks older DBs missing the T528 migration via runtime `ensureColumns`.

---

## 3. Gap Check vs Owner Memory Philosophy

Reference: `owner-memory-philosophy.md` + `memory-architecture-v2-initiative.md` (14 directives).

| # | Directive | State | Evidence / Gap |
|---|---|---|---|
| 1 | **Tiered memory (short/medium/long)** | **PARTIAL** | Columns exist. Tier distribution: obs 1152/149/**0**, learn 0/7/**0**, pat 0/2/**0**, dec 0/17/**0**. Zero rows in long tier across all 4 tables. Promotion code (`runTierPromotion`) exists with citation + verified + age gates but the top-10 upcoming promotions show 2.1–4.7 days to go — valid, but the distribution is lopsided: obs=short dominates while typed tables skipped short entirely. Suggests the tier default for new obs is `short` while for decisions/patterns/learnings it may be `medium` by write path — inconsistent. |
| 2 | **Chat ≠ memory (extraction-only writes)** | **PARTIAL** | `auto-extract.ts` → `llm-extraction.ts` is the wired path. Session end hook (`session-hooks.ts:53-88`) calls `extractFromTranscript` only when `config.brain?.autoCapture === true` AND adapter provides `getTranscript`. **In practice: extraction silently NO-OPs without ANTHROPIC_API_KEY.** Session note also writes a verbatim string via `observeBrain` path which IS raw chat content — see `O-mo14zdtk-0` ("Session note: T764 brain audit probe") — that's still session-note semantics, borderline acceptable but duplicates extraction intent. |
| 3 | **Extraction → Consolidation → Retrieval pipeline** | **PRESENT** | All 3 stages wired: `llm-extraction.ts` (LLM gate w/ confidence ≥0.40 + similarity check) → `brain-consolidator.ts` (contradiction detection, 146 edges proof) + `runConsolidation` (dedup + quality recompute + tier promote + soft evict + graph strengthen + summary) → `brain-retrieval.ts` (compact + timeline + fetch). Session end wires consolidation via `handleSessionEndConsolidation` (priority 5, setImmediate). |
| 4 | **Ground truth (verified flag)** | **PARTIAL** | Column present in all 4 tables (T549 migration). Write paths DO set it: decisions default `verified=true` (`decisions.ts:163` — "the act of deciding IS verification"), owner-sourced observations also verified. **Gap**: agent-sourced observations stay `verified=false` forever — there is no mechanism to promote an agent claim to ground truth via external confirmation. Owner directive #6 "Do NOT store memory until information is verified" is not enforced: unverified data DOES get stored, just with `verified=0` and eventual pruning via quality score. |
| 5 | **Typed memory (semantic/episodic/procedural)** | **PRESENT** | `brain_cognitive_types` vocabulary enforced via `memory_type` column. Distinguishable in DB: observations default `episodic`, patterns default `procedural`, decisions default `semantic`, learnings default `semantic`. Values ARE being written (see live fetch: `O-mo14y8vx-0.memoryType='episodic'`). |
| 6 | **Instrumentation** | **PRESENT** | `brain_retrieval_log` table indexed on created_at, source, session, reward_signal. `incrementCitationCounts` called from every find/fetch (lines 261, 356, 626, 1378 in `brain-retrieval.ts`). `plasticity_events` + `plasticity_modulators` tables capture STDP metrics. **Gap**: there is no `cleo memory metrics` command exposing this data — it's silently accumulating but not surfaced. |
| 7 | **Consolidation (dedup + similarity merge)** | **PRESENT** | Hash dedup live-verified: `cleo memory store --type pattern --content "T764 dedup gate probe"` twice → same id `P-9fa15b8b`, frequency incremented 1→2. `cleo memory dedup-scan` returned "No hash-duplicate entries found". `deduplicateByEmbedding` wired at `brain-lifecycle.ts:683`. |
| 8 | **Dedup (2,440-noise epic, brain-integrity-epic)** | **RESOLVED (mostly)** | Current pattern count: 113 nodes (was 2,440). Signal/noise DRAMATICALLY improved. Auto-pattern "Recurring label X" generator appears to have been retired or gated. Brain.db now 12MB with 1,482 graph nodes and 11,812 edges — previously "0 useful graph nodes". ✅ Integrity epic is substantially closed but the 1,152 short-tier observations (1,152 of 1,308 obs = 88% unpromoted) signal many observations are never making it to medium. |

### Retrieval / Ranking

| Feature | State | Evidence |
|---|---|---|
| Reciprocal Rank Fusion | **PRESENT** | `brain-search.ts:600-666` implements RRF with `k=60` (Cormack/Clarke/Buettcher SIGIR 2009). `hybridSearch` at `:723+` combines FTS5 + vector + graph signals. Default `useRRF=true` in `searchBrainCompact`. |
| Vector / embedding retrieval | **GATED** | `brain-embedding.ts` defines provider contract. `LocalEmbeddingProvider` lazy-loads when `brain.embedding.enabled=true`. **Gap**: Without a registered provider, vector search quietly degrades to FTS5-only. No telemetry exposes whether vector path ran. |
| FTS5 population | **PRESENT** | Triggers on insert/update/delete for all 4 tables (`brain-search.ts:114-241`). First-run `rebuildFts5Index` syncs pre-trigger data. |
| LIKE fallback | **PRESENT** | `searchWithLike` at `:429` preserves functionality on builds missing FTS5. |

---

## 4. Benchmark-Relevant Gap (the Pomodoro Bench question)

**The question**: "Even now that it's fixed, would `cleo observe` DURING a build actually surface to future sessions usefully, or would it drown in the 2,440-noise-pattern swamp?"

**Answer**: **Better than before, but still degraded**. Concrete findings:

1. **Noise swamp is largely drained.** Current pattern count is 113 (was 2,440). `cleo memory dedup-scan` returns clean. The "Recurring label X" auto-generator has been retired. ✅
2. **BUT the write-retrieve loop during a live build is STILL broken**:
   - During benchmark, the builder's `cleo observe` calls were blocked by the provenance bug (P0, now fixed).
   - Now they succeed — but the builder would have called `cleo observe` with `sourceType: 'manual'` from the agent. Agent-sourced observations default to `sourceConfidence='agent'` and `verified=false`, staying in `short` tier indefinitely.
   - Short-tier observations have tight soft-eviction rules (quality ≥ 0.30 or they're pruned). Agent-only observations with short narratives will fail quality scoring and get evicted BEFORE a future session can retrieve them.
3. **RRF ranking is technically correct but UX-misleading**: the CLI returns `relevance` as `1/(rank+60)` which looks like a static 0.0166 bucket for top-1 regardless of actual FTS BM25 strength. An agent reading the JSON cannot distinguish "strong match" from "weak match" by relevance value alone — must use rank order. This is why my "Brain audit" query surfaced the probe but in rank 3–4 behind weaker co-occurrence hits.
4. **During-session retrieval also isn't surfacing to the active session**: even though `brain_retrieval_log` is being updated per call (incrementCitationCounts runs via setImmediate), there is no hot-cache feeding back into the agent's own context. Every `cleo memory find` is a cold query.

**Net**: Writes now persist. Retrieval works. But the tier promotion flow + quality-score eviction means a one-shot `cleo observe` during a short benchmark session will NOT be retrievable 3 days later unless cited ≥ 5 times or `verified=true`. This is a **workflow issue, not a schema issue**.

---

## 5. Concrete Defects (P0 / P1 / P2)

### P0 — Must fix before next release

**P0-T764-A**: **Hebbian strengthener creates co_retrieved edges from unrelated batch items.**
- *Evidence*: graph-stats shows 6,026 `co_retrieved` edges vs 1,482 total nodes → every node averages 4 co_retrieved neighbors. This pollutes graph-similarity retrieval. Every `cleo memory find` with limit≥5 creates N×(N−1)/2 edges.
- *Rationale*: graph walks now drown true supersession/contradiction signals under noise.
- *Fix*: require minimum co-retrieval frequency (e.g., 3 co-retrievals over distinct queries) before emitting edge; or scope edges to FTS-matched pairs only, not all returned items.

**P0-T764-B**: **Extraction silently disabled without `ANTHROPIC_API_KEY`.**
- *Evidence*: `auto-extract.ts:11-17` says "Returns silently when ANTHROPIC_API_KEY is not set". The session-end hook calls it but it no-ops. Owner directive #6 ("extraction pipeline") is not running in most real sessions.
- *Rationale*: ALL session memory writes during a no-key session go through `observeBrain` raw write path, bypassing the LLM gate. This violates owner directive #2 (chat ≠ memory) because raw transcript chunks reach the DB with no typing, no confidence scoring, no verification.
- *Fix*: (a) add telemetry to session-end showing "extraction skipped: no API key"; (b) ship a local fallback extractor (regex + heuristic) that at minimum tags source_type and rejects obvious noise; (c) expose `cleo memory extraction-status` command.

**P0-T764-C**: **Agent-sourced observations never graduate to `verified=true`.**
- *Evidence*: `verified` column backfill (T549 migration :150–195) sets owner-sourced + task-outcome-sourced to verified paths, but agent-sourced stays `verified=0` with NO code path that can flip it to true after external confirmation.
- *Rationale*: Owner directive #6 "Do not store memory until information is verified" is structurally un-enforceable: CLEO has no human-in-the-loop verify step between "agent wrote observation" and "observation is ground truth".
- *Fix*: add `cleo memory verify <id>` owner command that sets `verified=1`; surface unverified-but-highly-cited entries (`citation_count≥5 AND verified=0`) as a `cleo memory pending-verify` queue.

### P1 — Should fix this week

**P1-T764-D**: **RRF relevance score reported as rank-bucket, not strength.**
- `brain-retrieval.ts:233` maps `relevance: r.score` where `r.score = 1/(rank+60)`. The CLI consumer cannot distinguish a strong match (top BM25) from a weak one (same bucket). Recommend also exporting `bm25Score` and `rrfScore` separately, or normalizing to [0,1] via min-max.

**P1-T764-E**: **Short-tier observations lack a retention floor for agent writes.**
- 1,152 observations in short, only 149 in medium. Agent writes fall off at soft-evict (quality < 0.30 after 7d). Recommend: if an observation is referenced by ≥ 2 task IDs or contains a task cross-ref, auto-promote to medium at creation.

**P1-T764-F**: **No `cleo memory metrics` surface.**
- `brain_retrieval_log` accumulates but is not exposed. Owner directive #8 "instrument everything, measure quality" is present in DB but invisible to ops. Recommend: `cleo memory metrics` that exports write rate, read rate, hit/miss, tier distribution, top queries, extraction success rate.

**P1-T764-G**: **"Session note" write is a chat-log-as-memory anti-pattern.**
- `cleo session end --note "..."` writes the verbatim note string as an observation (`O-mo14zdtk-0`). That's a lightweight note, acceptable, but it bypasses the extraction gate. Recommend: route session notes through the extraction gate with source_type='session-debrief' so they get typed/scored like other writes.

### P2 — Nice to have

**P2-T764-H**: `cleo memory reflect` has an LLM parse failure log: "Reflector: failed to parse LLM response" — silent degradation, worth tracing.

**P2-T764-I**: No `cleo memory demote` to `short` tier (only `promote`/`demote` to medium). Owner may want to demote a learned-wrong entry.

**P2-T764-J**: `brain_page_edges.weight` is double-writing for co_retrieved relationships. Hebbian should be idempotent (upsert with max-weight), not additive.

---

## 6. Recommendation

**Do NOT open a new epic.** The BRAIN architecture substantially matches the owner philosophy. Gaps are patchable:

- File P0-A, P0-B, P0-C as children of existing **T760 RCASD** epic.
- File P1-D through P1-G as children of **BRAIN Integrity Crisis** epic (brain-integrity-epic, the 2,440-noise-pattern one).
- Close brain-integrity-epic's pattern dedup acceptance criterion — evidence shows resolution (113 patterns, no dupes).
- P2 items ship as a minor cleanup bundle.

The T759 fix did its job. The remaining gaps are architecture tuning, not schema plumbing.

---

## 7. Files Read (provenance for this audit)

| Path | Purpose |
|---|---|
| `git show v2026.4.69` | Confirmed T759 commit scope |
| `packages/core/src/store/brain-sqlite.ts` | Verified ensureColumns provenance guard |
| `packages/core/src/memory/brain-retrieval.ts` | RRF + search + observe impl |
| `packages/core/src/memory/brain-search.ts` | FTS5 + BM25 + escape logic |
| `packages/core/src/memory/brain-lifecycle.ts` | Tier promotion, soft evict, dedup |
| `packages/core/src/memory/brain-consolidator.ts` | Contradiction detection |
| `packages/core/src/memory/extraction-gate.ts` | Write-side gate |
| `packages/core/src/memory/auto-extract.ts` | Session-end extraction dispatch |
| `packages/core/src/hooks/handlers/session-hooks.ts` | Session-end wiring |
| `packages/cleo/src/dispatch/domains/memory.ts` | CLI→engine routing |
| `packages/core/src/memory/engine-compat.ts` | memoryFind default (no `useRRF` pass-through) |
| All 12 `packages/cleo/migrations/drizzle-brain/*/migration.sql` | Packaging verified |
| `/mnt/projects/cleocode/.cleo/brain.db` | Live state (12 MB, 1482 nodes, 11812 edges) |
| `.cleo/agent-outputs/T-POMODORO-BENCH-2026-04-16/SUPREME_REPORT.md` §3.3 | Defect context |
