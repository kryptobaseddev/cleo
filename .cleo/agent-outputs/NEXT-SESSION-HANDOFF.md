# NEXT SESSION HANDOFF — 2026-04-21 cleo-substrate wrap-up

**Session ended**: ses_20260421172640_4272c8 (wrap-up of the v2026.4.102→.107 / T1106 living-brain-recovery arc)
**Baseline**: v2026.4.107 live (tag + global install both at .107 — dogfooding current)
**HEAD**: 280ab38d7 (v2026.4.106 release commit; v2026.4.107 tag lives on the PR-101 merge — confirm merge state on resume)
**Owner**: kryptobaseddev
**Previous handoff**: [HANDOFF-2026-04-20-master-sentient-v2.md](./HANDOFF-2026-04-20-master-sentient-v2.md)

---

## Core vision crystallized this session

Persisted as **D023** (SDK-first architecture) and **D024** (neurosurgery model):

> `packages/core/` IS the deliverable — the brain/soul substrate that makes ANY LLM an agent with memory, plasticity, reasoning. The `cleo` CLI is ONE surface over that SDK. An MCP server, TUI, or web app are equally-valid consumers. Every new capability ships as a core SDK primitive FIRST (typed Params/Result in `packages/contracts/`), then exposes via `cleo` dispatch. Test priority: SDK contract tests > CLI integration tests.
>
> Every commit teaches the next agent. Before shipping: *what does this commit teach the future orchestrator that inherits v{next-tag}?* The release tarball lands on a stranger 1000 miles away — their LLM inherits our choices.

These are the lens for ALL future orchestration decisions. The T1106 bug cascade (T1133/T1134/T1135/T1136) wasn't scattered bugs — it was decoherence between SDK intent and CLI dispatch. Fixing them was brain-vs-body re-integration.

## Decisions stored this session

| ID | Title | Notes |
|----|-------|-------|
| D019 | Subagents MUST NOT run git operations | Earlier — broad prohibition |
| D021 | Worktree-per-worker for T1106 work | Partial scope |
| D022 | **CLEO worktree-isolation protocol (SSoT)** | Supersedes D019+D021 IN PROSE only |
| D023 | SDK-first architecture: core is the deliverable | New — lens for all surface decisions |
| D024 | Neurosurgery model: every commit teaches the next agent | New — evaluation filter |

**⚠️ Prose-only supersession problem**: D019/D021/D022 all return from `cleo memory find "worktree" --type decision` as equally-weighted active rules. This is exactly what T1139 is filed to fix.

## Priority tasks filed this session

| ID | Parent | Title | Why it matters |
|----|--------|-------|----------------|
| T1139 | T1106 | BRAIN auto-reconcile: semantic conflict detection + auto-supersession | Makes the supersession chain STRUCTURAL not prose. Living-brain step 2 (Hebbian was step 1). |
| T1140 | T1106 | Meta-A: `cleo orchestrate spawn` emits worktree-by-default | Makes D022 substrate-enforced not memory-enforced. Root cause of the T1137 CI race. |
| T1141 | T1106 | Meta-B: Drizzle migration generator strips trailing statement-breakpoint | T1118 pattern (brain damage on fresh init) prevented at generator level. |

## LATE-SESSION ADDITION — Honcho Comprehensive Plan + 4-Pillar Master

**Owner flagged mid-session**: the previous agent lost scope on Honcho integration (~70% missed). Session ses_20260421173407_ac5c20 re-audited the entire plan and produced authoritative artifact:

- **`.cleo/agent-outputs/T1075-honcho-integration-plan/PLAN.md`** — 800+ lines, comprehensive integration roadmap. Includes: full Honcho source inventory at `/mnt/projects/honcho/src/`, full CLEO target file inventory across memory/sessions/store/nexus/dispatch/cant/agents, T1075 existing tree audit (all 17 tasks structurally parented correctly — `cleo tree T1075` has a BUG returning empty), four missing Waves identified and filed, 4-pillar integration section, ship-order recommendation across v2026.4.108 → v2026.5.x.

### New epics filed under T1075 (Honcho Memory Integration)

| ID | Wave | Size | Purpose |
|----|------|------|---------|
| T1144 | Wave 0 | medium | Prerequisites: Honcho source audit + packages/agents/ cleanup + glossary |
| T1145 | Wave 5 | large | Deriver queue pipeline (durable background derivation worker) |
| T1146 | Wave 6 | large | Dreamer upgrade: Bayesian surprisal + specialists + hierarchical trees |
| T1147 | Wave 7 | large | Reconciler extension (merges T1139 + vector sync + DLQ) |
| T1148 | Wave 8 | large | Peer-card identity layer + CANT representation |
| T1149 | Wave 9 | large | **Conduit A2A** — owner-flagged: agents don't use agent-to-agent today |

### MASTER anchor epic filed under T942 (Sentient Architecture)

| ID | Purpose |
|----|---------|
| T1151 | MASTER: Sentient Self-Healing Orchestrator — 4-pillar integration anchor. Maps owner's architectural vision to: Pillar 1 event-driven nervous system, Pillar 2 hierarchical pluggable memory, Pillar 3 sub-agent context isolation, Pillar 4 aggressive extensibility. Ship-order guidance inside. |

### Hard-evidence substrate blocker

Attempted `cleo orchestrate spawn T1144 --tier 1` → failed with `E_AGENT_NOT_FOUND: agent 'cleo-db-lead' not found`. Recorded as observation O-mo8wwrs5-0. This is PROOF the packages/agents/ registry is broken today — Wave 0.2 is not speculative cleanup, it's a spawn-system-broken fix. Cannot dispatch Leads until this is resolved.

### Critical Substrate Triad (ship before anything else in T1075 tree)

1. **T1140** — worktree-by-default spawn (prevents race-on-main)
   - **T1161** (child) — **Integrate worktrunk as CLEO worktree backend** per D025
   - Owner's fork: https://github.com/kryptobaseddev/worktrunk
   - Layout change: `.cleo/.trees/` nested (supersedes D022 sibling layout → D025)
   - Backend hierarchy: bundled worktrunk > system `wt` binary > raw `git worktree add` fallback
   - Baseline validator gates handoff: agent only receives worktree path if `pnpm run build + test` green
   - Lifecycle hooks CANT-declarative (npm install + db seed + baseline check)
   - psmux durable sessions deferred to separate follow-on task under T1151 Pillar 1
   - **D026 owner directive**: worktrunk ships BAKED INTO CORE opinionated (not optional plugin)
   - **Pattern O-mo8xjt8a-0**: NEVER hardcode paths — always `packages/core/src/paths.ts` + `packages/core/src/system/platform-paths.ts` + `env-paths` library
   - wt.toml + .worktreeinclude both auto-GENERATED (not hand-written) via `packages/worktree-backend/config-generator.ts`
   - `worktree-path = "{{ repo_path }}/.cleo/.trees/{{ branch }}"` applied globally; per-project scoping via `[projects."..."]` available but opt-in
   - Multi-project root: `~/.cleo/projects/` default via platform-paths.ts; override via `CLEO_PROJECTS_ROOT` env or `config.toml projects.root`
   - Full spec at **PLAN.md Part 11** (11.1–11.10 with SDK surface + template + hook wiring)
2. **T1144.0.2** — packages/agents/ cleanup (FIXES E_AGENT_NOT_FOUND — spawn literally broken today)
3. **T1149** — Conduit A2A (Leads coordinate peer-to-peer instead of serial manifest return)

Without this triad, the Honcho waves execute serially (no parallelism) and spawn fails anyway. With this triad, Waves 1+2 parallel and all subsequent waves are mesh-coordinated.

---

## NEXT SESSION PRIORITY ORDER

### PART A — Must-do before any worker spawn

1. **Reconcile dirty working tree** (owner-only). `git status` shows staged DOWNGRADE of 3 package.json files from 4.106 → 4.102. Likely leftover from a rollback; verify intent before resolving. Do NOT let a worker touch this.
2. **Substrate triad ship** — T1140 (worktree-default) + T1144.0.2 (agent registry fix) + T1149 (Conduit A2A). Without these, no further multi-agent work is safe. See T1151 master anchor for full dependencies.
3. **Fix `cleo tree`**: returns empty children even when parentage is correct (verified via per-task `cleo show`). Filed cause unknown — likely in packages/cleo/src/dispatch/domains/tasks.ts tree query.

### PART B — Intelligence layer (post-substrate)

4. **T1107 (blocked, P0)**: Wire all 14 Living Brain verbs through dispatch registry. Owner-flagged — SDK-first (D023) proof point.
5. **T1139 BRAIN auto-reconcile** — folds into T1147 Wave 7 (Honcho reconciler extension) per PLAN.md Part 4.
6. **T1141 Meta-B migration sanitizer** — close the brain-damage pattern at generator level.
7. **T1151 MASTER ship-order** — follow Release R1→R6 in PLAN.md Part 10 (v2026.4.108 substrate → v2026.5.0 "CLEO Sentient v1").

## Dirty working tree state (owner please resolve)

```
M package.json                    (version 4.106 → 4.102 downgrade, staged)
M packages/cleo/package.json      (version 4.106 → 4.102 downgrade, staged)
M packages/core/package.json      (version 4.106 → 4.102 downgrade, staged)
M packages/*/package.json         (10+ other packages similarly)
M packages/cleo/src/dispatch/registry.ts
M packages/cleo/src/dispatch/domains/nexus.ts
M packages/cleo/src/dispatch/domains/__tests__/nexus.test.ts
M packages/cleo/src/dispatch/domains/__tests__/cli-missing-commands.test.ts
M packages/cleo/src/dispatch/__tests__/parity.test.ts
M packages/core/migrations/drizzle-tasks/20260421000001_t1118-owner-auth-token/migration.sql
M packages/core/src/nexus/__tests__/plasticity-queries.test.ts
M CHANGELOG.md
```

Most of these look like legitimate mid-flight work on T1137/T1138 that wasn't bundled into the v2026.4.107 tag. The package.json downgrade is suspicious — likely an aborted rollback. **Inspect before committing.**

## Global install confirmation

```
$ cleo --version
2026.4.107
```

Dogfooding is current. Global install tracks latest published tarball.

## Meta-learning to carry forward

- T1139 + T1140 + T1141 are **substrate-hardening tasks**, not product features. Each one removes a class of failure mode (supersession drift, race-on-main, migration brain damage) for every future orchestrator that inherits v{post}.
- The user's "build yourself" framing is literal: treat the codebase as neurosurgery on the next agent. Every spawn prompt, every BRAIN decision, every migration pattern IS the persona that future-self inherits.
- **Do not spawn code workers until T1140 ships.** Every worker spawn on this repo teaches the race-on-main pattern. T1140 is the substrate fix that makes worktree-by-default the path of least friction.
