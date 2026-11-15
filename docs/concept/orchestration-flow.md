# CLEO Orchestration Flow

How a task goes from an epic to merged work, checked against the code on
2026-11-15 (T14108). Where this doc and the code disagree, the code wins.

## The flow

1. **Plan.** `cleo orchestrate start <epicId>` opens the orchestration for an
   epic. `cleo orchestrate ready`, `waves`, `plan` and `next` name the tasks
   that can run now without conflicting.
2. **Compose.** `cleo orchestrate spawn <taskId>` returns the spawn payload for
   one task: the chosen agent, role, tier and the full worker prompt
   (`composeSpawnPayload`, below). It starts nothing.
3. **Launch.** `cleo orchestrate spawn-execute <taskId>` (or `fanout` to spawn an epic's ready tasks in parallel)
   provisions the task's worktree and starts a harness worker through its
   provider adapter, or through Orca when it runs inside Orca. See
   [Spawn execution and roles](#spawn-execution-and-roles).
4. **Work.** The worker runs in the harness (Claude Code, Codex, OpenCode and
   others). It works in its worktree on the task branch and calls `cleo` for
   task state, memory and docs. CLEO has no agent loop of its own (ADR-098).
5. **Report.** Messages between the lead and its workers go over AgentMBX.
   Orca relays a worker's report to the lead (D11242). `cleo orchestrate
   worker-exit` records a worker's exit and fires `SubagentStop` once.
6. **Integrate.** A worker's work reaches `main` in one of two ways:
   - **PR (ADR-099).** The worker pushes its branch and opens a ready PR to
     `main` whose body names its tasks (`Closes: T#### AC1,AC2`, or `Refs:` for
     partial work). A reviewer who is not the author records a verdict per
     criterion with `cleo review verdict`. The PR merges once its required
     checks are green, and the merge sweep then closes the named tasks with
     `pr:`, `ci:` and `satisfies:` evidence. See the
     [merge runbook](../guide/merge-runbook.md).
   - **Local merge (ADR-062).** `cleo orchestrate worktree-complete` merges the
     worktree into the default branch with `git merge --no-ff`. A worker that
     exits 0 inside the spawn call is merged this way automatically (below).

The no-hands lead (`cleo orchestrate lead <epicId>`, behind
`orchestrate.leadWorker.v1`) drives steps 1 to 6 without editing tools. It runs
allow-listed `cleo` and `gh` commands only, through `cleo orchestrate
lead-runner`.

## Composing a spawn

`composeSpawnPayload` (`packages/core/src/orchestration/spawn.ts`) is the one
function that builds a spawn payload. Its steps, in code order:

1. **Agent.** An explicit `agentId` wins. Otherwise `classifyTask`
   (`packages/core/src/orchestration/classify.ts`) picks one of
   `project-orchestrator`, `project-dev-lead`, `project-code-worker`,
   `project-docs-worker` or `project-security-worker`. Below its confidence
   floor it falls back to `cleo-subagent`. Spawn never selects a custom
   persona by name (T14588).
2. **Registry.** `resolveAgent` (`packages/core/src/store/agent-resolver.ts`)
   turns the id into a `ResolvedAgent` through five tiers: `project`, `global`
   and `packaged` rows of the global `agent_registry_agents` table, then a
   `fallback` built from the bundled seed `.cant`, then a synthetic `universal`
   agent. A row whose `.cant` file is gone is skipped, so a deleted tier never
   breaks spawning.
3. **Role.** An explicit role wins, then the classifier's role (when it did not
   fall back), then the agent's `orchLevel` (0 orchestrator, 1 lead, 2 worker).
4. **Tier.** An explicit tier wins, else the role's default.
5. **Harness hint.** `resolveHarnessHint`
   (`packages/core/src/orchestration/harness-hint.ts`) decides whether the
   harness already loads `AGENTS.md`, so the prompt can skip the
   CLEO-INJECTION embed. Order: the explicit option, `CLEO_HARNESS`,
   `CLEO_HARNESS_LOADS_AGENTS_MD=1`, `.cleo/harness-profile.json`, then
   auto-detected Claude Code (both `CLAUDECODE=1` and `CLAUDE_CODE_ENTRYPOINT`
   set), else `generic`. Values: `claude-code`, `generic`, `bare`.
6. **Atomicity.** For workers, `checkAtomicity` checks the task's file scope.
7. **Thin agent.** `enforceThinAgent` rejects or strips worker tools that would
   let a worker spawn its own agents (`Agent`, `Task`), depending on mode.
8. **Prompt.** `buildSpawnPrompt`
   (`packages/core/src/orchestration/spawn-prompt.ts`) renders the prompt,
   with tokens filled as described below.

The payload carries `composerVersion: '3.0.0'`, the resolved agent, the role,
tier, harness hint, atomicity verdict, the prompt and a `meta` record of the
classification.

## Spawn execution and roles

Folded from the retired lead-vs-worker and subagent-injection guides (T14108 docs
census). Their Pi `cleo-cant-bridge` `tool_call` enforcement, `delegate()` tool
and `AGENT_DOMAIN_RULES`/`LEAD_MEMBERS_JSON` environment were removed with the Pi
harness (ADR-098); what follows is what the code does today.

**Execution.** `cleo orchestrate spawn <taskId>` returns the composed
`SpawnPayload`; executing a spawn (`orchestrate.spawn.execute`) goes through
`orchestrateSpawnExecute` (`packages/core/src/orchestrate/spawn-ops.ts`). It
takes a resource grant before anything is provisioned, then tries to provision
the worker's worktree (`spawnWorktree`, then `provisionIsolatedShell` for its cwd
and environment). `resolveIsolation`
(`packages/core/src/orchestrate/isolation-policy.ts`) decides what a provisioning
failure means:

- a task worktree held by a live lock always refuses the spawn, so two agents
  never work one task;
- with `orchestrate.leadWorker.v1` on (default off), for an Orca launch, or when
  `--base` was given, the spawn is refused with the provisioning error;
- otherwise the worker runs in the project root without isolation, and only a
  warning is logged (T14575 tracks closing this fallback).

A lead is never provisioned and runs in the project root. The spawn provider, for
example `ClaudeCodeSpawnProvider`
(`packages/adapters/src/providers/claude-code/spawn.ts`), writes the prompt to a
private temp file and starts the harness CLI detached in that working directory.
Its environment carries the session binding (`CLEO_SESSION_ID`, `CLEO_AGENT_ID`,
`CLEO_AGENT_ROLE`) and, when isolated, the worktree variables
(`CLEO_WORKTREE_ROOT`, `CLEO_WORKTREE_BRANCH`, `CLEO_PROJECT_HASH`); the prompt
repeats the binding as an export block the agent runs first
(`packages/core/src/orchestration/spawn-prompt.ts`).

Integration at spawn: a worker whose run finishes inside the spawn call with
exit code 0 has its worktree merged back with `git merge --no-ff` (ADR-062),
unless auto-complete is off or `CLEO_NO_AUTO_WORKTREE_COMPLETE` is set. A
tracked worker (one whose exit CLEO observes, T14359) is still running when the
spawn returns, so it is not integrated at spawn. A lead has nothing to
integrate.

**Prompt tokens.** Folded from the retired token-replacement contract (T14108
docs census). `buildSpawnPrompt` (`packages/core/src/orchestration/spawn-prompt.ts`)
substitutes `{{TOKEN}}` markers in the sections CLEO authors: `TASK_ID`, `DATE`,
`EPIC_ID`, `OUTPUT_DIR`, `TEST_RUNS_DIR`, `PROJECT_ROOT`, `SESSION_ID`,
`PROTOCOL`, `TIER`, `TOPIC_SLUG` (the task title as a doc-name-rule slug),
`WORKTREE_PATH` and `WORKTREE_BRANCH`. Embedded content (the CLEO-INJECTION and
skill excerpts) is appended verbatim afterwards, so token examples there are not
substituted or flagged. A marker with no value stays in the text and is listed
in `tokenResolution.unresolvedTokens` by `prepareSpawn`
(`packages/core/src/orchestration/index.ts`); it does not refuse the spawn. When
the resolved agent has a `.cant` file, `applyCantBodySubstitution`
(`packages/core/src/orchestrate/spawn-ops.ts`) fills its `{{var}}` markers from
the spawn's session context, `.cleo/project-context.json` and the environment,
leniently and prepends the body to the prompt. The native spawn result reports
the substitution (including missing variables) under
`data.meta.templateSubstitution`; an Orca launch result does not carry it.

**Lead and worker.** A worker spawn carries no denied tools and runs in its
worktree when provisioning succeeds (see the failure rules above). A lead spawn carries `LEAD_DENIED_TOOLS`
(`packages/contracts/src/operations/orchestrate.ts`: `Bash`, `Edit`, `Write`,
`MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch`). A provider that can strip
them declares `leadToolStrip: 'enforced'` (claude-code, claude-sdk); any other
provider refuses a lead spawn with `E_LEAD_TOOLS_UNSTRIPPED` before anything runs
(`packages/adapters/src/providers/shared/lead-tool-strip.ts`). On Claude Code the
lead also starts with a strict MCP config naming at most the lead runner
(`cleo orchestrate lead-runner`) and the user's AgentMBX server
(`packages/adapters/src/providers/claude-code/lead-mcp.ts`), so no other MCP
server can hand the stripped tools back.

## Playbooks

`.cantbook` playbooks (`packages/playbooks/`) are deterministic state machines
with three node kinds: `agentic`, `deterministic` and `approval`
(`packages/contracts/src/playbook.ts`). `cleo playbook run|status|resume|list`
runs them. An `agentic` node goes through the same `orchestrateSpawnExecute`
path as `spawn-execute`. A `deterministic` node runs a shell step through the
deny-first tool guard. An `approval` node pauses the run with an HMAC resume
token, which `cleo orchestrate approve|reject|pending` act on.

Three starters ship in `packages/playbooks/starter/`: `rcasd.cantbook`,
`ivtr.cantbook` and `release.cantbook`. ADR-098 makes CLEO Goal the one
autonomous driver, in place of playbook agent steps. `cleo orchestrate ivtr`
is removed (T14311).

## Data model

| Table | Store | Holds |
|---|---|---|
| `agent_registry_agents` | global `cleo.db` | The agent registry: one row per agent id, with the tier whose directory holds its `.cant` |
| `agent_registry_skills`, `agent_registry_capabilities` | global `cleo.db` | Skills and capabilities attached to agents |
| `tasks_playbook_runs` | project `cleo.db` | One row per playbook run: current node, bindings, iteration counts, status |
| `tasks_playbook_approvals` | project `cleo.db` | One row per approval gate: HMAC token, status, approver, reason |

Schemas: `packages/core/src/store/schema/cleo-global/agent-registry.ts` and
`packages/core/src/store/schema/cleo-project/runtime.ts`.

## References

- [CLEO architecture guide](cleo-architecture-guide.md): where orchestration sits in CLEO
- [Merge runbook](../guide/merge-runbook.md): PR, verdict and merge sweep (ADR-099)
- [Creating custom agents](../guide/creating-custom-agents.md): `.cant` agents and teams
- ADR-062: worktree integration with `git merge --no-ff`
- ADR-098, harness-agnostic core: `cleo docs fetch adr-098-retire-the-pi-cleoos-harness`
- [ADR-053: playbook runtime](../adr/ADR-053-playbook-runtime.md)
