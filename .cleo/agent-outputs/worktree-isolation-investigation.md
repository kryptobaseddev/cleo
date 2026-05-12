# T1756: Worktree Isolation Investigation

**Date**: 2026-05-04
**Session**: ses_20260504150259_e03b6d (T1042 orchestration session)
**Investigator**: cleo-subagent (research protocol, no worktree — harness-targeted)

---

## 1. Executive Summary

The `## Worktree Setup (REQUIRED)` section in tier-1 spawn prompts is **documentation-only** — no programmatic enforcement exists for Claude Code subagents invoked via the Agent SDK dispatch path. The env vars (`CLEO_AGENT_CWD`, `CLEO_WORKTREE_ROOT`, `CLEO_WORKTREE_BRANCH`, `CLEO_PROJECT_HASH`) and `cwd` binding are computed and returned in the spawn response, but **never injected into the Claude Code subagent process** via the Agent SDK path. Three of six workers leaked because they ignored (or never saw the effect of) the `FIRST ACTION: cd <worktreePath>` directive in their prompt.

---

## 2. Root Cause Analysis

### 2.1 The Two Spawn Paths

CLEO supports two distinct spawn mechanisms. The bug affects only one of them:

**Path A — Programmatic SDK / PiHarness (DOES enforce isolation)**
`PiHarness.spawnSubagent()` in `packages/caamp/src/core/harness/pi.ts:466` accepts a `worktree` handle and:
- Sets `cwd: worktree.path` on the child process (line 550)
- Injects `CLEO_WORKTREE_ROOT`, `CLEO_WORKTREE_BRANCH`, `CLEO_PROJECT_HASH` into `env` (lines 519-526)

Result: the child process physically starts in the worktree directory with env vars set before any LLM action runs. Isolation is OS-level.

**Path B — Claude Code Agent SDK dispatch (DOES NOT enforce isolation)**
`orchestrateSpawn()` in `packages/core/src/orchestrate/spawn-ops.ts:551` is the path used when `cleo orchestrate spawn T####` is called from an orchestrator context. It:
1. Calls `spawnWorktree(root, { taskId })` — creates the git worktree and returns `envVars`, `cwd`, `preamble`
2. Calls `composeSpawnForTask()` — builds the prompt with `## Worktree Setup (REQUIRED)` section embedded
3. **Returns** the prompt, `worktreeEnv`, `worktreeCwd` to the caller
4. The caller (the orchestrator Claude Code session) displays the prompt. The human or orchestrator LLM is expected to spawn a subagent using the returned prompt.

When an orchestrator Claude Code session uses the Claude Code Agent SDK (`Agent` or `claude --print`) to spawn a subagent based on that returned prompt:
- No `cwd` is explicitly set on the subprocess — the subprocess inherits the orchestrator's cwd (`/mnt/projects/cleocode`)
- No env vars from `worktreeEnv` are injected — the subprocess sees none of `CLEO_WORKTREE_ROOT`, `CLEO_WORKTREE_BRANCH`, etc.
- The only isolation instruction is the text `FIRST ACTION: cd /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T####` inside the prompt

This means isolation is purely behavioral — if the subagent LLM fails to execute that `cd` as its literal first action, or if any Bash tool invocation later resets cwd to the inherited value, all subsequent writes land in `/mnt/projects/cleocode`.

### 2.2 Evidence: spawn-ops.ts Does Not Pass worktreeCwd to Adapter

`orchestrateSpawn()` (lines 647-786 of `spawn-ops.ts`) builds `sdkWorktreeResult` with path/envVars but passes only `worktreePath` and `worktreeBranch` to `composeSpawnForTask()` — for prompt generation only. The `worktreeAdapterResult?.envVars` and `worktreeAdapterResult?.cwd` are returned in `data.worktreeEnv` and `data.worktreeCwd` but there is no downstream code path that reads those fields and applies them to a subprocess spawn of Claude Code.

In contrast, `orchestrateSpawnExecute()` (the `spawn-execute` command, used for adapter-registry programmatic spawn) passes `workingDirectory: cwd` to the adapter context (line 427), but `cwd` here is `projectRoot ?? process.cwd()` — the **main project root**, not the worktree path. The `ClaudeCodeSpawnProvider.spawn()` then uses `spawnOpts.cwd = context.workingDirectory` (line 114 of `packages/adapters/src/providers/claude-code/spawn.ts`) — but this sets cwd to the main project root, not the worktree.

### 2.3 git-shim: Works Only When env Vars Are Present

The git-shim (`packages/git-shim/src/shim.ts`) reads `CLEO_AGENT_ROLE` and `CLEO_WORKTREE_ROOT` from the environment to enforce boundary checks. But:
- These vars are never injected into the Claude Code subprocess's environment (see §2.2 above)
- If the shim binary is on PATH (via the `PATH` prepend in `envVars`), but `CLEO_AGENT_ROLE` is not set, the shim falls through as a passthrough (line 54-58: `getAgentRole()` returns null if `CLEO_AGENT_ROLE` is absent)
- The shim's boundary fence also requires cwd to be inside the worktrees root to auto-detect — if cwd is `/mnt/projects/cleocode`, boundary detection fails silently

### 2.4 Behavioral vs. Structural Enforcement

The spawn prompt's `## Worktree Setup (REQUIRED)` section says `FIRST ACTION: cd <worktreePath>`. This relies on:
1. The LLM reading and obeying the instruction
2. The LLM's first Bash tool call being literally `cd <path>` (or equivalent)
3. Subsequent Bash calls not losing the cwd (each Bash call in Claude Code is a new shell — cwd does NOT persist between Bash tool calls by default)

Point 3 is the critical failure mode: even if the subagent correctly `cd`s in its first Bash call, subsequent Bash calls start fresh in the inherited cwd (`/mnt/projects/cleocode`). Write tools (Edit, Write) respect an absolute path, so those are fine — but any relative-path operation or bare `git commit` in a fresh Bash shell operates in the inherited cwd.

The T945 "hardened" prompt explicitly addressed point 3: "before EVERY tool/edit re-verify cwd". T945 did not leak. T1110, T1531, T1533 used standard tier-1 prompts without per-tool cwd re-verification and leaked.

### 2.5 Code References

| File | Line(s) | Role in bug |
|------|---------|------------|
| `packages/core/src/orchestrate/spawn-ops.ts` | 647-687 | Provisions worktree, captures `envVars`, `cwd` |
| `packages/core/src/orchestrate/spawn-ops.ts` | 700-707 | Passes worktreePath/Branch to prompt composer ONLY |
| `packages/core/src/orchestrate/spawn-ops.ts` | 735-770 | Returns worktreeEnv/worktreeCwd in response — no downstream consumer |
| `packages/core/src/orchestration/spawn-prompt.ts` | 449-474 | Builds text-only `## Worktree Setup (REQUIRED)` section |
| `packages/caamp/src/core/harness/pi.ts` | 514-551 | CORRECT enforcement via `cwd` + env injection — NOT the path used in practice |
| `packages/adapters/src/providers/claude-code/spawn.ts` | 108-115 | Sets `cwd` to `workingDirectory` — but `workingDirectory` = project root |
| `packages/git-shim/src/shim.ts` | 54-58 | Falls through if `CLEO_AGENT_ROLE` not in env |
| `packages/git-shim/src/worktree-path.ts` | 100-142 | Relies on `CLEO_WORKTREE_ROOT` env OR cwd being inside worktrees root |

---

## 3. Repro Evidence

**Direct evidence from session ses_20260504150259_e03b6d**:

- T1110: commit `3ef60e636` landed on `main` branch (author date 2026-05-04 08:39:26). Its assigned branch `task/T1110` also has commit `3dd6fcdcc`. The commit message on main references T1110 — the worker's first Bash shell started in `/mnt/projects/cleocode` and committed there directly.
- T1531: `packages/core/src/memory/session-narrative.ts` was modified in main's working tree (subsequently merged or cleaned). Branch `task/T1531` has `8f6e1be05`.
- T1533: `packages/core/src/memory/dialectic-evaluator.ts` similarly leaked. Branch `task/T1533` has `4765e7f45`.

**Confirming clean-leak split**:
- T945 (hardened prompt: per-tool cwd re-verify + explicit NEVER cd /mnt/projects/cleocode) — no leak
- T1073, T1532 — no leak (possibly different task complexity or happenstance correct first action)
- T1110, T1531, T1533 — leaked (standard tier-1 prompt)

**Structural proof**:
```bash
# Confirmed: worktree exists for project hash 1e3146b7352ba279
ls /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/
# T1531, T1533, T1736, T1756, T1757 worktrees exist
```

The worktrees were created successfully. The problem is exclusively that the Claude Code subprocess's cwd was never bound to the worktree.

---

## 4. Enforcement Mechanism Proposals

### Mechanism A: Inject cwd + env into Claude Code subagent spawns (HIGH ROI, MEDIUM effort)

**What**: When `orchestrateSpawn()` provisions a worktree, pass `worktreeCwd` and `worktreeEnv` to the Claude Code Agent SDK invocation. In practice, the orchestrator Claude Code session uses `Task` tool or sub-agent API to spawn workers — these accept a `cwd` parameter in the Agent SDK.

**How**:
1. Modify the spawn response contract to surface `worktreeCwd` prominently alongside `prompt`
2. Add a `## Environment Setup` section to the spawn prompt that includes bash commands: `export CLEO_WORKTREE_ROOT=<path>; export CLEO_AGENT_ROLE=worker; export CLEO_WORKTREE_BRANCH=<branch>`
3. For `orchestrateSpawnExecute()` (adapter-registry path), pass `workingDirectory: worktreePath` instead of `workingDirectory: projectRoot`
4. For PiHarness path, it already works — verify caller passes the `worktree` handle

**Tradeoffs**:
- Effort: medium (2-4 files, no schema changes)
- Robustness: high for OS-level cwd; moderate for env — the Agent SDK `cwd` parameter is OS-enforced, env injection requires SDK support
- Blast radius: low — changes are in spawn-ops.ts and the prompt builder
- Limitation: Bash tool calls in Claude Code still start new shells; cwd binding via `cwd` parameter only applies to the initial process, not individual Bash tool calls

### Mechanism B: Prompt hardening — mandatory per-Bash-call cwd guard (LOW effort, MODERATE robustness)

**What**: Add a mandatory shell preamble to every Bash example in the spawn prompt:
```bash
cd /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T#### || exit 1
# ... actual command ...
```

Also add to the Worktree Setup section: "EVERY Bash command MUST begin with `cd <worktreePath> && ...` or equivalent. The cwd is NOT preserved between Bash tool calls."

**How**: Modify `buildWorktreeSetupBlock()` in `spawn-prompt.ts` to:
1. Include the multi-line explanation that cwd resets between Bash calls
2. Provide a copy-paste shell alias: `alias cleo-cd='cd /path/to/worktree'`
3. Add a standard preamble variable that templates inject into every bash block

**Tradeoffs**:
- Effort: low (1 file, `spawn-prompt.ts`)
- Robustness: low-moderate — still behavioral, LLM may omit the prefix; hardened T945 prompt shows it works but requires discipline
- Blast radius: zero — prompt-only change, no code paths affected
- Best paired with: Mechanism A (belt-and-suspenders)

### Mechanism C: CLEO CLI cwd-enforcement wrapper (HIGH robustness, HIGH effort)

**What**: Ship a `cleo-task-shell` wrapper script that wraps bash invocations to enforce cwd. When `CLEO_WORKTREE_ROOT` is set, the wrapper validates cwd before forwarding:
```bash
#!/bin/bash
if [[ -n "$CLEO_WORKTREE_ROOT" ]] && [[ "$PWD" != "$CLEO_WORKTREE_ROOT"* ]]; then
  cd "$CLEO_WORKTREE_ROOT" || exit 1
fi
exec bash "$@"
```

Place this at `.cleo/bin/cleo-task-shell` and have the spawn payload instruct agents to use it. Or, have the git-shim also enforce this for file mutations.

**Tradeoffs**:
- Effort: high (new binary, PATH injection, Claude Code integration)
- Robustness: high if adopted — OS-level enforcement that catches every shell invocation
- Blast radius: medium — requires changes to how Claude Code shells out, PATH setup
- Risk: Claude Code may bypass via its native Bash tool's own shell resolution

### Mechanism D: Extend git-shim to enforce cwd for file mutations (MEDIUM effort, MEDIUM robustness)

**What**: The git-shim already runs on every `git` invocation when on PATH. Extend it (or add a parallel write-shim) to:
1. Check `CLEO_WORKTREE_ROOT` before allowing any file mutation
2. Auto-emit a warning + `cd` suggestion when cwd is the main project root during worker mode

**Tradeoffs**:
- Effort: medium (extend existing shim at `packages/git-shim/src/`)
- Robustness: medium — catches git mutations, but not Write/Edit tool calls (those go direct to FS)
- Blast radius: low — changes isolated to git-shim package

### Recommended Combination

**Short-term (immediate, 1 sprint)**:
1. Mechanism B: Harden the spawn prompt — document cwd-reset behavior, add per-call `cd` guidance
2. Mechanism A (partial): In `orchestrateSpawnExecute()`, pass `workingDirectory: worktreePath` not `projectRoot`

**Medium-term (follow-up)**:
3. Mechanism A (complete): Surface `CLEO_WORKTREE_ROOT` and `CLEO_AGENT_ROLE=worker` in the Agent SDK spawn env via prompt export block + document in worktree section
4. Mechanism D: Extend git-shim to also log/reject mutations when `CLEO_AGENT_ROLE=worker` and cwd is the main project root

---

## 5. Implementation Tasks (for filing under T1756)

### T1756-A: Harden tier-1 spawn prompt for Bash cwd-reset behavior
**Parent**: T1756
**Type**: task, size: small
**Description**: Modify `buildWorktreeSetupBlock()` in `packages/core/src/orchestration/spawn-prompt.ts` to:
1. Add explicit callout: "CRITICAL: Each Bash tool call starts a NEW shell. The cwd is NOT preserved between calls. Every Bash block must begin with `cd <worktreePath> || exit 1`."
2. Add a ready-to-use shell variable line agents should paste first: `WORKTREE="<worktreePath>"`
3. Provide a template pattern: `cd "$WORKTREE" && <actual command>`
**AC**: Spawn prompt tier-1 for any task with worktreePath includes the cwd-reset warning and template pattern

### T1756-B: Fix orchestrateSpawnExecute to pass worktreePath as workingDirectory
**Parent**: T1756
**Type**: task, size: small
**Description**: In `packages/core/src/orchestrate/spawn-ops.ts`, function `orchestrateSpawnExecute()`, provision a worktree (parallel to `orchestrateSpawn()`) and pass `workingDirectory: worktreePath` to `CLEOSpawnContext` instead of `workingDirectory: cwd` (the project root). This ensures `ClaudeCodeSpawnProvider` uses the worktree as the initial process cwd.
**AC**: When `cleo orchestrate spawn-execute T####` is called, the spawned Claude process starts in the worktree directory (verified by checking child process cwd in integration test)

### T1756-C: Inject CLEO_WORKTREE_ROOT and CLEO_AGENT_ROLE via spawn prompt export block
**Parent**: T1756
**Type**: task, size: small
**Description**: Add a `## Environment Initialization (MANDATORY)` section to the spawn prompt (in `buildWorktreeSetupBlock()`) that includes:
```bash
export CLEO_WORKTREE_ROOT="<worktreePath>"
export CLEO_AGENT_ROLE="worker"
export CLEO_WORKTREE_BRANCH="<branch>"
export CLEO_TASK_ID="<taskId>"
```
These exports must appear as the first Bash block agents run, before any other tool call. This enables the git-shim (when on PATH) to enforce boundary checks even without OS-level cwd injection.
**AC**: git-shim correctly blocks branch mutations for workers when invoked via a shell started after the export block

### T1756-D: Extend git-shim to warn when CLEO_AGENT_ROLE=worker but cwd is main project root
**Parent**: T1756
**Type**: task, size: small
**Description**: In `packages/git-shim/src/shim.ts`, add a pre-check: when `CLEO_AGENT_ROLE` is `worker` and `CLEO_WORKTREE_ROOT` is set but the cwd is NOT inside that worktree, emit a warning to stderr and exit 77. This catches leakage before it happens (git commits, git add from wrong cwd).
**AC**: Running `git add <file>` or `git commit` from `/mnt/projects/cleocode` with `CLEO_AGENT_ROLE=worker` and `CLEO_WORKTREE_ROOT=/path/to/worktree` exits 77 with a "cwd outside worktree boundary" message

---

## 6. Tradeoff Matrix

| Mechanism | Effort | Robustness | Blast Radius | Catches Write/Edit leaks | Catches git leaks | Priority |
|-----------|--------|------------|--------------|--------------------------|-------------------|----------|
| A: workingDirectory fix | Medium | High (OS) | Low | No (Write tool ignores cwd) | Partial | HIGH |
| B: Prompt hardening | Low | Moderate | Zero | No (behavioral) | No | HIGHEST (immediate) |
| C: cleo-task-shell wrapper | High | High | Medium | Partial | Yes | LOW (future) |
| D: git-shim cwd enforcement | Medium | Medium | Low | No | Yes | MEDIUM |

---

## 7. Files Modified in This Investigation

None — research task, no code changes.

## 8. Key Finding for Memory

The worktree isolation bug has two root causes:
1. **Missing cwd injection**: `orchestrateSpawn()` computes `worktreeCwd` but does not pass it to the Claude Code subprocess spawner. The prompt text `FIRST ACTION: cd <path>` is the only enforcement — purely behavioral.
2. **Bash cwd resets**: Claude Code's Bash tool starts a new shell for each call. Even a correctly-executed `cd` in the first call does not persist to subsequent calls. The hardened T945 prompt addressed this by requiring cwd re-verification before EVERY tool call.
