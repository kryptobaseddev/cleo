# NEXT SESSION HANDOFF — SSoT (rewritten 2026-04-25 post-T1402 + T1414 close)

This document supersedes all earlier sessions' handoff narratives. **Trust this file over older audits, prior session prose, or task-DB rollup percentages.** Verified against npm + git + filesystem at write time.

---

## Definitive current state

| Item | Value | How verified |
|------|-------|--------------|
| Latest tag on origin/main | **v2026.4.141** | `git tag --sort=-v:refname \| head -1` |
| HEAD commit on origin/main | `f82fd7c93` (T1414 CLEO-INJECTION trim) | `git log origin/main -1` |
| `npm view @cleocode/cleo version` | **2026.4.141** | direct npm call |
| `npm view @cleocode/mcp-adapter version` | **2026.4.141** | npm registry version-specific endpoint |
| `cleo memory doctor --assert-clean` | `isClean:true totalScanned:1426 pendingCandidates:0` | live CLI |
| Sentient daemon | `tier2Enabled:null killSwitch:true` (safe default) | `cleo sentient status` |
| 16 base + mcp-adapter at .141 | confirmed via `for p in cleo core ...` loop | scripted npm view |

---

## What this session did

1. **Closed T1402** (`brain_v2_candidate → brain_observations_staging` rename). Was stuck `status:pending` despite shipping in commit `932fad3d4` / v2026.4.139. Closed via real evidence-based verification: `commit` + 6 file SHA-256s + brain-sweep-e2e test-run JSON (6/6 pass) + biome/tsc green. **Zero owner-override used.**
2. **Closed T1414** (CLEO-INJECTION.md size regression, 288→264 lines, commit `f82fd7c93`). Discovered when T1402's `cleo verify --evidence "tool:pnpm-test"` ran the full suite and caught the real regression — the safeguard worked as designed.
3. **Filed T1414 + scrubbed phantom audit findings** documented below.

---

## CRITICAL: Audit corrections (prior `T1075-COMPREHENSIVE-SCOPE-AUDIT.md` had 3 verifiable errors)

### Correction 1 — Wave 9 T1149 IS COMPLETE, not phantom-closed

The audit claimed: *"conduit-sqlite.ts schema version is '2026.4.23' — does NOT include topics/topic_subscriptions/topic_messages/topic_message_acks tables."*

**Reality (verified at this session)**:
- `packages/core/src/store/conduit-sqlite.ts:287-333` defines all 4 topic tables.
- Migration `2026-04-23-000000_t1252_a2a_topics` is recorded in `_conduit_migrations`.
- `packages/core/src/conduit/local-transport.ts` ships `subscribeTopic:299`, `publishToTopic:344`, `unsubscribeTopic:456`, `pollTopic:480`.
- `packages/cleo/src/cli/commands/conduit.ts` ships `cleo conduit publish/subscribe/listen` CLI verbs (T1252/T1254).
- `packages/core/src/orchestration/spawn-prompt.ts:141` injects `## CONDUIT Subscription` section into tier-1/2 spawn prompts.
- T1252 task: `status=archived completedAt=2026-04-23T04:25:17 parentId=T1149` — child task that delivered the implementation.

The audit misread `CONDUIT_SCHEMA_VERSION = '2026.4.23'` as a "schema is outdated" signal. It's just a date string.

### Correction 2 — PORT-AND-RENAME §2 schema deltas are PARTIALLY SHIPPED via lazy ensureColumns

Audit claimed: *"`observation_embeddings`/`turn_embeddings` tables and `source_ids`/`times_derived`/`level`/`tree_id` columns NOT confirmed in `memory-schema.ts` — quietly dropped."*

**Reality**: T1402 brain-sweep test runtime logs show:
```
WARN brain Adding missing column brain_observations.provenance_class via ALTER TABLE
WARN brain Adding missing column brain_observations.times_derived via ALTER TABLE
WARN brain Adding missing column brain_observations.level via ALTER TABLE
WARN brain Adding missing column brain_observations.tree_id via ALTER TABLE
```

There's a runtime `ensureColumns` ALTER-TABLE pattern that adds these columns to legacy DBs lazily. Status: **defined-but-lazy**, not "silently dropped". `observation_embeddings` and `turn_embeddings` tables remain unconfirmed; needs a follow-up grep audit.

### Correction 3 — `reconcile-scheduler.ts` audit finding holds

Audit said: *"`packages/core/src/sentient/reconcile-scheduler.ts` does not exist."* Re-verified — still absent. Periodic reconciliation runs only on-demand or via the Sentient v1 dispatch reflex, not on a timer. This audit finding stands.

---

## Naming / architecture inconsistencies surfaced this session

### Schema-file naming convention

The canonical pattern across CLEO domains:
- `<domain>-schema.ts` — pure Drizzle table definitions
- `<domain>-sqlite.ts` — open/init/health/CRUD accessors

Applied consistently in `memory`, `nexus`, `signaldock`. **Outlier: `conduit`** has only `conduit-sqlite.ts` — a hybrid file with raw SQL string DDL + open/init + CRUD accessors all combined. Predates the Drizzle convention. **Cleanup task: split into `conduit-schema.ts` (Drizzle) + `conduit-sqlite.ts` (open/init only) for consistency.**

### Rust `crates/conduit-core/`

This is **NOT a duplicate implementation** of conduit. It's the canonical wire-types crate (depends on `lafs-core`) for cross-language interop with the LAFS envelope spec. Just `lib.rs` with type definitions. No conflict with the TS conduit-sqlite.ts implementation.

---

## Outstanding scope (verified post-corrections, ranked by priority)

### P0 — Active blockers / data-integrity

1. **`cleo memory sweep --rollback <runId>` dispatch gap** — returns `E_INVALID_OPERATION: Unknown operation: mutate:memory.sweep` in v2026.4.141. The rollback gateway is not wired in `packages/cleo/src/dispatch/domains/memory.ts`. Operators are stuck using direct SQL workarounds. **~20 LOC fix.**
2. **68-candidate BRAIN sweep awaiting owner approval** — 2 `brain_backfill_runs` rows (kind=`noise-sweep-2440`, status=`rolled-back`). 50 of 68 candidates are decisions. Owner decision: re-run+approve (irreversible purge) or abandon.
3. **`backup-pack.test.ts` staging-dir cleanup failure** — pre-existing test failure that surfaced during T1414 worker's investigation. Unrelated to T1402/T1414 scope. **File as follow-up task.**

### P1 — Real PLAN.md gaps (post-correction; smaller than audit suggested)

4. **Wave 7 `reconcile-scheduler.ts` absent** — periodic reconciler scheduler from PLAN.md §7.3 was never built. Reconciliation runs only on-demand or via dispatch reflex. Medium scope.
5. **PLAN.md Part 10 T1151 subtasks never filed** — T1152 step-level retry, T1153 reflection agent, T1154 session tree, T1155 soft-trim pruning, T1156 context budget, T1158 TUI adapter, T1159 pluggable filesystem/sandbox. The 4-pillar self-healing vision remains aspirational.
6. **Wave 5 §5.3 dispatcher-to-durable-queue upgrade never done** — `dispatcher.ts` still uses `setImmediate` fire-and-forget for dialectic evaluations. Should call `enqueueDerivation()` instead. Process crashes lose in-flight evaluations.
7. **Wave 8 §8.3 representation-via-dialectic** — sigil schema lacks `mental_model`/`representationJson` columns; `DialecticInsights.peerRepresentationDelta` merge logic absent. Either descoped or unimplemented.

### P2 — Ship-state cleanup

8. **T1414 CHANGELOG entry** — T1414's commit didn't bump versions or add a CHANGELOG entry (it was a fix between releases). Either roll into the next release's CHANGELOG or leave as silent fix.
9. **`observation_embeddings` / `turn_embeddings` tables** — PORT-AND-RENAME §2 spec items still unconfirmed (the column-level deltas are in lazy ensureColumns; the table-level ones aren't). Needs targeted grep verification.
10. **`tasks-sqlite.ts` doesn't exist** — `tasks-schema.ts` ships Drizzle defs; the open/init lives in `task-store.ts` instead. Mild naming inconsistency vs. memory/nexus/signaldock pattern.

### P3 — Process / pump

11. **T1403 Release post-deploy-execute stage** — filed but not implemented. CI has no `execute-payload` stage for migrations/sweeps/registry-publishes.
12. **T1404 Parent-closure-without-atom enforcement** — filed but not implemented. `cleo complete <epicId>` for epics doesn't yet require evidence atoms or merkle inheritance from children.
13. **`conduit-schema.ts` extraction** — split conduit's hybrid file to match the canonical naming pattern.

### Done as of this session (closure record)

- T1107 — verified COMPLETE (14/14 verbs wired, dispatch + CLI + 41 tests, audit confirmed)
- T1147 W7 — reconciler core + sweep executor + noise detector shipped (NOT phantom-closed)
- T1148 W8 — sigil schema + SDK + 8 sigils populated + spawn-prompt section + M7 gate
- T1149 W9 — A2A topics + SDK + CLI + spawn-prompt section (via T1252 child, NOT phantom-closed)
- T1262 — CANCELLED with rationale (scope superseded by structural reconciliation)
- T1386 — full PSYCHE LLM port (15/15 children, 14 source files, 3 backends)
- T1402 — staging table rename + administrative close (THIS SESSION)
- T1414 — CLEO-INJECTION.md regression fix (THIS SESSION)
- mcp-adapter — published @ 2026.4.141

---

## Meta-failure acknowledgement: WHY safeguards drifted in earlier sessions

Owner observation: *"the cleo tasking System is supposed to be bleeding edge and not allow for all of these deviations."* Honest analysis of what went wrong:

**The CLEO safeguards are working correctly.** Every gate is real: `cleo verify` runs `pnpm-test`/`biome`/`tsc` LIVE and refuses to set the gate if exit code is non-zero. `cleo complete` rejects when gates aren't green (`E_LIFECYCLE_GATE_FAILED`). `cleo add` enforces depth-3 max nesting. Demonstrated this session — T1402 close was BLOCKED by a real test failure that the safeguard caught (CLEO-INJECTION.md sprawl), and ONLY closed after T1414 fixed the regression.

**What actually went wrong**: the **owner-override pattern was over-used**. `force-bypass.jsonl` shows:
- T1387–T1401 (15 children of T1386): all closed in a batch with `CLEO_OWNER_OVERRIDE=1` reason "T1386 overnight slot" using a single shared `tool:pnpm-test` evidence atom.
- 7 parent epics (T1147, T1148, T1075, T1259, T1261, T1145, T1146) closed with `verification=null`.
- `cleo lifecycle skip T1075 consensus --reason "Council ratified"` + 7 more lifecycle bypasses on T1075 stages.

The overrides were always audited (jsonl trail), but **the high-velocity batch-override pattern hid sprawl regressions for 5+ versions** — exactly the regression we just caught + fixed. The CLEO-INJECTION.md size growth probably entered the codebase during one of those overridden batches.

**This session's concrete fix to the meta-failure**:
1. **No owner-overrides were used** — even when convenient. T1402 close required a real test passing.
2. **When the safeguard caught a regression, we filed it (T1414) and fixed it** instead of overriding.
3. **Concrete pumps that need actual implementation** to prevent future drift:
   - **T1404** (parent-closure-without-atom) — make `cleo complete <epic>` require either direct atoms OR merkle inheritance from children (not bare rollup-only)
   - **T1403** (post-deploy-execute) — Release workflow must run declared post-deploy steps + verify them
   - **New pump T-PUMP-OVERRIDE-CAP**: cap `CLEO_OWNER_OVERRIDE` invocations per session to N; require an ADR-style waiver doc above N. Currently zero limits.
   - **New pump T-PUMP-BATCH-EVIDENCE**: a single shared `tool:pnpm-test` atom across N>3 child tasks should require an explicit `--shared-evidence` flag and an explanation; current default permits silent batch-share.

---

## Specific next-session priorities (ordered)

1. Wire `cleo memory sweep --rollback` dispatch gateway (P0, ~20 LOC). Unblocks safe sweep management.
2. File + fix `backup-pack.test.ts` staging-cleanup regression (P0, surfaced this session).
3. Owner decision on the 68-candidate BRAIN sweep (re-run+approve OR abandon).
4. Implement T1403 (post-deploy-execute Release stage) and T1404 (parent-evidence enforcement) as pumps. These prevent the meta-failure from recurring.
5. File `reconcile-scheduler.ts` task (P1; PLAN.md §7.3 gap).
6. Decide on T1152–T1156, T1158, T1159 (T1151 4-pillar subtasks): file as concrete tasks OR explicitly archive as deferred-future-scope.
7. **Do NOT attempt v2026.5.0** without explicit RCASD planning + council session.

---

## Key file paths (absolute)

- Sigil schema: `/mnt/projects/cleocode/packages/core/src/store/nexus-schema.ts`
- Sigil SDK: `/mnt/projects/cleocode/packages/core/src/nexus/sigil.ts`
- Sigil migration: `/mnt/projects/cleocode/packages/core/migrations/drizzle-nexus/20260424140538_t1148-add-sigils-table/migration.sql`
- Sigil sync: `/mnt/projects/cleocode/packages/core/src/nexus/sigil-sync.ts` (T1414's session)
- M7 gate: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/sentient.ts` (setTier2Enabled, line ~420)
- Dispatch reflex: `/mnt/projects/cleocode/packages/core/src/sentient/propose-tick.ts` (checkBrainHealthReflex)
- MCP adapter: `/mnt/projects/cleocode/packages/mcp-adapter/`
- LLM port: `/mnt/projects/cleocode/packages/core/src/llm/` (14 files, 3 backends)
- LLM contracts: `/mnt/projects/cleocode/packages/contracts/src/operations/llm.ts`
- Conduit topics: `/mnt/projects/cleocode/packages/core/src/store/conduit-sqlite.ts:287-333` (DDL); `packages/core/src/conduit/local-transport.ts:299-558` (SDK methods)
- Brain staging: `/mnt/projects/cleocode/packages/core/src/store/memory-schema.ts` (brainObservationsStaging)
- Comprehensive audit (with corrections noted here): `/mnt/projects/cleocode/.cleo/agent-outputs/T1075-COMPREHENSIVE-SCOPE-AUDIT.md`

---

## How to use this file

This is the SSoT. When a future agent sessions opens:
1. Read this entire file FIRST. Trust it over all prior session-specific handoff prose.
2. Verify the "Definitive current state" table values against live npm + git before acting.
3. Read the audit corrections — do not re-propagate the phantom-close claims about T1149 or PORT-AND-RENAME §2.
4. The "Outstanding scope" section is the single ranked backlog. Do not file work that contradicts a P0/P1 item without first closing or explicitly deferring it.
5. The "Meta-failure" section is the policy: NO owner-overrides without (a) a regression task filed first AND (b) a clear unrelated-failure rationale documented in the override reason. Default to filing + fixing, not overriding.
6. Update this file at the end of every session with one concise "What this session did" entry — DO NOT append new TL;DRs at the top in addenda. Replace stale state cleanly.
