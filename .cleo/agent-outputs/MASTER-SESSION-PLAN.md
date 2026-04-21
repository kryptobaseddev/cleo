# MASTER Session Plan — Sentient CLEO v2 Remaining Work

**Date**: 2026-04-19 | **Baseline**: v2026.4.97 (T942+T949+T962 shipped) | **Owner**: kryptobaseddev

This document inventories the 3 root epics that cover ALL remaining work identified in the 2026-04-19 SITREP. It is the authoritative source for the next MASTER orchestration session.

---

## Context: What SHIPPED in v2026.4.97

- **T942 Wave A+B** (2026-04-18): `computeTaskRollup` pure function, T944 additive ontology (role+scope+severity+experiments side-table), T945 brain graph schema additions (5 edge types + 3 node prefixes + auto-populate hooks), T948 `@cleocode/core` promoted as SDK with STABILITY.md + .dts-snapshots + 9 stable subpaths, T947 llmtxt v2026.4.9 installed + 4 subpath adapters (`/blob`, `/sdk`, `/identity`, + infra), T946 Tier-1 sentient daemon with `cleo sentient` CLI
- **T949 Studio Task Explorer** (2026-04-19): 3-tab /tasks UI (Hierarchy + Graph + Kanban), 301 redirects, E2E playwright tests
- **T962 SSoT Reconciliation** (2026-04-19): brain→memory rename, typed dispatch adapter (T974), contracts resync (T963), CONDUIT promoted to dispatch domain #15 (T964), @cleocode/brain extracted from studio (T969)
- **ADR-051** (evidence atoms) + **T910 Playbook runtime** (HMAC-signed resume tokens) confirmed fully real and tested

## Context: What's STILL MISSING (the gap this plan closes)

Verified by 2 independent audits (SITREP + read-only grep verifier agents):

- **BRAIN noise pump persists** — observeBrain still inline SHA-256, bypasses verifyAndStore; 2440 noise patterns unchanged
- **14 specific items** in SITREP punchlist — zero had CLEO task coverage before this plan
- **Tier 2+3 autonomy** — 11 Round 2 contrarian attacks (sandbox RO theatrical, receipts locally-rewriteable, mode-0600 insufficient, baseline gameable, etc.) unaddressed
- **Memory architecture v2** — owner's 14 directives never decomposed into tracked work
- **Markdown bridges still alive** — `.cleo/memory-bridge.md` + `.cleo/nexus-bridge.md` written every session

---

## Three Root Epics

### Epic A — `T991` BRAIN Integrity — Write-Path Guardrails + Noise-Pump Fix (8 children)

**CRITICAL priority. Start here. Every other improvement compounds on clean write-path data.**

Ships the P0+P1 items from the SITREP punchlist. Wave 1 order recommended:

| Task | Pri | Effort | Title |
|---|---|---|---|
| **T992** | P0 | S | Route observeBrain + storeLearning + storePattern + storeDecision through verifyAndStore |
| **T993** | P0 | S | Title-prefix blocklist Check A0 in verifyCandidate |
| **T994** | P0 | M | correlateOutcomes Step 9a.5 + trackMemoryUsage wiring |
| **T995** | P0 | M | Step 9f hard-sweeper — autonomous DELETE for prune candidates |
| **T996** | P1 | M | Migrate dream cycle into sentient daemon tick loop |
| **T997** | P1 | S | `cleo memory promote-explain` CLI command |
| **T998** | P1 | L | NEXUS plasticity migration (weight + last_accessed_at + strengthenNexusCoAccess) |
| **T999** | P1 | M | Markdown bridge kill — CLI directive replaces @.cleo/*-bridge.md |

**Wave recommendation**: Parallel-safe set = {T992, T993, T997, T999}; Sequential after T992 = {T994, T995}; T996 depends on T995; T998 independent.

**Target impact**: 80% noise pattern reduction (2440 → <500) after one consolidation cycle.

### Epic B — `T1000` BRAIN Advanced (6 children)

**HIGH priority. Runs AFTER Epic A Wave 1 P0 items ship — compounding value.**

Ships the P2 items + 7 missing CLI commands.

| Task | Pri | Effort | Title |
|---|---|---|---|
| **T1001** | HIGH | L | Typed Promotion — promoteObservationsToTyped + brain_promotion_log + composite scoring |
| **T1002** | HIGH | L | Transcript Ingestion — brain_transcript_events + transcript-ingestor + redaction + auto-research |
| **T1003** | HIGH | M | Staged Backfill — brain_backfill_runs + approve/rollback CLI |
| **T1004** | HIGH | S | Pre-compact Flush — precompact-flush.ts + precompact-safestop.sh integration |
| **T1005** | MED | S | BRAIN_OBSERVATION_TYPES: add 'diary' type |
| **T1006** | HIGH | L | Missing CLI commands — memory digest/recent/diary/watch + nexus top-entries + task verify --explain |

**Wave recommendation**: Parallel-safe = {T1001, T1002, T1003, T1004, T1005}; T1006 depends on T1005 (diary needs the enum type).

### Epic C — `T1007` Sentient Loop Completion — Tier 2 + Tier 3 (5 children)

**HIGH priority. HARD BLOCKS on Epic A items T992+T993+T995 (clean write-path) + Wave B llmtxt/identity+/events (already shipped).**

Ships T946 Tier 2 (propose) and Tier 3 (sandbox auto-merge) with ALL 11 Round 2 contrarian mitigations.

| Task | Pri | Effort | Title |
|---|---|---|---|
| **T1008** | HIGH | L | Tier 2 — `cleo propose` CLI + BRAIN/nexus/test ingester + DB rate limiter |
| **T1009** | HIGH | L | Tier 3 infra — agent-in-container sandbox harness + --network=none |
| **T1010** | HIGH | L | Tier 3 — Externally-anchored baseline + signed llmtxt/events audit |
| **T1011** | HIGH | M | Tier 3 — FF-only merge + per-step kill-switch re-check |
| **T1012** | HIGH | M | Tier 3 — `cleo revert --from <receiptId>` kill-switch + audit chain walker |

**Wave recommendation**: {T1008} parallel with all Epic A work (Tier 2 has no Tier 3 deps). {T1009, T1010, T1011, T1012} sequential waves after llmtxt/identity production-ready.

---

## Master Orchestration Pattern

**Recommended Lead Agent assignments for MASTER session:**

| Lead | Domain | Owns |
|---|---|---|
| **Lead A** (brain-integrity) | `packages/core/src/memory/` | T991 all children — guards own brain-retrieval.ts, extraction-gate.ts, brain-lifecycle.ts, brain-maintenance.ts |
| **Lead B** (brain-advanced) | `packages/core/src/store/memory-schema.ts` + memory infra | T1000 all children — migrations, transcript pipeline, CLI surface |
| **Lead C** (sentient-autonomy) | `packages/cleo/src/sentient/` + sandbox harnesses | T1007 all children — blocks on Lead A for clean write-path data |
| **Lead D** (quality gate) | Cross-cutting | Audits all 3 Leads' outputs, runs ADR-051 evidence gates before merge |

Each Lead dispatches 3-5 Workers per wave. Total: 4 Leads + ~15 Workers = 19 agents orchestrated.

---

## Ship Gates (MANDATORY)

Every child task MUST produce:

1. **ADR-051 evidence atoms** at `cleo verify --gate <name> --evidence "commit:<sha>;files:<list>;tool:pnpm-test"` before `cleo complete`
2. **Tests**: each child task has ≥5 tests minimum; biome clean; build green
3. **Documentation**: TSDoc on all exports; inline comments ONLY for non-obvious invariants per CLAUDE.md
4. **Memory observation**: `cleo memory observe "<key finding>" --title "..." --task T###` after complete

Parent-epic ships when ALL children `status=done` AND parent acceptance criteria verified.

---

## Session Handoff

Start the next MASTER session with:

```bash
cleo session status    # resume check
cleo dash              # project overview
cleo show T991         # read the critical epic first
cleo orchestrate ready --epic T991   # Wave 1 parallel-safe set
```

Then dispatch Lead agents per the pattern above.

---

## Cross-References

- SITREP (this session, prior turn): 14-item punchlist, ~95% verified accurate
- `.cleo/agent-outputs/T942-rcasd-round1/ROUND2-SYNTHESIS.md` — origin of Tier 2+3 contrarian findings
- `.cleo/agent-outputs/T942-rcasd-round1/FINAL-DECISIONS.md` — Option F decisions that shipped in Wave A+B
- `~/.claude/projects/-mnt-projects-cleocode/memory/brain-integrity-epic.md` — aspirational epic note (now superseded by T991)
- `~/.claude/projects/-mnt-projects-cleocode/memory/memory-architecture-v2-initiative.md` — 14 owner directives (now decomposed across T991+T1000)
- ADR-051 (evidence atoms): `.cleo/adrs/ADR-051-programmatic-gate-integrity.md`
- ADR-054 draft (signed audit): `.cleo/agent-outputs/T947-llmtxt-v2026.4.9/ADR-054-DRAFT-signed-audit.md`

**Status**: READY TO EXECUTE. All 3 epics have `orchestrate start` completed. Wave 1 tasks ready.
