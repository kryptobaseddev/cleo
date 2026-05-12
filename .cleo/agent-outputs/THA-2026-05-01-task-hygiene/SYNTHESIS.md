# Task-Hygiene Synthesis (T-HYGIENE-RESET)

**Date**: 2026-05-01
**Scope**: Cross-cutting synthesis of 4 parallel hygiene audits (H1 epics, H2 orphans, H3 deps, H4 content)
**Status**: Discovery complete; remediation plan pending HITL approval. Zero mutations made.

---

## 1. Big picture

| Dimension | Verdict | Severity |
|---|---|---|
| Dependency graph integrity (H3) | **Clean** — 0 cycles, 0 broken refs, 0 order violations | None |
| Epic registry hygiene (H1) | Mixed — 2 prematurely closed, 2 ready-to-close, 35 empty, 9 stale | Medium |
| Orphans + stale tasks (H2) | **Heavy noise** — 52 test placeholders + 14 stuck-active + 22 top-level orphans + 10 orphan-done = ~98 cruft items | Medium |
| Content quality (H4) | **Holes** — 17 missing descriptions, 21 missing files scope, 7 stale-stage, 8 untestable AC | Medium-High |

**Total active task count**: 435. Of these, ~98 are direct cruft (cancellation candidates), ~50 need content fixes, ~10 need structural fixes. **Net: ~158/435 (≈36%) of active tasks need some action.** The dep graph itself is healthy — no deadlocks or corruption.

---

## 2. The 4 audit reports (full data)

| Report | Path | Audit focus |
|---|---|---|
| H1 | `.cleo/agent-outputs/THA-2026-05-01-task-hygiene/H1-epic-registry.md` | Epic registry + child rollup integrity |
| H2 | `.cleo/agent-outputs/THA-2026-05-01-task-hygiene/H2-stale-orphans.md` | Stale + orphan tasks |
| H3 | `.cleo/agent-outputs/THA-2026-05-01-task-hygiene/H3-dep-graph.md` | Dependency graph integrity |
| H4 | `.cleo/agent-outputs/THA-2026-05-01-task-hygiene/H4-content-quality.md` | Acceptance criteria + content quality |

---

## 3. Critical findings (need decision before any work)

### 3a. Premature-closed epics (DATA INTEGRITY BUG — H1 Type-B)

Two epics are marked `status=done` but still have pending children. This is the most dangerous defect because it asserts work is complete that isn't:

- **T1467**: marked done; pending children T1491, T1495
- **T1603**: marked done; pending children T1619, T1620, T1621

**Risk**: orchestrators reading "done" in briefings will skip these as completed; the pending children become invisible.

**Decision needed**: For each — (a) reopen the epic and finish the children, OR (b) cancel the pending children if their work is no longer needed.

### 3b. Ready-to-close epics (H1 Type-A)

- **T1563** (Master Audit Epic): 4/4 children done, awaiting owner action (push + release tag)
- **T1622** (Cherry-pick Doctrine Cleanup): 3 done + 1 cancelled = effectively complete; T1622 itself was the parent split into T1623/T1624/T1625

**Decision needed**: confirm we can mark these epics done.

### 3c. Stage drift on T1232 (H1 Type-E + H4 Q7)

T1232 is at `pipelineStage=release` with 0/13 children done — most severe drift in the system. The stage assertion is wrong by 5 stages.

**Decision needed**: reset stage to research/implementation OR cancel epic if abandoned.

### 3d. 13 real-initiative empty epics (H1 Type-C)

Out of 35 empty epics, 13 are real initiatives that never got decomposed into child tasks. Examples (from H1 report): epics representing genuine work but no actionable children.

**Decision needed**: spawn RCASD for each, OR explicitly defer to a future quarter.

### 3e. 17 EP-series Nexus epic workers with no descriptions (H4 Q5)

These are spawned epics with empty `description` fields. Workers have no context.

**Decision needed**: backfill descriptions from the parent's spec/RCASD output, OR cancel if no longer relevant.

---

## 4. Recommended remediation: T-HYGIENE-RESET epic (4 waves)

### Wave A — Bulk cancel cruft (low-risk cleanup)

**Goal**: remove the ~80–100 cancellation candidates that confuse the active set.

| Action | Count | Reversibility |
|---|---|---|
| Cancel test/placeholder tasks (per H2 §9) | 52 | Reversible via `cleo restore` |
| Cancel stuck-active test tasks (per H2 §10 P2) | 14 | Reversible |
| Cancel scaffolding/import-artifact epics (per H1 Type-C subset) | 13–18 | Reversible |
| Cancel low-value floating tasks (per H2 §10 P5) | 7 | Reversible |

**Wave A acceptance**: active task count drops by ~85–100; orchestrate ready/find queries return cleaner results; bulk cancellations all use `--reason "T-HYGIENE-RESET-A: <category>"`.

### Wave B — Fix structural defects

**Goal**: data integrity. Every task in a state that matches reality.

| Action | Tasks | Risk |
|---|---|---|
| Resolve premature-closed T1467 (decision per 3a above) | T1467, T1491, T1495 | Low |
| Resolve premature-closed T1603 | T1603, T1619, T1620, T1621 | Low |
| Auto-complete T1563 (after owner push+tag) | T1563 | Low |
| Auto-complete T1622 | T1622 | Low |
| Reset T1232 stage drift to actual stage | T1232 | Low |
| Initialize LOOM for T1563, T1566, and any other epics with `ready=0 because LOOM not initialized` | per H3 §wave/dep | Low |
| Resolve other 3a–3c decisions | per § | Low |

**Wave B acceptance**: zero premature-closed epics; zero stage-drift cases; LOOM initialized for all active epics.

### Wave C — Fix orphans

**Goal**: every task has a sensible parent or is intentionally top-level.

| Action | Tasks |
|---|---|
| Re-parent 10 orphan-done/archived tasks (per H2 §5) | 10 |
| Re-parent 22 top-level orphan tasks OR promote to epic OR cancel (per H2 §7) | 22 |

**Wave C acceptance**: zero tasks under closed parents; zero unintentional top-level orphans.

### Wave D — Fix content quality

**Goal**: every active task is actionable — has description, files scope, testable AC.

| Action | Tasks |
|---|---|
| Add descriptions to 17 EP-series Nexus epic workers (per H4 Q5) | 17 |
| Add files scope to 21 type=task tasks lacking it (per H4 Q4) | 21 |
| Rewrite 8 untestable AC entries (per H4 Q3) | 7 tasks |
| Fix 3 AC/description mismatches (per H4 Q6) | 3 |
| Resolve 7 stale-stage tasks (per H4 Q7) | 7 |
| Spawn RCASD for 13 real-initiative empty epics (per H1 Type-C) | 13 |

**Wave D acceptance**: every active task has description ≥50 chars, type=task tasks have files scope, AC entries are testable, stage matches actual progress.

---

## 5. Tracking via `cleo docs`

For each underlying audit + this synthesis, attach to the relevant tracking task. Once the user approves and a `T-HYGIENE-RESET` epic is filed, attach all 5 markdown reports as docs to that epic so future orchestrators can re-derive the same picture.

Suggested attachments:
- Synthesis → T-HYGIENE-RESET parent epic
- H1 → T-HYGIENE-RESET (registry sub-task)
- H2 → T-HYGIENE-RESET (orphans sub-task)
- H3 → T-HYGIENE-RESET (dep-graph confirmation, file as evidence)
- H4 → T-HYGIENE-RESET (content sub-task)

For premature-closed epics, attach H1 directly to T1467 and T1603 as evidence:
- `cleo docs add T1467 .cleo/agent-outputs/THA-2026-05-01-task-hygiene/H1-epic-registry.md --description "Premature-closed evidence: pending children T1491+T1495"`
- `cleo docs add T1603 .cleo/agent-outputs/THA-2026-05-01-task-hygiene/H1-epic-registry.md --description "Premature-closed evidence: pending children T1619+T1620+T1621"`

---

## 6. HITL decisions required

1. **Cruft cancellation policy** (Wave A) — cancel all 80–100 in one bulk pass with audit reason, OR review them one-by-one? I lean bulk-with-reason since they're already classified by audit.
2. **T1467 + T1603 premature-close resolution** — reopen and finish, OR cancel the pending children? Need per-epic call.
3. **T1232 stage drift** — what stage SHOULD it be at? Reset to research, or cancel? You know the context.
4. **13 real-initiative empty epics** — which to decompose now, which to defer, which to cancel?
5. **17 EP-series no-description tasks** — reconstruct descriptions from parent context, or cancel as no-longer-relevant?
6. **Wave parallelism** — Waves A+B+C+D run sequentially or can they overlap (different file/task scopes)?
7. **Should I file T-HYGIENE-RESET now** as the parent epic, with sub-tasks as draft (not yet executed) so the structure exists? Or wait for you to approve waves first?

---

## 7. What I will do next

If approved:

1. Create epic `T-HYGIENE-RESET` with the 4 waves (W-A, W-B, W-C, W-D) as child tasks; each wave decomposed into atomic action tasks per section 4.
2. Attach all 5 audit MD files to the epic via `cleo docs add`.
3. Attach H1 to T1467 and T1603 as evidence of premature-closure.
4. Spawn workers per wave in dependency order. Wave A first (bulk cancel) since it's purely additive cleanup. Then B (structural). Then C+D in parallel (orphans + content are independent).
5. After each wave completes, verify the active task count and rollup integrity, then proceed to next wave.

I will NOT spawn any worker or make any cleo mutations until you approve. The audit data is read-only — current state is unchanged.
