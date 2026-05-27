# SPECIALIST A — Architecture & SDK Core Audit
**Date**: 2026-04-28
**Domain**: packages/core, sentient subsystem, BRAIN integrity, universal semantic graph, autonomy loop, ADR backlog, SDK surface, ontology refactor
**Scope assessed**: T942 + 6 child epics; T945-T946; T1009-T1012; T1029-T1032; T1139; T1494-T1495; T1535-T1554

---

## 1. Domain Summary

The architecture/SDK domain is in a **highly transitional state**: roughly 70% of the high-priority items in the official task records appear to already have shipped implementations, but the task DB has not been reconciled. The official "Sentient CLEO Architecture Redesign" meta-epic T942 lists 6 children (1 done) yet `cleo list --parent T942` returns 7 children with 1 done — and all 6 "pending" Tier 3 children have substantive code in `packages/core/src/sentient/` (1,059-line `tick.ts`, 264-line `merge.ts`, full `revert-walker.ts` + `revert-executor.ts`, `cleo revert` CLI, `baseline.ts` with Ed25519, `kill-switch.ts` with 10-step labels, `allowlist.ts` with `ownerPubkeys`).

T948 (SDK + REST surface — issue #97) is **DONE** with full evidence (verification.passed=true, completedAt=2026-04-27). The new T1555 audit-followup epic (created 2026-04-28) introduces 20 ADR-058 / DRY / test-coverage tasks, of which **4 pairs are exact duplicates** (T1544/T1550, T1545/T1551, T1546/T1552, T1547/T1553).

Ratio: ~50% completed-but-unverified, ~30% genuinely outstanding (P1/P2), ~15% stale or duplicates, ~5% test pollution. The biggest *real* gap is governance hygiene (close stale tasks, dedupe T1555 children) more than missing code.

---

## 2. Outstanding Epics

| ID | Title | Real Status | Children Open | Blockers | Recommendation |
|----|-------|-------------|---------------|----------|----------------|
| T942 | Sentient CLEO Architecture Redesign | Code mostly shipped, records stale | 6 of 7 (T1131 done) | None — verification only | **Reconcile**: verify T1010-T1012 + T1030 against shipped code; audit acceptance per item; close completed |
| T911 | Install Canonical Layout + Sandbox Harness Coverage | Mixed (T1009 unblocked sandbox, T923/T925 small) | 3 of 4 | T923 needs codex Dockerfile; T925 implemented but tests not run | Verify T925 evidence; T923 small task |
| T1106 | CLOSE-ALL + sandbox proof | **CANCELLED** | 1 (T1139) | Parent cancelled but T1139 still pending | Close T1139 — it's superseded by T1147 (DONE) |
| T1555 | Audit-2026-04-28 follow-up remediation | Fresh (created 2026-04-28); 4 duplicate pairs | 20 (0 done) | Self-review needed first — **8 of the 20 are dupes** | Dedupe immediately, then prioritize T1535/T1538/T1548 ADR-058 migrations |
| T948 | SDK + REST Surface (issue #97) | **DONE** 2026-04-27 (verified true) | 0 — but T1493 pending under it | None | Close T1493 follow-up, then mark domain shipped |
| T1467 | T-THIN-WRAPPER CLI migration | **DONE** 2026-04-28 | T1495 pending | None | Close T1495 ADR-058 SSoT-EXEMPT decision (small) |

---

## 3. Priority-Ranked Task List

### P0 — Ship-blocking
*(none in this domain — all critical Tier 3 + SDK work has shipped code)*

### P1 — High-value, ready
| ID | One-line | Why | Unblocks | Size |
|----|----------|-----|----------|------|
| **T1029** | abort-to-clean-state protocol (`abortExperiment` orchestrator) | No `abort.ts` file exists in core/sentient; merge.ts has FF-abort but no docker-stop+worktree-remove orchestrator | DESIGN.md §8 already specifies; nothing | small |
| **T1032** | merge ritual integration test (kill-switch at step 6) | No `experiment-runner.test.ts` exists; depends on T1030/T1029 | T1029, T1030 | small |
| **T1535** | Migrate dispatch/sticky.ts to OpsFromCore (ADR-058) | ADR-058 published; pattern proven in conduit/nexus/admin | None | medium |
| **T1538** | Migrate dispatch/orchestrate.ts to OpsFromCore | Same pattern; orchestrate is a hot path | T1535 (precedent) | large |
| **T1548** | Migrate dispatch/docs.ts to TypedDomainHandler (ADR-058) | Already partially done in commit `bbb52e75f` (T1529/P0); verify remainder | None | medium |
| **T1494** | Harden core public API surface — 56 wildcard exports in core/src/index.ts | Concrete drift risk; STABILITY.md only guards `./internal` not `index.ts` | None | medium |
| **T1543** | Add releaseCoreOps + migrate dispatch/release.ts | ADR-058 follow-up; release path needs typing | None | medium |

### P2 — High-value, blocked or needs-spec
| ID | One-line | Why | Unblocks | Size |
|----|----------|-----|----------|------|
| **T945** | Universal Semantic Graph — promote brain_page_nodes | Large; brain_links.ts exists but Studio integration + SDK traversal not shipped | T945 design doc; needs spec | large |
| **T946** | Autonomous Self-Improving Loop (Tier 1/2/3) | Code largely landed (tick.ts, daemon.ts, baseline, ed25519); needs **acceptance audit** to declare done | Verification, not code | large |
| **T1009** | Tier 3 agent-in-container sandbox harness | Real outstanding — sandbox/Dockerfile work in /mnt/projects/cleo-sandbox/, not in this repo | Cross-repo coordination | large |
| **T1010** | Tier 3 externally-anchored baseline + signed audit | Mostly shipped (baseline.ts, tsa-anchor.ts, allowlist.ts, kms.ts) — verify acceptance items 1–7 against code | Verification | large |
| **T1011** | Tier 3 FF-only merge + per-step kill-switch | Shipped in merge.ts + kill-switch.ts + tick.ts. Verify integration test exists for "kill at step 6" | Verification | medium |
| **T1012** | `cleo revert --from <receiptId>` | Shipped (revert.ts CLI + revert-walker + revert-executor + revert-integration.test). Verify ownerPubkey gate | Verification | medium |
| **T1030** | full merge ritual orchestrator (`experiment-runner.ts`) | tick.ts has `runTier3Tick` covering same flow; spec calls for separate file. Decide: rename or write new | Design call needed | medium |
| **T1546/T1552** | DrizzleNexusDb shared type (DUPLICATE PAIR) | Cleanup — eliminate one | Dedupe first | medium |
| **T1547/T1553** | core/compliance unit tests (DUPLICATE PAIR) | Cleanup — eliminate one | Dedupe first | medium |

### P3 — Low-value or stale, consider archive
| ID | Action | Reason |
|----|--------|--------|
| **T1139** | **CLOSE — superseded** | T1147 (`brain-reconciler.ts` 312 LOC) shipped 2026-04-27 explicitly absorbed T1139 scope per its module docstring: "*This module absorbs the T1139 scope*" |
| **T1495** | Close as `note:keep-intentional` | Pipeline contracts intentionally empty per T1446 design |
| **T1493** | Small doc task; do once | SDK boundaries already de-facto enforced |
| **T1544 OR T1550** | Archive duplicate | Same task |
| **T1545 OR T1551** | Archive duplicate | Same task |
| **T1546 OR T1552** | Archive duplicate | Same task |
| **T1547 OR T1553** | Archive duplicate | Same task |
| **T1549** | Tiny @deprecated annotation fix | 5-min task |
| **T1554** | README files in core namespaces | Nice-to-have |

---

## 4. Deep Findings

### Finding 1 — T1147 absorbed T1139 but T1139 record never closed
File `/mnt/projects/cleocode/packages/core/src/memory/brain-reconciler.ts:14` explicitly says: *"This module absorbs the T1139 scope (decision/learning/pattern supersession) and adds a scheduled `reconciler` trigger type."* T1147 is `done` (verification.passed=true, completedAt=2026-04-28T04:35:38Z, commits `b6924c6d8` + `740ef2322`). T1139 is still `pending` with `pipelineStage=implementation` under cancelled parent T1106. **Action: close T1139 as superseded-by:T1147**.

### Finding 2 — Tier 3 merge ritual code exists but task acceptance criteria are stale
T1011 acceptance #6 demands "*Integration test: kill-switch fires at step 6 (pre-sign) → verify merge does NOT happen*". The task is pending. But:
- `kill-switch.ts:41-58` defines all 10 step labels (`pre-pick, post-pick, pre-spawn, post-spawn, pre-verify, post-verify, pre-sign, post-sign, pre-merge, post-merge`).
- `merge.ts:200-245` implements FF-only abort with `{ merged: false, reason: 'ff-failed-abort' }` (acceptance #1 ✓).
- `tick.ts:781-1059` is the Tier 3 ritual orchestrator (`runTier3Tick`, exported, with @task T946 docstring).
- `__tests__/tier3-tick.test.ts` covers "Kill-switch mid-tick: flip kill flag at step post-pick → halt before merge" (acceptance #6 ≈ ✓).

Gaps remaining: (a) the dedicated `experiment-runner.ts` separate file from T1030 doesn't exist — `tick.ts` plays that role. (b) `abortExperiment` named export from `abort.ts` doesn't exist (T1029) — abort logic is inline in tick.ts. The decision is **architectural**: extract to T1029/T1030 spec OR document tick.ts as the SSoT and close.

### Finding 3 — `cleo revert --from <receiptId>` is shipped, T1012 record stale
File `/mnt/projects/cleocode/packages/cleo/src/cli/commands/revert.ts:181-230` implements the CLI with `--from <receiptId>` validation. `core/sentient/revert-walker.ts` (83 LOC) + `revert-executor.ts` (320 LOC) + `chain-walker.ts` (314 LOC) cover acceptance items 1-3. `__tests__/revert-integration.test.ts` exists. Acceptance #7 (ownerPubkey signed attestation) maps to `allowlist.ts` (311 LOC) which reads `.cleo/config.json.ownerPubkeys`. **All 7 acceptance items appear satisfied** — task needs gate verification + close.

### Finding 4 — T1555 audit-followup epic has 4 exact duplicate task pairs
Created 2026-04-28T19:09:27Z (today). The duplicate pairs:
- **T1544** "Add unit tests for core/adrs namespace" ≡ **T1550** "Add unit tests for core/adrs namespace (syncAdrsToDb, findAdrs, validateAllAdrs, listAdrs)" — same package, T1550 is just more verbose.
- **T1545** "Resolve issue/template-parser.ts vs templates/parser.ts DRY violation" ≡ **T1551** "...DRY violation — designate SSoT" — identical scope.
- **T1546** ≡ **T1552** "Add shared DrizzleNexusDb type" — verbatim title.
- **T1547** ≡ **T1553** "Add unit tests for core/compliance" — verbatim scope.

This is a **DB hygiene bug** — the audit synthesizer created entries twice. **Action: archive T1550/T1551/T1552/T1553** (or the T1544/T1545/T1546/T1547 pairs) before any work begins.

### Finding 5 — ADR-060 is missing from the canonical numbering
`docs/adr/` jumps from `ADR-059-override-pumps.md` to `ADR-061-project-agnostic-verify-tools.md`. ADR-060 was either skipped, drafted-then-deleted, or renamed. No task tracks this. **Action: trace via `git log -- docs/adr/ADR-060*` (no result) — confirm intentional skip OR fill the slot. This matters for forge-ts ADR enforcement (T1561 V5).

### Finding 6 — `core/src/index.ts` has 56 wildcard namespace exports, contradicting T1494
T1494 says "*Core relies on wildcard exports and /internal paths. Tighten public surface: explicit named exports.*" Inspection confirms: 56 lines of `export * as <ns> from './<ns>/index.js';`. Whether that counts as "wildcard exports" is a definitional question — they ARE namespaced, not flat wildcards. The genuine wildcard exports live inside each `<ns>/index.js`. T1494 acceptance is ambiguous; needs scoping.

### Finding 7 — T948 verification evidence is exemplary
T948 verification atoms include 11 specific commits (`33fbe9bf6` through `ce6197200`), 4 doctests files, biome+tsc clean, 36 passing tests, security note "no-new-attack-surface". This is the gold standard. Other epics in this domain should mirror this evidence pattern when reconciling.

---

## 5. Recommendations to Operator

1. **Reconcile T942 children against shipped code (high ROI, ~2 hours)**: Run `cleo verify` with `commit:` + `files:` evidence atoms for T1010, T1011, T1012, T1030. Most acceptance items map to existing files. Close 3-4 of the 6 pending children today. (Same playbook as T948.)
2. **Close T1139 as superseded-by:T1147 (5 min)**: Brain-reconciler.ts module docstring explicitly says it absorbs T1139. Use `cleo memory observe` to record decision; mark T1139 cancelled.
3. **Dedupe T1555 (10 min)**: Archive T1550, T1551, T1552, T1553 (or their pairs). The duplicate pairs are a DB-quality issue that hides true work backlog and inflates child counts.
4. **Decide T1029/T1030 architecture (15 min, then medium impl)**: Either (a) extract `abort.ts` + `experiment-runner.ts` from tick.ts per the original spec, OR (b) document tick.ts as the ritual SSoT and rewrite T1029/T1030 acceptance to point at tick.ts. (a) is cleaner for forge-ts but adds 200 LOC churn; (b) is pragmatic.
5. **Tackle ADR-058 migration wave (T1535 + T1538 + T1548 + T1543) in parallel**: ADR-058 published 2026-04-26; pattern proven in T1437 (admin), T1439 (conduit), T1440 (nexus). Four remaining domains (sticky/orchestrate/docs/release). Estimated 1 day total with parallel agents.

---

## 6. Test-Fixture Pollution Found

No T000-T035, T100-T106, T1333-T1378, T932-prefix, EXT1, T1246-T1248, T1340/T1367/T1369-import IDs surfaced in the queries against this domain. Only one test-fixture-flavored ID was observed:

| ID | Why suspicious | Action |
|----|---------------|--------|
| T1052 | "Manual add test role bug" — pending, low priority, no parent, no acceptance — looks like a manual dispatch smoke-test artifact | archive |
| T1053 | "Dispatch direct test bug" — same shape as T1052 | archive |
| T999 | Used as TASK_FIXTURE in `tier3-tick.test.ts:39` — if this exists in DB, it's leakage | check; if exists → archive |

These are not in this domain's critical path but should be cleaned during the next DB-integrity sweep (cf. T1499 pattern, which already re-parented 51 orphans).

---

**End of audit. Total task records examined: ~45. Total code files cross-referenced: ~12. Total commits scanned: ~70 (last 14 days).**
