# T942 Sentient CLEO — Round 2 RCASD Synthesis (FINAL)

**Session**: 2026-04-18 | **Parent Epic**: T942 | **Children**: T943-T948

Round 2 dispatched 4 contrarians + 1 auditor + 2 researchers. **Round 2 substantially corrected Round 1** — several foundational assumptions were falsified by live data and deeper code audit.

---

## 1. The Big Corrections (Round 1 was wrong about these)

| # | Round 1 Claim | Round 2 Finding | Evidence |
|---|---|---|---|
| 1 | T943 hybrid: "evidence coverage grows over time" | **FALSIFIED.** 948 tasks, 17 pipelines, **0 gate_results**, 15 evidence rows. ADR-051 shipped v2026.4.80 and produced ZERO gate result rows. | Direct query `.cleo/tasks.db` |
| 2 | T943 Option D view reads `lifecycle_gate_results` | Table is EMPTY. ADR-051 evidence lives in `.cleo/audit/gates.jsonl` (JSONL file), not the DB. View would yield NULLs. | Auditor + T943 contrarian |
| 3 | T944 "~45 call sites, afternoon's work" | **FALSE.** 113 `'epic'` occurrences across 50 files. Structural discriminators at `release-engine.ts:791`, `orchestration/index.ts:423`. 46 test fixture files. | T944 contrarian grep |
| 4 | T944 backfill `type='epic' → kind='initiative'` is safe | **FALSE for 14-24% of rows.** Sample shows test scaffolding, release tasks, sub-initiatives that don't map to `(initiative, project)`. | T944 contrarian sample |
| 5 | T945 `brain_page_*` tables are "dormant" | **FALSE.** ~10 active writers, 4 readers, recursive-CTE SDK, Studio `/api/brain/graph` endpoint, Living Brain SSE. Already live. | T945 researcher |
| 6 | T946 sandbox RO mount preserves security invariant | **THEATRICAL.** Agent runs on HOST (RW), not container. Mount protects nothing that matters. | T946 contrarian + AGENTS.md:131 |
| 7 | T946 receipts.jsonl hash chain is tamper-evident | **FALSE locally.** Attacker with FS+key access forges history. `O_APPEND` doesn't lock file. MUST use `llmtxt/events` Merkle+RFC3161. | T946 contrarian concrete attack |
| 8 | T946 Ed25519 mode 0600 is production-ready | **NO.** Prompt-injected agent reads as same user. MUST use `llmtxt/identity` KMS abstraction per owner Constraint #4. | T946 contrarian |
| 9 | T948 `Cleo` facade is the service layer | **FALSE.** Facade is a closure bag rewrapping free functions. CLI bypasses it entirely (calls `/internal`). Three independent surfaces. | T948 contrarian |
| 10 | T948 "Studio bypasses core = DRY violation" | **PARTIALLY FALSE.** `pipeline/+page.server.ts:26-41` explicitly documents runtime boundary preserving Studio from CLI-only packages. | T948 contrarian |
| 11 | llmtxt is wired | **NEVER IMPORTED.** Declared in package.json but ZERO source files import it. Adoption is from-scratch, not upgrade. | Auditor |

---

## 2. Corrected Per-Task Recommendations

### T943 — State SSoT

**Round 1**: D+C hybrid. **Round 2**: Option E (fixed dual-state rollup).

**Why**: D's premise (view reads `lifecycle_gate_results`) is falsified — table is empty. C's premise (event-sourced) requires `llmtxt/events` which isn't installed. Hybrid has no foundation.

**Ship path**:
- **NOW**: Pure function `packages/core/src/lifecycle/rollup.ts` called from `complete.ts:221-248` + Studio routes via Cleo facade. One composite index `(lifecycle_stages.pipeline_id, status)`. Fixes `/tasks` vs `/tasks/pipeline` disagreement immediately.
- **LATER**: Gate Option C work on (a) T947 `llmtxt/events` landed AND (b) ≥30% active tasks producing atoms.
- **KILL**: Wave 5 (retire `tasks.pipelineStage`) — 269 refs across 50 files, that's its own epic, not a bullet.

### T944 — Fractal Ontology

**Round 1**: kind + scope + severity + sandbox_branch + merged_at + rename epicLifecycle. **Round 2**: Simpler additive alternative.

**Why**: 113 call sites, 14-24% backfill wrong, kind×scope has 4+ invalid pairs, epicLifecycle rename has 23-file blast.

**Ship path** (simpler):
```ts
// ADDITIVE ONLY, no rename, no type deprecation
role: text('role', { enum: ['work','research','experiment','bug','spike','release'] })
  .notNull().default('work'),
scope: text('scope', { enum: ['project','feature','unit'] })
  .notNull().default('feature'),
severity: text('severity', { enum: ['P0','P1','P2','P3'] })
  .$type<'P0'|'P1'|'P2'|'P3'|null>(), // CHECK (severity IS NULL OR role='bug')
// Experiments get SIDE TABLE (not tasks.db denormalization):
// experiments(task_id PK, sandbox_branch, merged_at, receipt_id, metrics_delta_json)
//   with FK to tasks + CHECK role='experiment'
```

- **Keep `type` column** (don't deprecate for 3 releases; 269 refs too risky).
- **Just relax epic-of-epics validation** at `add.ts:800-807`.
- **Severity is OWNER-WRITE-ONLY** via `cleo bug severity` command gated by owner credential (prevents Tier 3 prompt-injection P0 force-ship).
- `cleo backup add` MANDATORY before migration (per AGENTS.md Runtime Data Safety).

### T945 — Universal Graph

**Round 1**: "promote dormant tables". **Round 2**: **already live, close the coverage gaps**.

**Actual gaps**:
1. `addTask` never mints `task:<id>` node — only `completeTask` does. Tasks invisible until done.
2. CONDUIT messages have no node type. Missing edge: `discusses`.
3. `cleo docs add` never mints `llmtxt:<sha256>` nodes or `embeds` edges.

**Ship path** — 5-stage rollout:
- **A (additive)**: 5 new edge types (`blocks`, `discusses`, `cites`, `embeds`, `touches_code`) + 3 new node types (`msg`, `llmtxt`, `commit`)
- **B (backfill)**: from existing cross-DB refs (XFKB-001..005)
- **C (new hooks)**: auto-populate on addTask, conduit send, docs add + `llmtxt/events` audit trail
- **D (SDK re-export)**: getRelated/getImpact/getContext via `@cleocode/core`
- **E (Studio ego-network view)**: retire XFKB soft-FK cleanup

### T946 — Autonomy

**Round 1**: Week 1/2/3-4 phased ship. **Round 2**: HARD BLOCKED on T947 + realistic 5-8 weeks.

**Why**: Mode-0600 Ed25519 insufficient; hand-rolled receipts.jsonl locally-rewriteable; sandbox RO theatrical; baseline gameable; `status='proposed'` picker race is REAL (`dependency-check.ts:103-113` only excludes done/cancelled).

**Required mitigations before shipping**:
1. **Tier 1**: add `'proposed'` to picker-excluded set; DB-level rate limit via UNIQUE index; advisory lock via fs.flock; realistic 2-3 weeks not 1
2. **Tier 2**: BLOCKS on T947 `/events` adoption; file watcher kill-switch with SIGTERM delivery
3. **Tier 3**: BLOCKS on T947 `/identity` + `/events`; agent-in-container (not host-RW); externally-anchored baseline (signed `kind:"baseline"` event predating experiment); FF-only abort-on-fail (no auto-rebase); kill-switch re-check at every step; severity-write gated

### T947 — llmtxt v2026.4.9

**Round 1**: W3 position. **Round 2**: W1 position — everything else depends on it.

**Why**: v2026.4.9 ships `/blob`, `/events`, `/identity`, `/transport` as stable contracts. T946 MUST use `/identity` KMS + `/events` Merkle+RFC3161 (owner Constraint #4 zero-duplication). ~1,100 LoC of CLEO duplicate primitives to retire.

**Ship path** — wave split:
- **W1 step 0**: Version bump `^2026.4.6 → ^2026.4.9` in `packages/cleo/package.json:35` + `packages/core/package.json`. 5-minute change.
- **W2**: `/blob` BlobFsAdapter replaces `attachment-store.ts` (643 LoC) + `/sdk` AgentSession wraps `cleo session`
- **W3**: `/events` replaces `gate-audit.ts` + `assumptions.ts` + `decisions.ts` (316 LoC) + `/identity` greenfield for `cleo bug` signing
- **Skip**: `/local` (conflicts with CLEO's node:sqlite per ADR-010). `/crdt` + `/embeddings` stay opt-in.

**17 documentation files, 35 occurrences** need migration including `CLEO-INJECTION.md:179` (propagates to every user's global CLAUDE.md).

### T948 — SDK + REST

**Round 1**: New `packages/cleo-sdk/` + `packages/cleo-api/`. **Round 2**: Simplify — kill `cleo-sdk` package.

**Why**: `Cleo` facade is a closure bag, not a service layer. CLI bypasses it. Creating a wrapper-around-a-wrapper makes three surfaces. `@cleocode/core` IS the SDK already.

**Ship path**:
- **W1**: Add `STABILITY.md` + `packages/core/.dts-snapshots/` to `@cleocode/core`. Export `Cleo` from `@cleocode/core/sdk` subpath. Single SemVer-within-CalVer policy mirroring llmtxt STABILITY.md.
- **Defer**: `packages/cleo-api/` until OpenClaw (issue #97) proves need. Studio in-process embedding of `Cleo` may be enough.
- **Kill**: `cleo sdk describe` — duplicates forge-ts llms.txt.
- **Wire**: forge-ts across `packages/core/` first (prerequisite) before claiming generated docs.
- **Align**: OpenAPI 3.1 (match llmtxt), not 3.2.

---

## 3. Corrected Wave Plan (T947 first)

| Wave | Tasks | Dependencies | Est. |
|---|---|---|---|
| **W1** | T947 step 0 (version bump) + T948 `@cleocode/core` STABILITY.md + T943 Option E (fixed rollup function) | None | 1 week |
| **W2** | T947 `/blob` + `/sdk` adoption + T944 additive migration (role+scope+severity) + T945 Stage A+B (additive graph schema + backfill) | W1 | 2 weeks |
| **W3** | T947 `/events` + `/identity` adoption + T945 Stage C (auto-populate hooks + audit) | W2 | 2 weeks |
| **W4** | T946 Tier 1 daemon (execute existing tasks) + T945 Stage D (SDK re-export) | W3 | 2 weeks |
| **W5** | T946 Tier 2 (propose tasks) — requires `/events` from W3 + T945 Stage E (Studio view, XFKB retirement) | W4 | 2 weeks |
| **W6-8** | T946 Tier 3 (sandbox auto-merge) — requires `/identity` + `/events` + all mitigations | W5 | 3 weeks |
| **W9+** | Option C convergence (evidence-sourced SSoT) — gate on ≥30% evidence coverage | W6-8 | TBD |

**Realistic total: 10-12 weeks** to full sentient autonomy, not 3-4.

---

## 4. Owner Decisions Required

| # | Decision | Recommended |
|---|---|---|
| 1 | T943 direction: Option E (fixed rollup) vs D+C hybrid vs force C despite falsified coverage | **Option E** |
| 2 | T944 schema: simpler `role+scope+severity` additive vs Round 1 `kind+scope` migration | **Simpler additive** |
| 3 | T944: keep `type` column (don't deprecate) | **Keep** |
| 4 | T944: experiments side-table vs columns on tasks | **Side-table** |
| 5 | T944: severity owner-write-only gate | **Yes (prevent injection)** |
| 6 | T945: accept 5-stage rollout as scoped | **Yes** |
| 7 | T946: accept HARD BLOCK on T947 + realistic 5-8 weeks + agent-in-container | **Yes** |
| 8 | T946: `status='proposed'` or `kind='experiment'` for Tier 2 queue (axis alignment) | **Owner picks** |
| 9 | T947: promote to W1 (was W3) | **Yes** |
| 10 | T948: kill `packages/cleo-sdk/` and promote `@cleocode/core` as SDK | **Yes** |
| 11 | T948: defer `packages/cleo-api/` | **Yes** |
| 12 | Wave plan: 10-12 week realistic vs 3-4 week aspirational | **10-12 week** |

---

## 5. Key Unknowns Still Open

- Should `lifecycle_gate_results` table get backfilled from `.cleo/audit/gates.jsonl`, or should ADR-051 pivot from JSONL to DB (via `/events`)?
- Sandbox repo: `bin/sandbox` harness exists but never invoked from main cleocode — what's the actual invocation path?
- Does `cleo bench` command exist? (T946 references it; need to build or designate an alternative).
- External OpenClaw (issue #97) timeline: do they need REST or is SDK sufficient?

---

## References

- Round 1 synthesis: `.cleo/agent-outputs/T942-rcasd-round1/synthesis.md`
- llmtxt v2026.4.9 context: `.cleo/agent-outputs/T942-rcasd-round1/llmtxt-v2026.4.9-context.md`
- T945 design: `.cleo/agent-outputs/T942-rcasd-round1/T945-graph-design.md`
- T946 design: `.cleo/agent-outputs/T946-sentient-loop/T946-design.md`
- T947 plan: `.cleo/agent-outputs/T947-llmtxt-v2026.4.9/T947-updated-plan.md`
- T943 contrarian attack: `.cleo/agent-outputs/T943-round2/contrarian-attack.md`
- ADR-051: `.cleo/adrs/ADR-051-programmatic-gate-integrity.md`
- Issue #96 (llmtxt): https://github.com/kryptobaseddev/cleo/issues/96
- Issue #97 (OpenClaw SDK): https://github.com/kryptobaseddev/cleo/issues/97
