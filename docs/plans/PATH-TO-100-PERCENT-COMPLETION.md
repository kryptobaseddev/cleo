# Path to 100% Completion — CLEO Masterplan

**Date**: 2026-04-15
**Author**: cleo-prime orchestrator (Claude Opus 4.6)
**Mandate (owner 2026-04-15)**: "Plan out the path to full completed 100% cleaned up and finished all EPICS and tasks. Zero tasks remaining. All organized. Nothing outstanding. Most bleeding-edge agentic project management. Living Brain + Codebase Nexus. Any LLM drop-in via CLEO CORE knows where the project is at. Zero hesitation, zero hallucinations. Batteries included."

---

## §1 — Database Integrity (Owner Question on CRDT/Y.js)

### Current SQLite + WAL/SHM state

CLEO uses better-sqlite3 with WAL mode. WAL gives us:
- Crash-safe writes (commit on fsync)
- Concurrent readers + single writer
- Auto-checkpointing on commit

**The 21:06 wipe incident (T724)** was NOT a WAL issue — root cause was *concurrent multi-process load + system stress* (Railway CLI core dump in same window). `autoRecoverFromBackup` (T5188) restored within 2 min from `.cleo/backups/sqlite/tasks-YYYYMMDD-HHmmss.db` snapshots.

### Why NOT Y.js / CRDTs (despite their appeal)

| Concern | SQLite + WAL | Y.js / Automerge CRDT |
|---|---|---|
| Multi-writer conflict resolution | Last-writer-wins on row | Merge ops without conflict |
| Storage size | Compact | 5-50× larger (op log) |
| Query model | SQL + indexes | Tree traversal only |
| Tooling maturity | 25 years | ~5 years |
| Cross-process write coordination | Single-writer (works for CLEO's 1-process-at-a-time CLI pattern) | Native multi-writer |
| Disaster recovery | Backup files + WAL log | Snapshot + op replay |
| Type safety w/ Drizzle | First-class | Adapter required |

**Decision**: Stay on SQLite + WAL. CRDT is the wrong tool for CLEO's workload (mostly single-process CLI with batch operations). The wipe wasn't a write-conflict — it was process kill mid-operation.

### Hardening (T724 follow-ons + new)

**T754 (NEW)**: Add `journal_mode=WAL` + `synchronous=NORMAL` + `wal_autocheckpoint=1000` PRAGMAs explicitly on every connection open (not relying on default).

**T755 (NEW)**: SQLite multi-writer guard via `proper-lockfile` — already a dep, but not used for tasks.db. Acquire an advisory lock for any DESTRUCTIVE operation. Concurrent readers still fine.

**T756 (NEW)**: Pre-mutation backup hook (suggested by T724 forensic but not implemented yet). Wrap any DELETE/DROP/TRUNCATE on tasks.db / brain.db with auto-`vacuumIntoBackupAll` before execution. Adds <100ms per destructive op.

**T757 (NEW)**: Litestream-style continuous replication. Replicate WAL to a sibling `.cleo/backups/wal-stream/` directory every 10s. Recovery point objective: 10 seconds, not 5 min.

---

## §2 — Path to ZERO Tasks (Wave Plan)

### Current epic landscape (verified from sqlite)

| Epic | Pending Children | Status |
|---|---|---|
| **T627 BRAIN-LIVING Stabilization** | 0 | ✅ done (T673+T684 closed; auto-completed 2026-04-16) |
| **T726 Memory Architecture** | 0 | ✅ done (Wave 1 all 11 children closed 2026-04-16) |
| **T673 STDP Phase 5** | done (Waves 0-4 shipped) | ✅ |
| **T687 Scaffolding** | done | ✅ |
| **T660 3D Brain** | done | ✅ |
| **T636 Canon Finalization** | 5 | Plan-moonbeam — needs new orchestrator wave |
| T601, T606, T609, T612 | test epics | ✅ CANCELLED (T757 clean-house 2026-04-16) |
| **T506 Dependency Packaging** | 0 | ✅ done (tarball verify gate + node-cron; closed T757) |
| **T513 Native Code Intelligence** | 0 children | Deferred low priority — foundations shipped |
| **T542 System Validation** | 0 | ✅ CANCELLED — superseded by T627/T726 |
| **T554 LLM Living Brain v3** | 0 | ✅ CANCELLED — superseded by T726 |
| **T563 Complete System Audit** | 0 | ✅ CANCELLED — subsumed into specific epics |
| **T234 Agent Domain Unification** | 0 | ✅ CANCELLED — achieved organically via signaldock split |
| **T631 Cleo Prime Persona** | 0 children | Deferred low priority — pragmatic behavior shipped |
| **T569 CLEO Dogfood Attestation** | 1 (T617) | T617 barrel export bug deferred; high priority next sweep |
| **T091 CLI Command Refactor** | 0 | ✅ CANCELLED — domain-prefixed ops shipped via T443 (T758 pass 2) |
| **T605 Fresh Test Epic** | 0 | ✅ CANCELLED — test fixture artifact (T758 pass 2) |
| **T046 Nexus Task Transfer** | 0 | ✅ COMPLETE — nexus.transfer implemented in core + CLI (T758 pass 2) |
| **T505 CLI Remediation** | 0 | ✅ COMPLETE — 55+ bugs addressed in v2026.4.27-v2026.4.30 (T758 pass 2) |
| **T578 NEXUS Web Portal** | 0 | ✅ COMPLETE — delivered via T619 + studio /code routes (T758 pass 2) |
| **T487 Commander-Shim Removal** | n/a | Pending medium — 113 files still use ShimCommand; real work confirmed |

### Wave 2 — Memory Architecture remaining (T726)

COMPLETE (2026-04-16 v2026.4.65): All Wave 1 tasks closed. T726 auto-completed.

### Wave 3 — Database Integrity (NEW T754-T757 above)

COMPLETE (v2026.4.64-65): T753 vitest hangs, T754 PRAGMAs, T755 lockfile guard, T756 backup hook all shipped.

### Wave 4 — Canon Finalization (T636 — 5 pending)

IN PROGRESS: Run a Lead to audit remaining T636 children, decompose any oversized ones, dispatch workers. Likely 1-2 ship cycles.

### Wave 5 — Test epic cleanup (T601, T606, T609)

COMPLETE (2026-04-16 T757 clean-house): 4 test epics (T601, T606, T609) + 5 children (T604, T607, T608, T611, T613) cancelled. T612 already done.

### Wave 6 — T506/T513/T563 audit + sweep

COMPLETE (2026-04-16 T757 clean-house):
- T506 closed (packaging unified via tarball gate)
- T563 cancelled (subsumed)
- T542 cancelled (superseded by T627/T726)
- T554 cancelled (superseded by T726)
- T234 cancelled (achieved organically)
- T513 deferred low priority (foundations shipped)

### Wave 7 — T569 Dogfood Attestation last item

One task remaining: T617 (NEXUS barrel export 29% accuracy miss). High priority bug, deferred to next NEXUS sweep.

### Wave 8 — Studio polish + docs

After all infra epics close:
- Studio observability dashboards (tier counts, pipeline distribution, GC threshold)
- docs/USING-CLEO.md — drop-in guide for any LLM agent
- Comprehensive USING-CLEO walkthrough video script (if owner wants)

### Wave 9 — "Ship the dream" release (CalVer: whatever YYYY.MM.patch corresponds to ship date)

CLEO is CalVer (YYYY.MM.patch) — version IS the calendar position, never SemVer. There is no "major version bump." If Wave 9 ships in May 2026 → v2026.5.0. If June → v2026.6.0. Bundle everything into the natural next month's release:
- Memory architecture v2 complete
- 3D Brain visible
- Auto-dream cycle running
- GC daemon installed by default
- OAuth + Ollama auto-configured
- Studio fully observable

---

## §2.5 — Clean-House Pass Results (2026-04-16 T757 / v2026.4.65)

**Before**: 114 pending tasks
**After**: 88 pending tasks
**Reduction**: 26 tasks closed/cancelled in one administrative pass

### Test epics cancelled (9 total)

| ID | Action | Reason |
|---|---|---|
| T601 | CANCELLED | T585 Test Epic — obsolete fixture |
| T606 | CANCELLED | Fresh Test Epic 2 — obsolete fixture |
| T609 | CANCELLED | BugFix Verification Epic — obsolete fixture |
| T604 | CANCELLED | Test fixture child of T601 |
| T607 | CANCELLED | Test fixture child of T606 |
| T608 | CANCELLED | Test fixture child of T606 |
| T611 | CANCELLED | Test fixture child of T609 |
| T613 | CANCELLED | Test fixture child of T612 |
| T612 | already done | LOOM lifecycle test — already completed |

### Shipped-but-unclosed closed (13 total)

| ID | Closed Via | Evidence |
|---|---|---|
| T673 | COMPLETE | STDP Waves 0-4 shipped; commit 167b30cd + ADR-046 |
| T684 | COMPLETE | Browser verification done; T663+T664 evidence at agent-outputs/T684 |
| T728 | COMPLETE | Shipped in commit 167b30cd Wave 1 bundle |
| T730 | COMPLETE | Shipped in commit 167b30cd Wave 1 bundle |
| T731 | COMPLETE | Shipped in commit 167b30cd Wave 1 bundle |
| T732 | COMPLETE | Shipped in commit 167b30cd Wave 1 bundle |
| T733 | COMPLETE | Shipped in commit 167b30cd Wave 1 bundle |
| T735 | COMPLETE | Shipped in commit 167b30cd Wave 1 bundle |
| T736 | COMPLETE | Shipped in commit 167b30cd Wave 1 bundle |
| T737 | COMPLETE | Shipped in commit 167b30cd Wave 1 bundle |
| T741 | COMPLETE | Shipped in commit 167b30cd Wave 1 bundle |
| T743 | COMPLETE | Shipped in commit 167b30cd Wave 1 bundle |
| T746 | COMPLETE | Shipped in commit 167b30cd Wave 1 bundle |

T726 + T627 auto-completed after all children closed.

### Orphans triaged (7 total)

| ID | Action | Reason |
|---|---|---|
| T234 | CANCELLED | SSoT achieved organically via signaldock split |
| T542 | CANCELLED | Superseded by T627/T726 work |
| T554 | CANCELLED | Superseded by T726 Memory Architecture v2026.4.62-65 |
| T563 | CANCELLED | Subsumed into T627 + T687 + T726 epics |
| T506 | COMPLETE | Packaging unified via tarball verify gate (T721) + node-cron |
| T513 | DEFERRED | Foundations shipped; full GitNexus absorption future work |
| T631 | DEFERRED | Persona deferred; behavior shipped pragmatically |

### Post-clean-house pending (T757)

88 pending tasks (down from 114). Remaining work centers on:
- T636 Canon Finalization (5 pending children)
- T569 Dogfood Attestation (1 pending: T617 barrel export bug)
- Remaining tasks in pipeline (T513, T631 deferred low)

See §2.6 for T758 Pass 2 results: 88 → **84 pending**.

---

## §2.6 — Clean-House Pass 2 Results (2026-04-15 post T757, T758)

**Before**: 88 pending (post T757)
**After**: 84 pending
**Reduction**: 4 tasks closed/cancelled + 2 deferred + 1 audited-kept

### Owner-locked cancellations

| ID | Action | Reason |
|---|---|---|
| T091 | CANCELLED | Domain-prefixed CLI ops shipped via T443 (commit 6a110e37f) + ongoing. Owner 2026-04-15 locked. |
| T605 | CANCELLED | Test fixture epic — same pattern as T601/T606/T609 from T757. Owner 2026-04-15 locked. |

### Owner-locked defers

| ID | Action | Reason |
|---|---|---|
| T298 | DEFERRED LOW | Sitar Config Platform — not active development per owner 2026-04-15 |
| T453 | DEFERRED LOW | CleoAgent Harness Testing — needed but separate, not now per owner 2026-04-15 |

### T487 Commander-Shim Audit

**KEEP PENDING at medium priority.** Owner said "commander-shim still heavily wired last I checked" — confirmed true. Evidence: 113 source `.ts` files import `ShimCommand`. `index.ts` TODO line 6 references native citty migration. 34 caamp files use commander directly. Only `code.ts` is native citty. Real future work, not blocking anything.

### T505 CLI Remediation Audit

**COMPLETED.** All 55+ bugs addressed via v2026.4.24-v2026.4.30. Evidence: v2026.4.27 (6 P0 fixes, commit 2f8a790a4), v2026.4.28 (all P1/P2/P3, 21 fixes, commit f3c927599), v2026.4.29 (45 total fixes + 8 duplicates removed, commit cc047cdeb). Memory/cli-removed-commands.md confirms 8 deprecated commands gone.

### Ghost epics closed with evidence

| ID | Closed | Evidence |
|---|---|---|
| T046 | COMPLETE | nexus.transfer implemented: CLI nexus.ts:627-680, core/nexus/transfer.ts, dispatch/registry.ts:2983-3026, transfer.test.ts |
| T505 | COMPLETE | v2026.4.27-v2026.4.30 release series, 55+ bugs, 8 duplicates removed |
| T578 | COMPLETE | Delivered via T619 (done): NexusGraph.svelte, /code/* routes, /api/nexus/* endpoints via cleo web studio |

### Post-pass-2 epic landscape

| Epic | Status | Note |
|---|---|---|
| T487 Commander-Shim | pending/medium | Real work — 113 files, keep |
| T513 Code Intelligence | deferred/low | Foundations shipped; full absorption future |
| T569 Dogfood Attestation | active/critical | T617 barrel export bug still pending |
| T631 Cleo Prime Persona | deferred/low | Pragmatic behavior shipped |

---

## §3 — The Vision (What 100% Looks Like)

### Bleeding-edge agentic PM with Living Brain + Codebase Nexus

```
┌─────────────────────────────────────────────────────────────────┐
│                  ANY LLM DROP-IN INTO CLEO                       │
│                                                                  │
│  cleo briefing                  ← know where the project is at  │
│  cleo memory find <topic>       ← long-term knowledge access    │
│  cleo nexus context <symbol>    ← codebase intelligence         │
│  cleo orchestrate ready <epic>  ← what work to pick up next     │
│                                                                  │
│  No hallucination — every recommendation cited to:              │
│   - tasks.db (real status, real history)                        │
│   - brain.db (real memory, tier-promoted facts)                 │
│   - nexus.db (real code symbols + relations)                    │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   ┌────▼─────┐         ┌─────▼──────┐        ┌────▼─────┐
   │  TASKS   │◄───────►│   BRAIN    │◄──────►│  NEXUS   │
   │ (epics,  │         │ (memory,   │        │  (code   │
   │ pipeline,│         │ patterns,  │        │ symbols, │
   │ history) │         │ decisions, │        │  graph)  │
   └────┬─────┘         │  STDP)     │        └────┬─────┘
        │                └─────┬──────┘             │
        │                      │                    │
        └──────────────────────┴────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  EXTRACTION GATE    │
                    │  (T736: dedup       │
                    │   + verifyAndStore) │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  TRANSCRIPT GC      │
                    │  (T731: sidecar     │
                    │   daemon + thresh)  │
                    └─────────────────────┘
```

### Cold-tier LLM auth flow (T752 confirmed)

```
resolveAnthropicApiKey()
  ├── ANTHROPIC_API_KEY env var       (CI/explicit)
  ├── ~/.local/share/cleo/anthropic-key (cleo-managed)
  └── ~/.claude/.credentials.json      (FREE for Claude Code users)
       ↓
  @ai-sdk/anthropic + claude-sonnet-4-6  ← OWNER LOCK (not Haiku)
       ↓
  generateObject({ schema: ZodSchema })
```

### Warm-tier local LLM (T752)

```
isOllamaAvailable()  ← postinstall auto-installs Ollama (T730)
       ↓
  ollama:gemma4-e4b-it  ← OWNER LOCK (instruction-tuned, not base)
       ↓
  generateObject() with Zod
       ↓
  fallback: @huggingface/transformers + Qwen3-0.6B-ONNX
       ↓
  fallback: cold-tier (Sonnet)
```

### Daemon architecture (T751 confirmed)

```
cleo daemon start
  → spawn(daemonScript, { detached: true, stdio: file })
  → child.unref()
  → write PID to .cleo/gc-state.json
       ↓
  cron.schedule('0 */6 * * *')   ← node-cron v4
       ↓
  runGC({ cleoDir })
       ↓
  threshold tiers: 70 watch / 85 warn / 90 urgent / 95 emergency
       ↓
  next CLI invocation: escalation banner if needed
```

### Auto-dream cycle (T628 + T729+T734 wiring)

```
Trigger tier 1: brain_retrieval_log delta > 50 since last consolidation
Trigger tier 2: idle 30+ min agent inactivity
Trigger tier 3: nightly cron 4 AM local
       ↓
  runConsolidation()
       ↓
  Step 1-8: existing (dedup, quality, contradictions, edges)
  Step 9a: backfillRewardSignals (T681)
  Step 9b: applyStdpPlasticity (T679 + Wave 2 algorithm extensions)
  Step 9c: applyHomeostaticDecay (T690 — 2%/day after 7-day grace)
  Step 10: runSleepConsolidation (T734 wired, runs LLM 4-step reflection)
  Step 11: runTierPromotion (Lead B's design)
       ↓
  brain_consolidation_events row logged
```

---

## §4 — Order of Operations (Strict)

1. **NOW**: Wave 1 close-out completes → v2026.4.63 ships
2. **NEXT**: T753 vitest hang fix lands
3. **THEN**: Wave 3 database integrity (T754-T757) — 1 ship cycle
4. **THEN**: Wave 4 Canon Finalization (T636) — 1-2 ship cycles
5. **THEN**: Wave 5 cancel test epics (1 atomic CLI pass)
6. **THEN**: Wave 6 audit T506/T513/T563 — 2-3 ship cycles
7. **THEN**: Wave 7 T569 last-11% sweep — 1 ship cycle
8. **THEN**: Wave 8 Studio polish + docs — 1 ship cycle
9. **THEN**: Wave 9 — natural next CalVer release whenever Wave 8 lands (YYYY.MM.patch). No "major bump" — CLEO doesn't do SemVer.

Total estimated ship cycles to ZERO TASKS: **8-12**.

Each ship cycle = orchestrator dispatches 4-6 parallel workers + 1 close-out + 1 release worker.

---

## §5 — Anti-Patterns to Avoid (lessons from today)

1. **Don't dispatch agents with prompts > 8KB** — 5 of 5 Wave 1 workers overflowed. Tighten prompts to <4KB. Reference docs by path; don't inline large specs.

2. **Don't run tests in agent prompts that depend on cron/daemon** — the 27 stuck vitest processes consumed system resources. Mock cron at unit-test boundary; reserve real-binary tests for E2E suites with explicit teardown.

3. **Don't publish from local** (ORC-011 still law). T727 + T716 + tarball-verify gate enforce this.

4. **Don't trust tier promotion silently** — T741+T743 added `tier_promoted_at` + reason for auditability. Lead B's countdown (T748) makes promotion visible.

5. **Don't trust transcripts as primary memory** — T729 fixed getTranscript bug (NEVER read root JSONLs since T144). Transcripts → extraction → brain.db is the only path.

---

## §6 — Success Criteria (Owner's Definition of Done)

- [ ] `cleo dash` shows pending=0 (or only items owner consciously deferred)
- [ ] Every epic shows `status=done` or `status=cancelled --reason`
- [ ] No "in flight" worker tasks lingering >24h
- [ ] `cleo nexus projects clean` works on fresh `npm install -g`
- [ ] `cleo memory dream` produces non-zero summaries on retrieval-active session
- [ ] Studio /brain/overview shows tier distribution including long-tier entries
- [ ] Studio /tasks shows all 27+ epics with progress bars
- [ ] Studio task detail shows acceptance criteria + notes + commits + manifests
- [ ] GC daemon active; `.temp` does not exceed 5GB ever
- [ ] Any LLM running `cleo briefing` understands the project in <2K tokens
- [ ] `npm install -g @cleocode/cleo-os` includes Ollama auto-install + Gemma4-e4b-it pull
- [ ] CI fully green, all release workflows idempotent

---

## §7 — What I'm Doing With My Last Context

- Documenting this masterplan (this file)
- Standing by for close-out + T753 worker completions
- NOT dispatching more agents (preserve owner's option to read this plan first)

Future orchestrator should:
1. Read this file
2. Verify Wave 1 close-out shipped v2026.4.63
3. Pick up Wave 3 (database integrity) and continue down §4 order
4. Spawn worker per task, 4-6 in parallel per wave
5. Close epics as they complete
6. Final state: `cleo dash` shows zero pending

End of plan. Ship the dream.

---

## §10 — v2026.4.65 Status (2026-04-16)

**Version**: v2026.4.65
**CI**: Green (all packages)
**Tests**: 7275+ pass, 0 new failures

### What shipped in v2026.4.65

- T636 Canon + Harness Sovereignty + Durability (release commit 76978217)
- T756 CI: add `$lib` alias to root vitest config for studio tests
- All packages published cleanly via tarball verify gate

### Epics completed since v2026.4.60

| Epic | Completed | Version |
|---|---|---|
| T726 Memory Architecture | 2026-04-16 | v2026.4.63 (Wave 1) |
| T627 BRAIN-LIVING Stabilization | 2026-04-16 | v2026.4.62-63 |
| T687 Scaffolding | 2026-04-15 | v2026.4.60 |
| T660 3D Brain | earlier | — |

### Known outstanding items

1. **T617** — NEXUS barrel export 29% accuracy miss (high priority, next NEXUS sweep)
2. **T636** — 5 children pending Canon Finalization wave
3. **T513** — Full GitNexus absorption deferred (low priority)
4. **T631** — Cleo Prime persona deferred (low priority)

### Recommended next wave

1. Canon Finalization T636 — dispatch Lead + 5 workers
2. T617 barrel export fix — single worker
3. Studio polish + docs when above complete

---

## §11 — Assessment After v2026.4.75 (2026-04-16, post orchestration marathon)

**Version**: v2026.4.75 shipped
**Branch**: main
**Status**: Assessment-only pause — orchestrator recovered context, evaluated landscape, flagged misclassifications, deferred dispatch pending owner review

### Releases shipped since §10 (v2026.4.65 → v2026.4.75)

| Version | Commit | Summary |
|---|---|---|
| v2026.4.66 | 294064331 | plan moonbeam gap-fill (5 missed deliverables) |
| v2026.4.67 | c391f7679 | CI biome format fix |
| v2026.4.68 | d89785e94 | T636 epic FULLY CLOSED (4 deliverables) |
| v2026.4.69 | 5ad2c9662 | **T759 brain-migrations fix** + CI canon-drift fix |
| v2026.4.70 | 279bc1160 | IVTR foundation + programmatic gates + cleo docs + BRAIN P0 fixes |
| v2026.4.71 | 2345bf024 | **T760 RCASD epic COMPLETE** (Wave 5 + Wave 6, 16 tasks) |
| v2026.4.72 | fc72d080a | hotfix missing emit-schemas.mjs |
| v2026.4.73 | cf26cecee | T788 parent-epic gate + sqlite-vec fix + gate-runner contract |
| v2026.4.74 | acf9474c9 | clean release + structural CI gates (biome + cleo-os) |
| v2026.4.75 | 3e7ab56e3 | hotfix injection template source-of-truth + portable test path |

11 releases total. 3 major epics closed: **T636** (Canon/Harness/Durability), **T760** (RCASD/IVTR foundation), **T759** (BRAIN schema hotfix).

### Current Pending Landscape (91 tasks)

Raw counts — but the number is **misleading without reclassification**.

| Breakdown | Count |
|---|---|
| **Total pending** | 91 (was 92; T603 test fixture CANCELLED in pass 3 start) |
| Critical | 11 |
| High | 27 |
| Medium | 46 |
| Low | 7 |
| Epics | 6 (T487, T569, T673, T820, T828, +1) |
| Tasks | 66 |
| Subtasks | 19 |
| Orphans (no parent) | 78 |

### Critical Misclassifications Found (Clean-House Pass 3 Backlog)

**Group 1 — T513 NEXUS pipeline children misclassified as critical/high** (6 subtasks):
- T514, T515, T516, T517, T518, T519, T520, T521, T522 — all marked critical/high
- Parent T513 was **DEFERRED LOW** per §2.5 (T757 clean-house)
- **Action**: Reclassify to low, OR cancel + fold into future NEXUS v2 epic, OR resurrect T513 if owner wants full GitNexus absorption

**Group 2 — T542 re-validation subtask orphaned** (1 subtask):
- T548 "T542-6: Full re-validation — independent agent proves PASS" marked critical
- Parent T542 was **CANCELLED** per §2.5 (superseded by T627/T726)
- **Action**: CANCEL T548 (parent gone)

**Group 3 — T555-T558 memory/CleoOS critical orphans** (4 tasks):
- T555 LLM Extraction Gate ("Replace extractFromTranscript with LLM-based extraction")
- T556 Reciprocal Rank Fusion
- T557 Observer/Reflector pattern (two-agent compression)
- T558 CleoOS firstclass experience (ASCII logo, last decisions, memory summary)
- Unclear if superseded by T726 Memory Architecture v2026.4.63 or still outstanding
- **Action**: Lead audit against T726/T627 shipped code — close any overlap, keep genuine gaps

**Group 4 — T487 Commander-Shim children orphaned** (3 subtasks):
- T488 "R: Shim removal research" (high)
- T490 "A: Shim removal ADR — native citty command architecture" (high)
- T491 "S: Shim removal spec — migration plan" (high)
- These should be children of T487 (not orphans) and drive RCASD pipeline
- **Action**: Re-parent T488/T490/T491 under T487, then spawn Lead on T488

**Group 5 — T759 shipped but cannot close** (1 task):
- Fix shipped in v2026.4.69 (commit 5ad2c9662); `cleo memory observe` verified working on v2026.4.75
- `cleo complete T759` blocked: E_LIFECYCLE_GATE_FAILED (implemented, testsPassed, qaPassed never marked)
- **Action**: Owner decision — either (a) mark gates via `cleo verify` workflow, (b) add "force-close shipped" CLI path for historical tasks, (c) accept this as a known gap in gate-verified completion

**Group 6 — OpenProse + CANT DSL clusters** (~15 tasks):
- T115-T122 OpenProse research/RFC (all high)
- T315-T323 CANT DSL Waves 0-8 (all medium)
- Deferred or actively planned? Plan doc §3 mentions CANT DSL "runtime bridge shipped; protocol files = design docs" — implies T315-T323 may be DONE or DEFERRED
- **Action**: Audit against shipped CANT work, close or defer

**Group 7 — Transfer epic remnants** (~7 tasks):
- T046-T055 nexus.transfer tasks, parent T046 COMPLETE per §2.5
- But T047-T055 still pending as orphans
- **Action**: Verify against shipped nexus.transfer implementation, close shipped ones

### Real Working Set (after reclassification)

**Wave A (Dogfood close)**:
- T617 NEXUS barrel export fix (1 worker, medium size, 1-3 files)
- T759 close path (owner decision)

**Wave B (Commander-Shim removal)**:
- T487 pipeline init → T488 research → T490 ADR → T491 spec → decomposition → worker waves
- Real work: 113 files, 20 tests

**Wave C (Release pipeline — NEW epic T820, created 2026-04-16)**:
- T820 project-agnostic cleo release (owner P0 per title, medium priority)
- Children T821-T824 ready
- Evidence: v2026.4.66-69 shipped via raw git tag + GitHub Actions (bypassed `cleo release`)

**Wave D (CLI coverage)**:
- T483 W3-final: 100% CLI coverage — build handlers for 19 agent-only ops (critical)

**Wave E (Test infrastructure)**:
- T566 Wire 76 unwired test files (high)

**Wave F (STDP Phase 5 remnant)**:
- T682 STDP-W5 functional test — end-to-end plasticity CLI verification (medium)
- Other T673 children may be shipped and unclosed — audit needed

### Anti-patterns re-confirmed this session

| Anti-pattern | Evidence | Mitigation |
|---|---|---|
| Shipped-but-unclosed | T759, likely T673 children | Run close-audit after every release |
| Gate-blocked close path | T759 cannot close despite proof it works | Owner decision: gate bypass CLI or accept drift |
| Orphan creep | 78 of 91 pending are parentless | Every new task MUST have a parent (epic or task) |
| Critical-priority sprawl | 11 critical, 6 are T513 deferred children | Reclassify on deferred-parent close |

### Recommended orchestrator next session

1. **Clean-house pass 3 first** (Wave A prep): Close T759, cancel T548/T603 (done), reclassify T513 children, audit T555-T558 vs T726, re-parent T488/T490/T491 under T487, audit T315-T323 CANT DSL, audit T047-T055 transfer remnants. Target: 91 → ≤50 pending.
2. **Wave A**: T617 barrel export fix (single worker, 1-3 files, tests). Closes T569.
3. **Wave B**: T487 RCASD pipeline — init, spawn Lead on T488 research.
4. **Wave C**: T820 release pipeline decomposition if owner confirms P0.
5. **Ship v2026.4.76** bundling Waves A + any B/C completions.

### Open questions for owner review

1. **T513 NEXUS v2 children** (T514-T522): reclassify to low, cancel, or resurrect?
2. **T555-T558 memory critical**: superseded by T726 Memory Architecture or genuine gaps?
3. **T759 close path**: add `cleo complete --shipped` bypass, mark gates manually, or leave drift?
4. **T820 release epic priority**: owner-tagged P0 in title but stored as medium — which is canonical?
5. **OpenProse (T115-T122)** and **CANT DSL (T315-T323)**: active, deferred, or cancel?
6. **Wave execution order**: clean-house first (my recommendation) or dispatch T617 + T487 Lead in parallel with pass 3?
7. **T828** (parent of T830 "never delete code" policy) not yet inspected — status unknown, 1 pending child.

Orchestrator is **paused here** pending owner decisions. No workers dispatched. No code touched. Session `ses_20260416184154_59cbf3` active on epic T569.

---

## §12 — Wave A Execution Close-out (2026-04-16 session)

**Directive from owner**: "Complete all of Wave A this conversation session then end and start new session for remaining waves."

### Pending count movement

| Checkpoint | Pending | Δ |
|---|---|---|
| Start of session (post v2026.4.75) | 92 | baseline |
| After Wave A assessment (§11 written) | 91 | −1 (T603 test fixture cancelled) |
| After Wave A clean-house pass 3 | **74** | **−17 from baseline, −18% reduction** |

### Wave A closures + cancellations (14 closed + 3 cancelled)

**Closed (shipped-but-unclosed, verified via file presence + test runs)**:

| Task | Evidence |
|---|---|
| T759 (P0) | `cleo memory observe` verified OK on v2026.4.75 (obs `O-mo1tro2w-0`); shipped commit `5ad2c9662` v2026.4.69 |
| T555 (critical) | `packages/core/src/memory/llm-extraction.ts` + `auto-extract.ts` + tests shipped (T726 Memory Architecture Wave 1) |
| T556 (critical) | `reciprocalRankFusion` function exported in `brain-search.ts`, wired into `searchBrainCompact` |
| T557 (critical) | `observer-reflector.ts` + tests, hooked into task/session hooks |
| T047-T055 (9 tasks) | `packages/core/src/nexus/transfer.ts` + `__tests__/transfer.test.ts` + domain + CLI + `external_task_links` migration; 264 test files / 4137 tests pass in @cleocode/core |
| T465 | Zero `clawmsgr`/`ClawMsgr` refs in non-test non-md code; zero `.cleo/clawmsgr-*.json` configs |
| T179 | Same — ClawMsgr Wave 3 delete verified clean |

**Cancelled (test fixtures or orphaned post-parent-close)**:

| Task | Reason |
|---|---|
| T603 ("Sub 2") | Empty description + `AC1/AC2/AC3` placeholder — same pattern as T601/T605/T606 |
| T548 | Parent T542 cancelled in T757 clean-house (superseded by T627/T726) |
| T334 ("T310 test sanity check") | Generic placeholder AC — "Task is created/Returns valid ID/Exit code 0" |

### Wave A reclassifications (18 tasks to low)

**T513 NEXUS v2 children** (9 tasks, parent is deferred-low): T514, T515, T516, T517, T518, T519, T520, T521, T522 — all critical/high → **low**. Justification: parent T513 is DEFERRED LOW per §2.5; these subtasks should not outrank the parent.

**OpenProse research cluster** (7 tasks, no active integration): T115, T117, T118, T119, T120, T121, T122 — all high → **low**. Justification: no OpenProse files anywhere in `packages/` or `docs/`; these are speculative research tasks with no work in flight.

### Wave A re-parentings (3 tasks)

T488 (research), T490 (ADR), T491 (spec) — orphan → parented to **T487** Commander-Shim Removal. These are RCASD artifacts for T487 that were never properly linked.

### Wave A dispatched work

**T617 NEXUS barrel export fix** — IN PROGRESS (background agent `a0b59ea2181febd77`).

Surprise finding during assessment: barrel infrastructure is **SHIPPED** in `packages/nexus/src/pipeline/import-processor.ts` (`buildBarrelExportMap`, `resolveBarrelBinding`, 782-line `__tests__/barrel-tracing.test.ts` with 119 passing tests). Fresh `cleo nexus analyze` confirms: `Barrel map: 95 barrel files with re-export chains` and `Calls: tier1=8025, tier2a=10233, tier3=7387, unresolved=89390` — Tier 2a barrel resolution IS firing on 10k+ calls.

**But accuracy is still below AC**: `findTasks` returns 3 callers (grep truth: 8); `endSession` returns 4 callers (grep truth: 11). Both below the `≥5 callers` acceptance threshold. The 89k unresolved calls indicate deeper gaps beyond barrel chains — call patterns (method on object, dynamic dispatch, test harness imports) not being caught by any tier.

Background agent is investigating call-processor.ts for the remaining resolution gap. Worker will return with a PR-ready diff or a blocker report.

---

## §13 — Full Epic Priority Table (7 epics; 1 active + 6 pending)

| ID | Status | Priority | Size | Title | Wave |
|---|---|---|---|---|---|
| **T569** | active | critical | large | CLEO Dogfood Attestation — Prove All 6 Systems Work | **A** — closes when T617 lands |
| **T487** | pending | medium | large | Commander-Shim Removal — Native Citty CLI Migration (113 files) | **B** — next session |
| **T820** | pending | medium (P0 in title) | medium | Project-agnostic `cleo release` pipeline — Release phase of LOOM/IVTR | **C** — next session, needs priority decision |
| **T631** | pending | low | large | Cleo Prime Orchestrator Persona — Bulldog AGI for any project/owner/harness | **Deferred** — separate initiative, not RCASD |
| **T513** | pending | low | large | Native Code Intelligence Pipeline — Full GitNexus Absorption | **Deferred** — foundations shipped, full absorption future |
| **T298** | pending | low | large | Sitar-inspired Config Platform — review + implement | **Deferred** — review-then-design |
| **T453** | pending | low | large | CleoAgent — Autonomous CleoOS Harness Testing (meta-agent + scenarios) | **Deferred** — T464/T466-T472 are children |

### T820 expanded (7 children)

Owner-created 2026-04-16 after v2026.4.66-69 shipped via raw `git tag` + GitHub Actions (bypassing `cleo release`). Evidence: `cleo release list` only shows v2026.4.25-26 rolled-back releases.

| ID | Child |
|---|---|
| T821 | RELEASE-01: Project-agnostic release config (`.cleo/release-config.json`) |
| T822 | RELEASE-02: Auto-CHANGELOG from commit-to-task association |
| T823 | RELEASE-03: IVTR gate enforcement on release ship |
| T824 | RELEASE-04: PR-first release mode |
| T825 | RELEASE-05: Real rollback (not just record flip) |
| T826 | RELEASE-06: Integration test on downstream project |
| T827 | RELEASE-07: Wire release ship into IVTR pipeline |

Priority decision needed: stored as `medium` but title says `EPIC P0`. Recommend owner confirm intended priority before Wave C dispatch.

### T631 Bulldog AGI Persona (separate initiative, not RCASD)

Owner explicitly noted: **not** a standard RCASD epic. Makes Cleo Prime persona portable across projects/owners/harnesses. SSoT chain: `CLEOOS-IDENTITY.md` (who) + `ct-orchestrator/SKILL.md` (how operational). Currently deferred low; execute when owner prioritizes.

### T830 Never-delete policy task (child of T828 DONE)

**Parent T828 is DONE** (platform binary reconciliation shipped), but child T830 policy task is still pending. T830 acceptance criteria encode structural rules:

- No `|| true` bandaids in build scripts
- All TS errors block `release.yml` (biome ci step enforces)
- `cleo-os` extensions build clean under full `pnpm run build`
- Pre-commit hook runs `biome ci` locally
- Non-shipping code → file under a plan epic, do NOT delete

T830 is the policy codification of rules already adopted this session.

---

## §14 — Structural Rules Enforced Going Forward (owner-locked 2026-04-16)

These rules are **non-negotiable** and already wired into the codebase. They codify the lessons from v2026.4.66-v2026.4.75 patch cascade.

| # | Rule | Enforcement location |
|---|---|---|
| 1 | `release.yml` runs `biome ci .` **BEFORE** build — no more publish-past-CI-fail | `.github/workflows/release.yml` |
| 2 | `.git/hooks/pre-commit` runs `biome ci .` — drift can't enter main | Git hook, installed locally |
| 3 | `build.mjs` uses full `pnpm run build` for `cleo-os` — extension TS errors block | `packages/cleo-os/build.mjs` |
| 4 | **No `\|\| true`** in any build script — failure must surface | Enforced via code review + CI |
| 5 | Templates live at `packages/core/templates/` — `cleo init` mirrors from there | Single source of truth for init templates |
| 6 | Tests use `fileURLToPath(import.meta.url)` for paths — **no absolute dev-machine paths** | Enforced via T779+T789 hotfixes (v2026.4.75) |
| 7 | **Policy T830: never delete code** — if not shipping → plan+build; if shipping → types correct | T830 task; policy enforced during review |

### Why these rules now

Two patch releases (v2026.4.67, v2026.4.69) and a hotfix (v2026.4.72) were all caused by CI-level failures that scoped checks missed. v2026.4.74 locked the structural gates. v2026.4.75 fixed the absolute-path test leak that broke portable test execution.

### Session end

Session `ses_20260416184154_59cbf3` will be ended with handoff note summarizing Wave A completion. Next session picks up:
1. T617 worker return (if still in flight)
2. Wave B: T487 Commander-Shim RCASD decomposition
3. Wave C: T820 priority decision + decomposition dispatch
4. Continued residual cleanup (~74 → ~50 pending target)

Orchestrator has NOT touched production code this session. All closures are status-only updates on shipped artifacts. All reclassifications preserve the work; nothing was deleted.
