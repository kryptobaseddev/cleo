# CLI Audit: Agent Domain

**Date**: 2026-04-10
**Auditor**: cleo-prime subagent (Sonnet 4.6)
**Scope**: `cleo agent *` (25 subcommands) + `cleo grade`
**Method**: `--help` on every command; live execution on all read-only commands

---

## Summary Table

| # | Command | Exit | Real Run | Notes |
|---|---------|------|----------|-------|
| 1 | `cleo agent register` | 0 | No (write) | Requires `--id --name --apiKey`; registers in local signaldock.db |
| 2 | `cleo agent signin` | 0 | No (write) | Marks agent active, caches credentials for session |
| 3 | `cleo agent start` | 0 | No (long-running) | Starts polling daemon; profile validated only, CANT execution lives in Pi |
| 4 | `cleo agent stop` | 0 | No (write) | Marks agent offline and deactivates |
| 5 | `cleo agent status` | 0 | **YES** | Returns active/lastUsed summary; works with or without AGENTID arg |
| 6 | `cleo agent assign` | 0 | No (write) | Sends assign message via conduit; args: AGENTID TASKID |
| 7 | `cleo agent wake` | 0 | No (write) | Sends a prod message to idle agent |
| 8 | `cleo agent spawn` | 0 | No (write) | Spawns ephemeral agent; `--role` required |
| 9 | `cleo agent reassign` | 0 | No (write) | Sends reassign message via conduit; args: TASKID AGENTID |
| 10 | `cleo agent stop-all` | 0 | No (write) | Marks all active agents offline |
| 11 | `cleo agent work` | 0 | No (long-running) | Autonomous polling loop; `--execute` enables Phase 3 Conductor Loop |
| 12 | `cleo agent list` | 0 | **YES** | Returns project-scoped agents; `--global` includes unattached |
| 13 | `cleo agent get` | 0 | **YES** | Full agent detail including masked API key; `--global` for non-attached |
| 14 | `cleo agent attach` | 0 | No (write) | Attaches global agent to current project; optional role/cap override |
| 15 | `cleo agent detach` | 0 | No (write) | Detaches from project, preserves global identity |
| 16 | `cleo agent remove` | 0 | No (write) | Default: detach (alias). `--global` removes from signaldock.db (destructive) |
| 17 | `cleo agent rotate-key` | 0 | No (write) | Generates new key on cloud, re-encrypts locally |
| 18 | `cleo agent claim-code` | 0 | No (write) | Generates human ownership claim code |
| 19 | `cleo agent watch` | 0 | No (long-running) | Continuous polling; optional `--group` for conversations |
| 20 | `cleo agent poll` | 0 | **YES** | One-shot fetch; defaulted to cleo-prime; returned `messages:[], count:0` |
| 21 | `cleo agent send` | 0 | No (write) | Sends message to agent or conversation; `--to` or `--conv` required |
| 22 | `cleo agent health` | 0 | **YES** | No-arg version returns all-zero summary (no daemon running); `--id` returned E_NOT_FOUND (bug — see §3) |
| 23 | `cleo agent install` | 0 | No (write) | Installs .cantz archive to project or `--global` tier |
| 24 | `cleo agent pack` | 0 | No (write) | Packages agent directory as .cantz archive |
| 25 | `cleo agent create` | 0 | No (write) | Scaffolds agent with persona.cant + manifest.json |
| 26 | `cleo grade` | 0 | **YES** | Lists 31 past sessions, all `sess1` (likely stale data); requires `--grade` flag at session start |

---

## Real Execution Results

### `cleo agent list` (default, project-scoped)
Returned 2 agents:
- `cleo-prime-dev` — active, attached
- `cleo-prime` — active, attached

### `cleo agent list --global`
Returned 3 agents (added `test-worker` — `isActive:false`, `attachment:"[global]"`).

### `cleo agent status` (no arg)
Returns lightweight summary for all agents: id, displayName, active flag, lastUsedAt, transport.

### `cleo agent status cleo-prime`
Returns same lightweight summary scoped to one agent.

### `cleo agent get cleo-prime`
Returns full record: masked API key, apiBaseUrl, classification (null), transportType, timestamps, projectRef block.

### `cleo agent health` (no args)
```json
{
  "summary": { "total": 0, "active": 0, "idle": 0, "starting": 0, "error": 0, "crashed": 0, "stopped": 0, "totalErrors": 0 },
  "staleAgents": [],
  "thresholdMs": 180000
}
```
Correct behavior — no agent daemon is running.

### `cleo agent health --id cleo-prime`
```json
{ "success": false, "error": { "code": "E_NOT_FOUND", "message": "Agent not found: cleo-prime" } }
```
Exit code 4. This is a **bug** — `cleo-prime` is a registered, attached agent that appears in `list`, `status`, and `get`. Health's `--id` filter appears to look only in the daemon runtime table (no running daemon = empty), not the credential registry. Help text says "Check health for a specific agent ID" with no indication it requires the agent to be running.

### `cleo agent poll` (no args)
Defaulted to `cleo-prime` (most recently used), returned `messages:[], count:0`. Exit 0.

### `cleo grade --list`
Returned 31 historical entries, all with `sessionId:"sess1"` — suggesting the grade command stored session IDs using a placeholder during initial development. All entries scored 0/100 with the flag `"No audit entries found for session (use --grade flag when starting session)"`. These are stale dev-time records.

---

## Bugs Found

| ID | Command | Severity | Description |
|----|---------|----------|-------------|
| B1 | `agent health --id` | Medium | Returns E_NOT_FOUND for valid registered agents. Health's `--id` scopes to daemon runtime only, not the credential registry. Help text is misleading — implies any registered ID works. |
| B2 | `grade --list` | Low | All 31 historical entries have `sessionId:"sess1"` — stale dev-time placeholder. No actual session IDs. Legitimate grades cannot be retrieved this way. |
| B3 | `agent status` vs `agent get` | Low | Output field mismatch: `status` returns `displayName` + `transport` (no apiBaseUrl, no timestamps), while `get` returns full record. No indication in help text which to use. |

---

## Duplicate / Overlap Analysis

### `cleo agent send` vs `cleo orchestrate conduit-send`

| Attribute | `agent send` | `orchestrate conduit-send` |
|-----------|--------------|---------------------------|
| Audience | Agents and operators | Orchestrators managing epics |
| Target | `--to <agentId>` or `--conv <convId>` | `--to <agentId>` or `--conversation <convId>` |
| Sender identity | `--agent` (cached credential) | Implicit (orchestrator's active agent) |
| Transport | SignalDock API | Conduit message loop |
| Help grouping | `agent` domain | `orchestrate` domain |

**Verdict: Genuine overlap.** Both commands send a message to an agent or conversation. The functional distinction is that `agent send` is for direct agent-to-agent messaging using a named credential, while `orchestrate conduit-send` is the orchestrator pipeline's message emission. In practice, the underlying transport may be the same. A user choosing between them gets no guidance. Recommend: add a "See also" note in each help text, or merge `orchestrate conduit-send` into `agent send --via conduit`.

---

### `cleo agent poll` vs `cleo orchestrate conduit-peek`

| Attribute | `agent poll` | `orchestrate conduit-peek` |
|-----------|--------------|---------------------------|
| Behavior | One-shot message fetch from SignalDock | One-shot peek at queued conduit messages |
| Agent resolution | Defaults to most recently used | Defaults to most recently used |
| Limit flag | `--limit` (default 20) | `--limit` (no default shown) |
| Return shape | `{ agentId, messages[], count, limit }` | `{ agentId, messages[] }` (no count/limit echo) |
| Transport | SignalDock cloud API | Conduit local queue |

**Verdict: Different transports, confusingly similar surface area.** `poll` hits SignalDock cloud; `conduit-peek` hits the local conduit queue. Both return messages for the current agent. Help text does not clarify this distinction. A user running `cleo agent poll` vs `cleo orchestrate conduit-peek` gets different message stores with no warning. Recommend: rename `conduit-peek` to `conduit-peek-queue` or add explicit "local queue" vs "cloud inbox" labels to both help texts.

---

### `cleo agent spawn` vs `cleo orchestrate spawn`

| Attribute | `agent spawn` | `orchestrate spawn` |
|-----------|---------------|---------------------|
| Purpose | Create a new ephemeral agent entity | Prepare spawn context (instructions/protocol) for a subagent |
| Required args | `--role` | `TASKID` |
| Output | Creates agent record + optional task assignment | Returns spawn context JSON for orchestrator to act on |
| Side effects | Write: creates agent in registry | Read/prepare only: no agent record created |

**Verdict: Not a true duplicate — complementary.** `agent spawn` creates the agent entity. `orchestrate spawn` prepares the task-scoped spawn payload an orchestrator passes to Claude. These serve different steps in the spawn lifecycle. However, the naming collision (`spawn` in both namespaces) is a discoverability hazard. Recommend: rename `orchestrate spawn` to `orchestrate spawn-context` or `orchestrate prepare-spawn` to disambiguate.

---

### `cleo agent assign` vs `cleo claim`

| Attribute | `agent assign` | `cleo claim` |
|-----------|----------------|--------------|
| Direction | Operator pushes task to agent via message | Agent claims task for itself |
| Args | `AGENTID TASKID` | `TASKID --agent AGENTID` |
| Mechanism | Sends conduit message | Direct DB assignment |
| Primary actor | Orchestrator / human | Agent acting on own behalf |

**Verdict: Complementary, not duplicate.** `agent assign` is a push from operator to agent. `claim` is a pull where the agent designates itself. The arg order difference (AGENTID-first vs TASKID-first) is a minor UX inconsistency worth noting. Recommend: add cross-references in help text.

---

### `cleo agent status` vs `cleo agent health`

| Attribute | `agent status` | `agent health` |
|-----------|----------------|----------------|
| Source | Credential registry (signaldock.db) | Daemon runtime state |
| Data | isActive flag, lastUsedAt, transport | crashed/idle/stale detection, heartbeat staleness |
| Scope | All registered agents (or one) | Running daemon instances only |
| Write mode | Read-only | `--detectCrashed` writes |

**Verdict: Complementary, but help text does not explain the registry vs runtime distinction.** A user running `agent status` sees `isActive:true` for all registered agents regardless of whether a daemon is running. `agent health` shows 0 agents when no daemon is active. Both returning "no problems" for different reasons is confusing. Recommend: add a note to `agent status` that `isActive` reflects credential state, not daemon liveness. Add a note to `agent health` that it only tracks daemon runtime instances.

---

### `cleo agent stop` vs `cleo agent stop-all`

**Verdict: Clear relationship.** `stop` targets one agent by AGENTID; `stop-all` targets all active agents. No overlap issue. The help texts are concise and accurate.

---

### `cleo agent detach` vs `cleo agent remove`

| Attribute | `agent detach` | `agent remove` |
|-----------|----------------|----------------|
| Default behavior | Detaches from current project | Also detaches from current project (same as detach) |
| With `--global` | N/A | Removes from global signaldock.db (destructive) |
| Preserves global? | Yes (explicit) | Yes by default; no with `--global` |

**Verdict: `remove` (default) is an alias for `detach` with no added value.** The default behavior of `agent remove` is identical to `agent detach`. The `--global` flag on `remove` is the only differentiator. This creates confusion: a user running `agent remove` expecting deletion gets a detach instead. Recommend: deprecate `agent remove` (default) in favor of always requiring `--global` or `--project` to make intent explicit. Or: keep `remove` as the destructive command only (`--global` always required) and let `detach` own the non-destructive path.

---

### `cleo agent watch` vs `cleo agent poll`

**Verdict: Clear distinction.** `watch` is long-running (loops with `--interval`). `poll` is one-shot. Names are appropriately differentiated. No issue.

---

### `cleo agent install` vs `cleo agent create`

**Verdict: Clear distinction.** `create` scaffolds a new agent from scratch. `install` deploys a pre-built `.cantz` archive. No overlap.

---

## Help Text Issues

| Command | Issue |
|---------|-------|
| `agent health --id` | Help says "Check health for a specific agent ID" — implies any registered agent ID works, but only daemon runtime IDs are valid. Misleading. |
| `agent status` | Does not explain that `isActive` reflects credential state, not daemon liveness. |
| `agent remove` | Default behavior (detach) is not called out. A user expects `remove` to delete. |
| `agent poll` | Does not indicate it hits SignalDock cloud (vs conduit local queue). |
| `orchestrate conduit-peek` | Does not indicate it hits local conduit queue (vs cloud). |
| `agent spawn` vs `orchestrate spawn` | Both called `spawn` with no disambiguation in either help text. |
| `agent send` vs `orchestrate conduit-send` | No cross-reference or transport label in either help text. |

---

## Recommendations (Priority Order)

| P | Action | Commands Affected |
|---|--------|-------------------|
| P1 | Fix `agent health --id` to accept registered agent IDs or update help text to state "daemon runtime instances only" | `agent health` |
| P2 | Add transport labels ("cloud inbox" vs "local conduit queue") to help text | `agent poll`, `orchestrate conduit-peek` |
| P3 | Rename `orchestrate spawn` to `orchestrate spawn-context` or `orchestrate prepare-spawn` to avoid spawn naming collision | `orchestrate spawn`, `agent spawn` |
| P3 | Clarify `agent remove` default: either require an explicit scope flag or rename to `agent unlink` for the detach path | `agent remove`, `agent detach` |
| P4 | Add "See also" cross-references between `agent send` and `orchestrate conduit-send` | `agent send`, `orchestrate conduit-send` |
| P4 | Add note to `agent status` that `isActive` is credential state, not daemon liveness | `agent status` |
| P5 | Investigate and purge stale `sess1` grade records in `grade --list` | `cleo grade` |
