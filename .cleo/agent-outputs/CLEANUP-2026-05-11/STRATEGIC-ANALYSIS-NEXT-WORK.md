# CLEO Strategic Analysis: What to Work On Next

**Date:** 2026-05-11 · **State:** 64 active epics · 383 active tasks · ZERO graph issues

---

## Headline finding

**CLEO is leaking faster than it's improving.** The biggest signal: across this very session, every CLI invocation produced two ERROR-level log spam events (T9212), the sentient daemon hasn't fired a real dream in 17 days despite being "verified-shipped" (T1898/T1901), and four bugs (T9092/T9175/T9178/T9193) are actively orphaning worktree work.

The campaign you just closed (T9187 AUDIT-RECOVERY → v2026.5.61) directly addresses the *root cause* of that leak — workers claiming completion without doing the work. **You shipped the fix for the failure mode, but the enforcement scaffolding around it (T9220 Verifier Substrate v2, T9221 Forced-Iterations Enforcement) is still pending.** Until those land, the next worker can still bypass the gate by routing around it.

Meanwhile, three architectural foundation epics (T1685 CSL-RESET, T1467 thin-wrapper, T1768 Core SDK Tools) sit unstarted — they're the work that would make the SDK genuinely consumable instead of "560 raw stdout writes bypassing LAFS in 27 CLI commands."

## The four currents

Sorting all 64 epics by what they're *actually* about:

| Current | Count | Heaviest items |
|---|---|---|
| **Production reliability** (bugs degrading daily use) | ~13 | T9092, T9175, T9178, T9193, T9194, T9212, T9174, T1898, T1901, T9173, T9183, T9157, T1693 |
| **Verifier/protocol lockdown** (finishing the T9187 work) | 4 | T9219, T9220, T9221, T9186 (now-redundant) |
| **Architectural foundation** (SDK/CLI/boundaries) | ~10 | T1685, T1467, T1768, T1232, T1855, T1407, T1135, T1136, T1137, T9118 |
| **Feature build-out** (Nexus + Sentient + Studio) | ~30 | T1042+children (Nexus), T1737 (CleoOS Sentient v3), T942, T1007, T1892, T990, T1840, T1844 |

The remaining ~7 are cleanup or process work (T1212, T1428, T1434, T1461, T1466, etc.).

---

## My recommendation — phased, with reasoning

### 🔴 Phase 1 — STABILIZE (this session + next, ~1-2 sessions)
**Goal:** Make CLEO actually pleasant to use again. Stop daily friction. Restore trust in "shipped" claims.

Order by pain-per-dollar:

1. **T9212** — dialectic API errors fire on every command. 30-min fix (catch the error silently or downgrade to WARN). Highest annoyance-to-effort ratio in the codebase.
2. **T9174** — brain memory sweep stuck. M6 refusal gate blocks `cleo briefing` retrievals daily. T1147 W7 sweep needs to run successfully.
3. **T1898 + T1901** — sentient daemon claimed shipped but 0 dreams in production. Either fix the operational state or unship the claim. T1901 is the diagnosis task; T1898 is the meta-bug.
4. **T9092 + T9175 + T9193** — worktree integrity cluster. Workers losing committed work to `cleo complete` is a top-3 trust-destroyer.
5. **T9178** — phantom completions. Worker says "Implementation complete" with zero file changes. Directly upstream of the T9187 work — your fix needs this gate.
6. **T9173** — `cleo init` pollutes global registry with project-tier rows pinned to disappearing dirs.
7. **T9157** — P0 sqlite-pragmas.json ESM smoke test fix (already reparented under T9118).
8. **T1693** — Studio production build broken (vite/wasm). Blocks T990.

**Outcome after Phase 1:** Every CLI invocation is clean. Sentient daemon actually thinks. Worktree work survives `cleo complete`. CI smoke passes everywhere.

### 🟡 Phase 2 — LOCK THE GATE (1-2 sessions, can run in parallel with end of Phase 1)
**Goal:** Finish what T9187 started so workers physically *cannot* mark scaffold as done.

1. **T9219** — boundary refactor: move verifier runner + backfill from `packages/cleo/` → `packages/core/`. Single task, owner-flagged mid-campaign.
2. **T9221 children (3 tasks)** — Forced-Iterations Systemic Enforcement:
   - T9230 (FISE-1) — session-end hard gate: refuse close on Lead with `delegate_task_count=0 + tasks_completed>0`
   - T9231 (FISE-2) — CANT `validateSpawnRequest`: reject implemented gate without upstream sub-agent commit
   - T9229 (FISE-3) — ADR Bypass-Prevention Substrate
3. **T9220 children (7 tasks)** — Verifier Substrate v2:
   - T9222 relocate scripts/verify-*.mjs → `.cleo/verifiers/<TID>.mjs`
   - T9223 add `tasks.verifier_path` column + registry
   - T9224 acHash drift detection
   - T9225 GC lifecycle hooks
   - T9226 worktree spawn-clone-exclude filter (huge token saving on spawn)
   - T9227 migrate 22 existing verifier scripts to canonical location
   - T9228 ephemeral exemption (lifetime=session skips verifier)
4. **Then mark T9186 done** — it's the same protocol-harden work T9192 just delivered. Dedupe.

**Outcome after Phase 2:** No worker can bypass gates. 22→200+ verifiers scale cleanly. Token cost of spawn drops because the `node_modules` etc. doesn't clone into the worktree.

### 🟢 Phase 3 — FOUNDATION (the "Core SDK improvement" the owner asked about)
**Goal:** Make the Core SDK coherent, consumable, and harness-agnostic. This is where the "CLEO Core SDK system" investment lives.

1. **T1685 — CSL-RESET (Contracts/SDK/LAFS Reset)** — critical, multi-session epic. Three foundational defects:
   - Two parallel SDK shapes (public throw-style vs internal EngineResult)
   - 560 raw `stdout.write` calls bypassing LAFS in 27 CLI commands
   - 128 type names duplicated across packages
   - This is the single most leveraged architectural epic. Every future CLI command and every external SDK consumer benefits.
2. **T1768 — Core SDK 'Tools' surface** — define what tools the SDK exposes; resolves the Pi/Claude Code Agent SDK divergence on worktree isolation enforcement. Pairs naturally with CSL-RESET.
3. **T1467 — Thin-wrapper CLI migration** — finish what T1435 + T948 started. Makes `cleo` CLI a pure thin dispatch over the SDK.
4. **T9163 — Brain/Nexus schema migration correctness** — 7 brain migrations missing statement-breakpoints + `nexus_nodes.is_external` never in forward migration. Eliminates 32506 warnings per CI run, 15 on fresh init. Adjacent to foundation, owner-directed.

**Outcome after Phase 3:** External SDK consumers can build on `@cleocode/core` without going through CLI. Harness providers (Pi, Claude Code, OpenAI, etc.) consume one canonical EngineResult. The 27-command stdout bypass is closed. Migrations are clean.

### 🔵 Phase 4 — HIGH-LEVERAGE FEATURES (after foundation)
**Goal:** Unlock the highest-leverage individual tasks.

1. **T1844 — Nexus edge completeness** — top bottleneck by leverage (blocks 28 tasks). DEFINES + ACCESSES + METHOD_OVERRIDES + METHOD_IMPLEMENTS edge emission. Currently 0 emission for declared schema types.
2. **T9144 — Nexus Restructure master** — the cleo-graph + narrowed-nexus split with 6 child waves (W1-W6, T9145-T9150). Big but well-decomposed.
3. **T1135 — Observability event bus** — orchestrator can finally see what spawned workers are doing.
4. **T1136 — Commit-to-task-ID provenance** — every commit traces to a Task. GitHub-issue-style attribution.
5. **T1137 — Agent lifecycle / runaway prevention** — worker scope boundary enforcement.

**Outcome after Phase 4:** Nexus is a real cross-language code intelligence layer. Orchestrator sees its workers. Provenance is forced.

### 🟣 Phase 5 — STUDIO + LONG-RUNNING (owner pain + replatform)

1. **T990 — Studio UI/UX Design System** — owner-flagged after T949 merge: "looks like SHIT". Critical to owner but should follow T1693 (vite build) which is now reparented under T990.
2. **T1737 — CleoOS Sentient Harness v3** — 52-child epic. Full native stack replacement. Should be sequenced as a multi-month workstream, not a single push. Many of its children depend on Phase 3 foundation.
3. **T942 — Sentient Architecture Redesign** + **T1007 — Tier 2/3 Sandbox auto-merge** + **T1892 — BBTT** — the three-headed Sentient/BRAIN coherence epic. Each is large; tackle after Sentient daemon is actually running (Phase 1) and foundation is solid (Phase 3).

---

## What I'd cut or defer

- **T9186** — same title and scope as T9192 (just done). Mark done with reference, don't re-execute.
- **T1212** (33 RULE-3 lint WARNs), **T1428** (cast reduction), **T1434** (104 TS errors) — these are housekeeping that should be folded *into* Phase 3 foundation work, not separate epics.
- **T1461, T1466, T9194** — disk hygiene cluster. Fold into a single 1-day pass under T1466.
- **T631 (Cleo Prime Orchestrator Persona)** — low priority, defer.
- **T1555 (Audit-2026-04-28 follow-up)** — 8 month old audit. Reassess relevance, likely retire.

## Concrete first step (next 60 minutes)

If you want a single tactical move that delivers immediate value: **fix T9212 first**. It's a single try/catch around a `generateObject` call in the dialectic subsystem. The fix takes ~30 min. Result: every subsequent `cleo` command is clean output, which makes the rest of the Phase 1 work easier to debug because you're not staring through log spam.

If you want a single strategic move that shapes the whole next month: **scope and start T1685 (CSL-RESET)** in parallel with Phase 1 cleanup. CSL-RESET requires reading audit reports already in BRAIN — could be largely planning + decomposition this session, then execution agents next session.

## Honest risk callouts

- **Phase 3 is large.** CSL-RESET alone is a multi-session epic touching most of `packages/cleo/`. Plan for it; don't underestimate.
- **Phase 1 will surface new bugs.** When the dialectic error stops, you'll see other errors that were hidden underneath.
- **T1737 (CleoOS Sentient v3) is a months-long workstream.** Don't try to "finish" it in a sprint. Pick 3-5 of its 52 children that are independently shippable and slot them into Phase 4.
- **T1042 Nexus children include 7 BUG tasks bundled with the master restructure work.** Those bugs (T1835, T1873, T1891, T1924, T1927) should be split out and triaged separately — they're production issues, not Nexus-restructure features.
