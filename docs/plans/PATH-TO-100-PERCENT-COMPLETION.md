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

### Post-clean-house pending

88 pending tasks (down from 114). Remaining work centers on:
- T636 Canon Finalization (5 pending children)
- T569 Dogfood Attestation (1 pending: T617 barrel export bug)
- Remaining tasks in pipeline (T513, T631 deferred low)

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
