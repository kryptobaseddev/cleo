# Slot Orchestrator Prompts (.127 → .133)

Each section is the prompt to pass to a fresh `orchestrator-sub-agent` for that slot. Use after the previous slot is verified shipped on npm.

**Common preamble** (prepend to every slot's prompt):

```
You are the slot owner for v2026.4.<N>. Working directory: /mnt/projects/cleocode.

REQUIRED context files (read first):
1. /mnt/projects/cleocode/.cleo/agent-outputs/CAMPAIGN-2026-04-24-overnight-execution-plan.md
2. /mnt/projects/cleocode/.cleo/agent-outputs/NEXT-SESSION-HANDOFF.md (sections matching this slot's epic)
3. /mnt/projects/cleocode/.cleo/agent-outputs/T-COUNCIL-RECONCILIATION-2026-04-24/council-output.md
4. The pre-explorer map for this slot (see deliverable path below — should already exist)
5. cleo show <epicId> for the verbatim ACs

Run RCASD decomp (5-8 atomic worker tasks under epic) → IVTR (workers in worktrees, INDEPENDENT validators per worker, no rubber-stamp) → cherry-pick to main → quality gates (biome ci + build + test green vs. baseline) → version bump all 16 packages → CHANGELOG → commit chore(release): v2026.4.<N> → tag → push → verify gh CI + Release + npm view → cleo memory observe + cleo lifecycle complete.

Worker dispatch: use `cleo orchestrate spawn <id> --json`; workers cd to worktree first; evidence atoms required (commit:<sha>;files:<list>; tool:pnpm-test; tool:biome;tool:tsc).

Authority: push + tag + publish authorized. No --force. No --no-verify unless unrelated hook.

Stop condition: v2026.4.<N> verifiably live on npm AND `cleo show <epicId>` returns status=completed. Otherwise BLOCKER report at /mnt/projects/cleocode/.cleo/agent-outputs/<epicId>-BLOCKER-<ts>.md.

Return <300 words: commit SHAs, tag, gh URLs, npm versions, evidence atoms, memory observation ID.
```

---

## Slot .127 — T1259 PSYCHE E2 (seed-install meta-agent)

Pre-explorer map: `/mnt/projects/cleocode/.cleo/agent-outputs/T1259-explorer-map.md` (READ THIS FIRST — has 7 atomic worker tasks proposed)

Slot-specific guidance:
- 10 ACs include M1 spawn-retrieval-parity AcceptanceGate which BLOCKS T1259 close until T1260 (.128) satisfies. STRATEGY: file the M1 RED test scaffold as part of T1259 work (T1259-W7 in explorer map), commit it red, then the gate auto-resolves when T1260 makes it green. T1259 ship should NOT block on T1260 if you stage M1 test correctly. **DO NOT pass M1 gate green at E2 time — Council violation.**
- Expansionist F1 (cleo agent mint CLI) + F2 (@cleocode/agents-starter pkg published) are MANDATORY scope additions per council
- agent-architect.cant parent must point to canonical orchestrator from T1258/E1 (already shipped)
- meta/ loader must support packaged-tier fallback (new `resolveMetaAgentsDir()` helper required — see T1259-W1)
- **Verify F1 from tracker**: confirm `packages/cleo/src/cli/commands/agent.ts:129` no longer scaffolds with `parent: cleoos-opus-orchestrator` — if E1 missed it, fix before W6
- **Verify F2 from tracker**: confirm `packages/agents/meta/agent-architect.cant:21` has the canonical E1 orchestrator name (not `cleo-prime`) — if E1 missed it, fix it as part of W4
- **F6 decision**: prefer subset export from `@cleocode/agents` (no new 17th package) UNLESS owner-staged plan requires separate `@cleocode/agents-starter` — fewer release-loop updates = fewer regressions. E2 orchestrator decides based on starter-bundle complexity.
- Single biggest design decision (R1 from explorer): agent-architect invocation mechanism — recommended subprocess via `cleo orchestrate spawn agent-architect --no-worktree` with static-copy fallback

---

## Slot .128 — T1260 PSYCHE E3 (spawn wiring + M4 + M6)

Pre-explorer map: `/mnt/projects/cleocode/.cleo/agent-outputs/T1260-explorer-map.md` (READ THIS FIRST — 5 atomic worker tasks proposed)

Slot-specific guidance:
- 9 ACs include the M1 parity-test GREEN flip (your job — T1259 staged it red)
- M4: register buildRetrievalBundle as named injection primitive reusable by hooks/CANT/CONDUIT/sentient
- M6 BINDING GATE: buildRetrievalBundle must emit provenanceClass on every entry AND refuse provenanceClass="unswept-pre-T1151". Schema migration required (Drizzle generate). DO NOT SHIP without M6 — failure mode is silent drift to Sentient v1.
- **F4 from tracker**: this slot owns the SCHEMA + CONTRACT for provenanceClass (column on all 4 brain tables, type on Retrieval* contracts). W7 sweep in .132 only UPDATES values. Default = `'unswept-pre-T1151'` for legacy data.
- Council's first concrete action ordered the parity test scaffold — T1260-W4 (composeSpawnPayload wiring) + T1260-W5 (parity test) execute it
- **Symbol locations confirmed** in explorer map: composeSpawnPayload at `spawn.ts:360`, buildRetrievalBundle at `brain-retrieval.ts:1918`, injection point at `spawn-prompt.ts:1132`
- **Lesson 3 reminder**: keep timestamp from `pnpm db:generate`; never delete-regenerate the migration folder
- Risk: with provenanceClass default `'unswept-pre-T1151'`, M6 refusal gate will EMPTY all warm/hot bundles until W7 sweep runs. Document this; emit warning in refusal log; don't silent-empty.

Parallel-safe with .127 if T1258/E1 fully landed. M1 gate ensures convergence before .127 closes.

---

## Slot .129 — T1261 PSYCHE E4 (governed pipelines, STRICT cutover)

Pre-explorer map: none pre-staged (file: `/mnt/projects/cleocode/.cleo/agent-outputs/T1261-explorer-map.md` if needed)

Slot-specific guidance:
- 11 ACs include STRICT cutover (no opt-in flag — CLEO is opinionated). Migration tool MUST convert rcasd/ivtr/release starter playbooks in-repo at E4 ship.
- T1250 surface compression sequenced AFTER E1 — file as a child of T1261
- M5 hot-path wiring: every exported validator must have ≥1 runtime call site BEFORE close (grep for it as a release-gate check)
- LOOM substrate coverage AC: `cleo orchestrate start <epic>` must work post-E4 schema changes

---

## Slot .130 — T1263 PSYCHE E6 (session-journal, T1262 CLI absorbed)

Pre-explorer map: none pre-staged (file: `/mnt/projects/cleocode/.cleo/agent-outputs/T1263-explorer-map.md` if needed)

Slot-specific guidance:
- 8 ACs including absorbed T1262 CLI surface + session-end hook
- 7th CLEO system: journals the other 6 (TASKS, LOOM, BRAIN, NEXUS, CANT, CONDUIT)
- `.cleo/session-journals/*.jsonl` retention per ADR-013 §9
- Meta-agent reads recent journals at `cleo init`

---

## Slot .131 — T1145 W5 + T1146 W6 (combined: deriver + dreamer)

Pre-explorer map: `/mnt/projects/cleocode/.cleo/agent-outputs/T1145-T1146-explorer-map.md` (READ FIRST — 10 atomic worker tasks proposed: W5-T1..T5 + W6-T1..T5)

Slot-specific guidance:
- LARGE combined slot — 10 child tasks (5 per wave)
- **F5 from tracker**: 3 migrations MUST run in this order: (1) `t1145-add-deriver-queue`, (2) `t1145-extend-brain-observations` (adds tree_id column), (3) `t1146-add-brain-memory-trees`. W6-T1 blocks on W5-T1 cherry-pick to main. Same slot, ordered waves.
- Sensible only after E3 (.128) — verify composeSpawnPayload + buildRetrievalBundle wired
- W5 deriver-created entries get `provenanceClass='deriver-synthesized'` at write time (M6 from .128)
- W6 specialists (6 of them) MUST degrade gracefully when no LLM backend available — return neutral score 0.5, log warning, don't throw (pattern from existing sleep-consolidation.ts)
- W6-T5 upgrade of `sleep-consolidation.ts` MUST preserve `vi.mock('../sleep-consolidation.js')` surface — existing dream-cycle.test.ts depends on it. Add `specialists.test.ts` separately.

---

## Slot .132 — T1147 W7 (reconciler + 2440 sweep absorbed)

Pre-explorer map: `/mnt/projects/cleocode/.cleo/agent-outputs/T1147-explorer-map.md` (READ FIRST — 8 atomic worker tasks proposed: W7-1..W7-8)

Slot-specific guidance:
- AC must contain: shadow-write envelope + brain_v2_candidate staging + 100-entry stratified human validation + self-healing gated off during sweep tx
- Sweep MUST complete before E3 buildRetrievalBundle is exposed to W8 Sentient proposer (per First Principles atom 4)
- T1139 supersession scope folded in
- **F4 from tracker**: provenanceClass schema + contract belongs to T1260 E3 (.128, already shipped). This slot ONLY updates VALUES — `'unswept-pre-T1151'` → `'swept-clean'` or `'noise-purged'`. Skip W7-5 from explorer map (it's redundant with .128).
- Validation step: 100 stratified samples — autonomous mode means automate the sampling per W7-3 noise detector; document the sample list + auto-validation results as evidence (note in `cleo verify --evidence "files:.cleo/agent-outputs/T1147-sweep-validation.jsonl"`)
- New brain_v2_candidate table extends `brain_backfill_runs` pattern (T1003) — same staged/approved/rolled-back semantics
- Self-healing gate: use Option A (toggle existing `killSwitch` in `.cleo/sentient-state.json`) for simplicity. Document Option B (new `sweepLock` field) as a T1148 cleanup item.
- No reconciler module exists today — W7-1 creates `packages/core/src/memory/brain-reconciler.ts` from scratch, extending `brain-lifecycle.ts::runConsolidation`

---

## Slot .133 — T1148 W8 + T1151 Sentient v1 + M7 (APRIL TERMINUS)

Pre-explorer map: `/mnt/projects/cleocode/.cleo/agent-outputs/T1148-T1151-explorer-map.md` (READ FIRST — 12 atomic worker tasks proposed: W8-1..W8-12)

Slot-specific guidance:
- LARGEST slot — 12 worker tasks combining Wave 8 (sigil ≡ peer_card) + Sentient v1 consolidation + MCP adapter proof + T1151 (self-healing as dispatch-time reflex) + M7 entry gate
- M7 BINDING GATE: `cleo sentient propose enable` MUST return non-zero until `cleo memory doctor --assert-clean` exits 0 (depends on T1262 doctor from .126/.130 + W7 sweep from .132 having stamped clean values)
- **F3 RESOLUTION (autonomous-mode)**: "MCP adapter proof" = external-only stub package (likely `packages/mcp-adapter/` or doc) exposing `cleo sentient` ops as MCP tools. Do NOT re-introduce MCP internally. T1148-W9 worker scope is fixed.
- **First design decision** (W8-1): owner deferred "sigils new table vs extension columns on user_profile" (NEXT-SESSION-HANDOFF.md:304-305 / open decision 5). **Autonomous resolution: NEW `sigils` table in nexus.db.** Cleaner schema, future-proof for richer fields, no breaking changes to user_profile contract.
- T1151 dispatch-time reflex SCOPE LOCK: ONLY the hook in `propose-tick.ts:safeRunProposeTick()` + kill-switch gating during W7 sweep tx. Do NOT scope-creep into BRAIN reconcile (W7), nexus impact (already in classify.ts), peer memory (Waves 1-4 done). Block W8-8 worker if scope creeps.
- This is the FINAL slot — no .134 escape hatch. If a worker blocks, file BLOCKER report and continue with what ships.
- After ship: `cleo memory observe` titled "v2026.4.133 shipped — April terminus reached" + close T1075 PSYCHE umbrella epic + close T1148/T1151
- Update NEXT-SESSION-HANDOFF.md with terminus state. Do NOT plan v2026.5.0 (future session work).
