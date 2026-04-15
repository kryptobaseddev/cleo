# T553 — CLEO Dogfooding Audit

**Date**: 2026-04-13
**Agent**: Dogfood Auditor (Claude Code / Sonnet 4.6)
**Mission**: Determine whether CLEO is actually used by its own agents, or whether agents hallucinate and bypass the system.

---

## Executive Summary

**Dogfooding Score: 4.5 / 10**

The honest verdict is mixed. CLEO's task/session infrastructure is genuinely used. The memory, nexus, and intelligence layers are claimed frequently but rarely proven. The Conduit has 4 messages total — ever. The Pi harness has no hook files installed. The `cleo intelligence` domain is broken (unknown operation errors). The GitNexus index is stale and nearly 2x larger than the Cleo Nexus index, suggesting agents are instructed to use GitNexus but cannot because those instructions are baked into CLAUDE.md without runtime enforcement. Of 157 agent output files, only 8 contain actual JSON proof of cleo command execution.

---

## 1. Are Agents Using CLEO Commands? (Evidence-Based)

### Raw Numbers

| Category | Count |
|----------|-------|
| Total agent output files | 157 |
| Files with proven cleo execution (JSON `success:true`) | 8 (5%) |
| Files that mention cleo commands (code blocks, prose) | 89 (57%) |
| Files with no cleo mentions at all | 60 (38%) |

### What "Proven Execution" Means

Only 8 files contain actual `"success":true` JSON output that could only come from running `cleo` and pasting the result. The other 89 files that mention cleo commands are documenting what commands to run, describing what commands they claim to have run, or listing commands in tables — but provide no verifiable output.

### Most Mentioned Commands (475 total line matches across 49 files)

```
324  cleo memory
107  cleo nexus
 83  cleo admin
 72  cleo session
 49  cleo brain
 32  cleo context
 24  cleo intelligence
```

These are the commands agents claim to use most. Memory and nexus are the top two. But of those 157 files, only 8 prove it.

### Concrete Counterexample

The `T553-fresh-agent-v2-report.md` file is the best-executed dogfood test in the corpus. It shows 5 proven cleo JSON blocks, documents actual CLI output, and runs a scored test against real system state. This is the standard the other 88 "documented commands" files fail to meet.

---

## 2. Is the Conduit Being Used?

### Finding: Effectively No

The conduit.db exists and has the full schema (messages, conversations, attachments, dead_letters, delivery_jobs, etc). But:

- **Total messages ever**: 4
- **Conversations**: 0 named conversations
- **What those 4 messages are**: 3 are from a "PRIME local test" sent in a single test session (`cleoos-opus-orchestrator` → `cleo-dev`), 1 is from another test (`cleo-prime` → `cleo-prime-dev`). All 4 have `status: pending` — meaning they were never delivered or read.

### Conduit Code References in cleo-os

Zero matches for `conduit`, `send_to_lead`, `broadcast_to_team`, or `report_to_orchestrator` in `packages/cleo-os/src/`. The Conduit is built and schema'd, but no agent code in the OS layer calls it.

### Verdict

The Conduit is infrastructure with no active users. Agents do not send messages to each other via Conduit. The "inter-agent messaging" capability exists on paper only. The only agent communication happening is the orchestrator writing to output files and the next agent reading them — which is not Conduit usage, it is filesystem handoff.

---

## 3. Is the Orchestration Pipeline Actually Used?

### What Works

- `cleo orchestrate status` returns real data: 16 epics, 128 tasks, 77 pending
- `cleo orchestrate spawn T553` correctly rejects completed tasks (E_SPAWN_VALIDATION_FAILED)
- The orchestration domain is wired and responsive

### What Is Not Working

- **Registered agents: 0**. The session end note from the last session claims "60+ agents deployed across sessions." But `cleo agent list` returns 0 registered agents. Those "deployed" agents were Claude Code subagents launched via the Task tool — not registered in the CLEO agent registry. So CLEO's agent registry is empty while work is being done by untracked agents outside the system.
- **Pi adapter hooks: not installed**. `.pi/` does not exist in the project. `.pi/extensions/` does not exist. Pi's `hookConfigPathProject` points to `.pi/extensions` but that directory is absent. The Pi adapter was shipped (packages/adapters/src/providers/pi/) but the runtime hook installation was not completed for this project.
- **Agent spawn = worktrees, not cleo orchestrate**. There are 4 git worktrees under `.claude/worktrees/agent-*`. These represent Claude Code's native subagent spawn mechanism. CLEO's `cleo orchestrate spawn` was not used to create them.

### Verdict

Orchestration is a read-only dashboard. Actual multi-agent work uses Claude Code's native Task tool and git worktrees. CLEO's orchestrate layer is not in the execution path.

---

## 4. GitNexus vs Cleo Nexus Comparison

| Metric | GitNexus | Cleo Nexus | Ratio |
|--------|----------|------------|-------|
| Nodes | 20,989 | 11,248 | GitNexus 87% larger |
| Edges | 42,223 | 20,276 | GitNexus 108% larger |
| Communities | 962 | 235 | GitNexus 309% more |
| Processes | 300 | 75 | GitNexus 300% more |
| Index date | 2026-04-10 | 2026-04-13 | Cleo Nexus newer |
| Stale vs HEAD | YES (fcfa69c7 vs d4ffc9cd) | NO | GitNexus stale |

### Analysis

GitNexus and Cleo Nexus index the same codebase but produce radically different results. GitNexus finds 87% more nodes, 108% more edges, 309% more communities, and 300% more execution flows.

The reasons are methodological:
- GitNexus indexes all 1,768 files; Cleo Nexus indexes 2,482 files (but only 11k nodes vs 21k)
- GitNexus uses richer static analysis that catches more call relationships
- Cleo Nexus is newer (3 days fresher) but lighter in analysis depth
- GitNexus `processes` (300) are execution flow traces — Cleo Nexus has 75

For an agent asked to understand "what calls this function" or "what breaks if I change this," GitNexus would give richer answers. But GitNexus is stale (3 commits behind HEAD) and the CLAUDE.md instructs agents to use GitNexus tools while those tools are not available to subagents in the current environment (they require MCP which was removed). Cleo Nexus is available via `cleo nexus context` and actually works.

**Practical state**: `cleo nexus context addTask` returns real callers. `gitnexus_context` is unavailable to CLI subagents because MCP was removed. So CLAUDE.md instructs using GitNexus tools that agents cannot call.

---

## 5. Conduit Usage Status

**Status: Dead infrastructure.**

- 4 messages total, all from integration tests, all undelivered
- 0 conversations
- 0 code in cleo-os that sends conduit messages
- 0 agent output files that show conduit read/write operations
- The conduit.db schema is correct and complete, but it is an empty database

The ADR mentions conduit as a messaging layer. In practice, agent coordination happens through:
1. Git worktrees (isolation)
2. Shared `.cleo/tasks.db` (task claiming, status)
3. `.cleo/agent-outputs/*.md` files (handoff)
4. `cleo briefing` / `cleo next` (next task discovery)

---

## 6. Orchestration Pipeline Status

**Status: Monitoring only. Not execution path.**

The orchestration pipeline (`cleo orchestrate status/spawn/chain`) is wired and returns valid JSON. But:
- No registered agents in the agent registry
- No evidence of `cleo orchestrate spawn` being used in audit log (last 200 entries)
- Actual parallel work uses Claude Code native subagents via Task tool + git worktrees
- CLEO's orchestrate layer is a status board, not a control plane

---

## 7. Per-Harness "Just Knows" Assessment

### Claude Code (Primary Harness in Use)

| Component | Status | Evidence |
|-----------|--------|----------|
| AGENTS.md injection | WORKS | CAAMP block loads memory-bridge + nexus-bridge |
| memory-bridge.md | EXISTS (53 lines) | Auto-regenerated on session end |
| nexus-bridge.md | EXISTS (42 lines) | Contains symbol counts, entry points, clusters |
| Session end → memory refresh | WORKS | `session.ts` calls `refreshMemoryBridge()` |
| Stop hook | EXISTS but wrong | Hook shows unread ClawMsgr messages, not memory |
| cleo commands available | YES | All core commands work |

**What works**: A Claude Code agent starts with memory-bridge + nexus-bridge pre-loaded. `cleo briefing` works. `cleo next` works. `cleo context pull` works. `cleo nexus context` works. `cleo memory find` works.

**What doesn't**: The Stop hook runs `clawmsgr-hook.sh` which checks for ClawMsgr notifications, not cleo session end. ClawMsgr appears deprecated. The hook does nothing useful.

### Pi (Primary Harness per ADR-035)

| Component | Status | Evidence |
|-----------|--------|----------|
| Pi adapter (packages/adapters) | SHIPPED | pi/ directory exists with 6 files |
| `.pi/` in project | MISSING | No .pi directory found |
| `.pi/extensions/` | MISSING | No hooks installed |
| Pi binary | unknown | Not tested in this session |
| CAAMP hooks (session_start → cleo) | NOT WIRED | hookConfigPathProject points to missing dir |
| session_shutdown → memory refresh | NOT WIRED | No .pi/extensions/session_shutdown.ts |

**Verdict**: Pi adapter shipped as code in packages/adapters but the hook installation step was not completed. A Pi agent working in this project would load AGENTS.md (via Pi's instructFile) but would not trigger cleo session start/end hooks automatically.

### OpenCode

No specific configuration found. Not tested.

---

## 8. The Honest Gap List

Every item below requires manual intervention that should be automatic:

### Critical Gaps (blocking automatic dogfooding)

1. **Agents are not registered in CLEO's agent registry.** `cleo agent list` returns 0. Every Claude Code subagent that runs is invisible to CLEO. The orchestrator cannot know which agents are active, what they're working on, or whether they finished — except by reading task state in tasks.db.

2. **Conduit is not used.** Agents cannot message each other through CLEO. All coordination is through shared DB state and filesystem files. The "inter-agent messaging" value proposition does not exist in practice.

3. **`cleo intelligence` domain is broken.** `cleo intelligence predict --task T487` returns `E_INVALID_OPERATION: Unknown operation: query:intelligence.predict`. The domain help shows predict/suggest/learn-errors/confidence/match subcommands, but the dispatch layer has no registered operations. The `cleo ops` tier-0 listing shows intelligence operations as `{}` (empty).

4. **Pi hooks not installed.** The Pi adapter was shipped as a package but the project-level hook directory (`.pi/extensions/`) was never created. Pi agents do not trigger cleo session lifecycle events.

5. **`cleo orchestrate spawn` is not in the actual execution path.** Claude Code native Task tool is used for subagent spawning. CLEO's spawn tracking does not capture these agents.

6. **GitNexus instructions in CLAUDE.md reference unavailable tools.** CLAUDE.md instructs agents to run `gitnexus_impact()`, `gitnexus_query()`, etc. These are MCP tools that were removed. Agents either ignore these instructions or hallucinate compliance.

### Moderate Gaps (degraded experience)

7. **`context pull` type field always returns `"unknown"`.** The 5 memory entries returned by `cleo context pull T553` all show `"type": "unknown"`. The type resolution code path is different from `memory find`, where types are populated correctly.

8. **`nexus context` processes field is always empty.** With 75 traced execution flows, symbol-to-process linkage is not working. The function `addTask` shows 20 callers but `processes: []`.

9. **memory-bridge.md is 53 lines — minimal.** The bridge contains last session, 5 recent decisions, 8 key learnings, 8 patterns, 10 observations. For a codebase with 425 archived tasks and years of learnings, 53 lines is thin coverage. Most brain content is not surfaced.

10. **`cleo briefing` lastSession.handoff is truncated.** The handoff note from the T553 session end is cut to a 80-character preview in the briefing JSON. Agents get a truncated handoff.

11. **GitNexus is stale (3 commits behind HEAD).** The CLAUDE.md instructions reference GitNexus as the authoritative code intelligence tool, but the index is stale and the MCP tools are unavailable.

### Minor Gaps (cosmetic or low impact)

12. **`cleo intelligence` help shows commands that don't work.** The CLI shows predict/suggest/learn-errors/confidence/match but these throw E_INVALID_OPERATION. This misleads agents.

13. **89% of agent outputs have no verifiable cleo execution evidence.** Agents write about using cleo but don't paste actual output. The BASE protocol requires writing to output files, but doesn't require proving the commands were run.

14. **4 stale worktrees exist** (agent-a1e05aeb, agent-a26e66f3, agent-ad025d3a, agent-aeda66c2) that are no longer active. These are not tracked by CLEO.

---

## 9. What Is Real vs What Is Claimed

### Real (Proven Working)

- `cleo session start/end` — used in every session (audit log shows regular pattern)
- `cleo complete`, `cleo start`, `cleo add` — used constantly (documented in MANIFEST.jsonl)
- `cleo check gate.set` — 12 gate-set events in last 50 audit entries
- `cleo memory observe` — 5 observations in last session
- `cleo next` — returns valid suggestions (T514, T515, etc.)
- `cleo briefing` — works, returns session context
- `cleo nexus context` — works, returns real callers/callees
- `cleo nexus status` — works, returns index stats
- `cleo memory find` — works, returns results with IDs and `_next` hints
- `cleo context pull` — works, returns task + memory bundle (type field is broken)
- Session end → memory-bridge.md refresh — confirmed wired in session.ts
- AGENTS.md injection chain (memory-bridge + nexus-bridge) — confirmed loaded

### Claimed But Not Proven

- "60+ agents deployed" — these were Claude Code subagents, not CLEO-registered agents
- Conduit-based inter-agent messaging — 4 test messages only, never in production
- Pi harness with CAAMP hooks — code shipped, hooks not installed in project
- `cleo intelligence predict/confidence` — dispatch is broken (E_INVALID_OPERATION)
- GitNexus tool calls (`gitnexus_impact`, `gitnexus_query`) — MCP removed, these fail silently
- Agents using `cleo memory` before writing code — 89 files claim it, 8 prove it

---

## Final Scores

| Domain | Score | Reason |
|--------|-------|--------|
| Task lifecycle (start/complete/next) | 9/10 | Genuinely used, audit log proves it |
| Session management | 8/10 | Works, wires to memory refresh |
| Memory (observe/find) | 5/10 | Works but 89% of files don't prove usage |
| Code intelligence (nexus) | 6/10 | cleo nexus context works; gitnexus dead |
| Agent registry | 1/10 | 0 registered agents |
| Conduit messaging | 1/10 | 4 test messages, never in production |
| Orchestration pipeline | 3/10 | Monitoring only, not execution path |
| Intelligence domain | 1/10 | Dispatch broken, E_INVALID_OPERATION |
| Pi harness integration | 2/10 | Code shipped, hooks not installed |
| Injection chain (AGENTS.md) | 8/10 | Works, both bridges auto-loaded |
| **Overall** | **4.5 / 10** | |

---

## Recommendations

### P0 — Fix Before Next Session

1. **Fix `cleo intelligence` dispatch.** Register predict, confidence, suggest, learn-errors, match operations in the dispatch registry. The CLI shows them but the domain has zero registered operations.
2. **Install Pi hooks for this project.** Create `.pi/extensions/session_start.ts` and `session_shutdown.ts` that call `cleo session start/end`. The adapter code exists — run the install step.
3. **Update CLAUDE.md** to stop instructing agents to use `gitnexus_impact()` and `gitnexus_context()`. These MCP tools were removed. Replace with `cleo nexus context` and `cleo nexus impact` equivalents.

### P1 — Fix This Week

4. **Wire Claude Code subagents to CLEO agent registry.** When the orchestrator spawns a subagent via Task tool, it should `cleo agent register` and `cleo agent signin` the subagent. Session end should `cleo agent stop`. Otherwise CLEO's agent layer has no visibility into actual work.
5. **Fix `context pull` type field.** The type resolution that works in `memory find` needs to be applied in the `admin.context.pull` code path.
6. **Fix `nexus context` processes field.** Symbol-to-process linkage needs to be populated in Cleo Nexus.

### P2 — Structural Improvements

7. **Add output evidence requirement to BASE protocol.** Agents should be required to paste at least one actual JSON response for key commands used (cleo next, cleo briefing, cleo memory find). "Show your work" at the command level.
8. **Grow memory-bridge.md.** 53 lines for a project with 425 archived tasks is too thin. The bridge generation should surface the top 20 learnings and top 10 decisions, not just the last 5.
9. **Assign task to Conduit removal or production wiring.** Either wire the Conduit (have agents actually use `cleo agent send` for handoffs) or acknowledge it is infrastructure-only and remove the claims from documentation.
