# @cleocode/playbooks

> Part of [CLEO](https://github.com/kryptobaseddev/cleo#readme). Start with the root README; run `cleo <command> --help` for any command.

**Playbook DSL and runtime for CLEO.**

Playbooks are `.cantbook` YAML documents that describe a multi-step workflow as
a DAG of nodes (agentic, deterministic and approval gates) joined by edges
with optional contracts. This package parses them, runs them as a state
machine, persists run state to the project `cleo.db`
(`tasks_playbook_runs`, `tasks_playbook_approvals`), and issues HMAC resume
tokens for human-in-the-loop approval gates.

> **ADR-098** (`cleo docs fetch adr-098-retire-the-pi-cleoos-harness`): CLEO
> Goal ([ADR-097](../../docs/adr/ADR-097-goal-protocol-ocg-runtime.md)) is
> CLEO's one autonomous driver and replaces playbook *agent* steps as the way
> CLEO drives work. Deterministic and approval nodes stay. The `playbooks`
> namespace parts ADR-098 removes ship together in one announced release.

## CLI

- `cleo playbook run <name>`: walks the graph until it completes, fails or
  pauses at an approval gate.
- `cleo playbook status`, `cleo playbook resume`, `cleo playbook list`:
  inspect a run, resume a paused run once its gate is approved, list runs.
- `cleo playbook create` / `cleo playbook validate`: scaffold a `.cantbook`
  (via the playbook-architect meta-agent) or parse one (exit 70 on a parse
  error).
- `cleo orchestrate pending|approve|reject`: list pending gates, approve one by
  its resume token, or reject one with a reason.

`cleo playbook run` resolves `<name>.cantbook` from three tiers
(`packages/core/src/playbooks/playbook-resolver.ts`):
`<project>/.cleo/playbooks/`, then `<cleoHome>/playbooks/`, then this
package's `starter/` (`rcasd`, `ivtr`, `release`).

## How nodes run

The runtime (`src/runtime.ts`) is a pure state machine: it imports no
subprocess code. The caller injects an `AgentDispatcher` for `agentic` nodes
and a `DeterministicRunner` for `deterministic` nodes. The CLI wiring
(`packages/cleo/src/dispatch/domains/playbook.ts`) does this:

- **agentic**: the agent id is `node.agent ?? node.skill`.
  `runSkillNodeOrSpawn` (`packages/core/src/playbooks/skill-node-executor.ts`)
  runs the node **in-process** through the skill executor when that id is a
  skill `findSkill` resolves and the dispatch context does not set
  `isolation`. Otherwise it spawns a subagent through
  `orchestrateSpawnExecute`.
- **deterministic**: runs through the guarded runner
  (`packages/core/src/playbooks/guarded-deterministic-runner.ts`), which sends
  every command through the `createToolGuard` shell policy in `enforce` mode.
  A denied command fails the node instead of spawning.
- **approval**: the run is marked `paused`, an approval row with a resume
  token is written, and the runtime returns `terminalStatus: 'pending_approval'`
  with `approvalToken`. Approve or reject the gate, then resume.

The runtime reports one of four terminal statuses: `completed`, `failed`,
`pending_approval` or `exceeded_iteration_cap`. A failing node is retried up
to its `on_failure.max_iterations` (runtime default 3); `requires`/`ensures`
contract violations are appended to `.cleo/audit/contract-violations.jsonl`
and trigger the `contract_violation` error handler.

## What a `.cantbook` looks like

```yaml
version: "1.0"
name: release-cut
description: Build, test, and publish after a human approves

inputs:
  - name: version
    required: true
    description: Target version (e.g. 2026.4.90)

nodes:
  - id: build
    type: deterministic
    command: pnpm
    args: [run, build]

  - id: test
    type: deterministic
    command: pnpm
    args: [run, test]
    depends: [build]
    on_failure:
      max_iterations: 2

  - id: review
    type: approval
    policy: conservative
    prompt: "Build + tests green. Publish {{inputs.version}} to npm?"
    depends: [test]

  - id: notes
    type: agentic
    skill: ct-documentor
    depends: [review]

edges:
  - from: build
    to: test
    contract:
      requires: [dist-exists]
      ensures: [tests-passed]
  - from: test
    to: review
  - from: review
    to: notes

error_handlers:
  - on: contract_violation
    action: abort
    message: "Contract violated — aborting release."
```

Parser rules (`src/parser.ts`; the first violation throws `PlaybookParseError`):

- `version` MUST be `"1.0"`; `name` MUST be non-empty; `nodes` MUST be a
  non-empty array.
- Node `id`s MUST be unique; `type` MUST be `agentic`, `deterministic` or
  `approval`.
- `agentic` nodes MUST have `skill` or `agent` (at least one); `role`, when
  set, is `orchestrator`, `lead` or `worker`.
- `deterministic` nodes MUST have a non-empty `command` (`args` defaults to
  `[]`).
- `approval` nodes MUST have `prompt`; `policy`, when set, is `conservative`,
  `permissive` or `custom`.
- Every `edges[].from` / `edges[].to` and every `depends[]` entry MUST name a
  known node; edges and `depends` together MUST form a DAG.
- `on_failure.max_iterations` MUST be in `0..10`.
- `error_handlers[].on` is `agentic_timeout`, `iteration_cap_exceeded` or
  `contract_violation`; `action` is `inject_hint`, `hitl_escalate` or `abort`.

## Quick API

```typescript
import {
  approveGate,
  createApprovalGate,
  createPlaybookRun,
  evaluatePolicy,
  executePlaybook,
  parsePlaybook,
  resumePlaybook,
} from '@cleocode/playbooks';

// 1. Parse a .cantbook file
const { definition, sourceHash } = parsePlaybook(yamlSource);

// 2. Run it (db is the project cleo.db handle)
const result = await executePlaybook({
  db,
  playbook: definition,
  playbookHash: sourceHash,
  initialContext: { version: '2026.4.90' },
  dispatcher,            // AgentDispatcher for agentic nodes
  deterministicRunner,   // optional; without one, deterministic nodes go to the dispatcher
});

// 3. A gate paused the run: approve it, then resume
if (result.terminalStatus === 'pending_approval' && result.approvalToken) {
  approveGate(db, result.approvalToken, 'keaton', 'LGTM');
  await resumePlaybook({ db, playbook: definition, approvalToken: result.approvalToken, dispatcher });
}

// Lower-level pieces
const run = createPlaybookRun(db, { playbookName: definition.name, playbookHash: sourceHash });
const gate = createApprovalGate(db, { runId: run.runId, nodeId: 'review', bindings: {} });
const decision = evaluatePolicy('git push origin main'); // { action: 'require-human', reason: 'push', ... }
```

## Database tables

Both tables live in the project `cleo.db` (schema:
`packages/core/src/store/schema/cleo-project/runtime.ts`). They were first
created in the legacy `tasks.db` by
`packages/core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/`,
before the store consolidated into `cleo.db`.

### `tasks_playbook_runs`

| Column | Type | Notes |
|--------|------|-------|
| `run_id` | text PK | generated by `createPlaybookRun` (UUID) |
| `playbook_name` | text | from the parsed playbook |
| `playbook_hash` | text | SHA-256 of the source (parser computes) |
| `current_node` | text | id of the active node, `null` when done |
| `bindings` | json text | accumulated input and per-node output bindings |
| `error_context` | json text | populated when `status = 'failed'` |
| `status` | text | `running \| paused \| completed \| failed \| cancelled` |
| `iteration_counts` | json text | `{ nodeId: count }`, checked against each node's cap |
| `epic_id` | text | linked epic (optional) |
| `session_id` | text | linked CLEO session (optional) |
| `started_at` | text | ISO-8601, defaults to now |
| `completed_at` | text | ISO-8601 when terminal |
| `uid` | text | unique row identity |

### `tasks_playbook_approvals`

| Column | Type | Notes |
|--------|------|-------|
| `approval_id` | text PK | UUID |
| `run_id` | text | the run (no foreign-key constraint) |
| `node_id` | text | approval node id in the playbook |
| `token` | text UNIQUE | HMAC resume token |
| `requested_at` | text | ISO-8601 |
| `approved_at` | text | ISO-8601 on approve/reject |
| `approver` | text | who acted |
| `reason` | text | free-form rationale |
| `status` | text | `pending \| approved \| rejected` |
| `auto_passed` | int 0/1 | gate created already approved |
| `uid` | text | unique row identity |

## Approval tokens (HMAC)

`generateResumeToken(runId, nodeId, bindings, secret)` returns `v2:` followed by
the first 32 lowercase hex characters of HMAC-SHA-256 over
`runId:nodeId:<bindings as sorted-key JSON>`.
The secret comes from `getPlaybookSecret(env)`:

1. A nonempty `CLEO_PLAYBOOK_SECRET`, when configured.
2. Otherwise a purpose-bound key derived from the installation's private
   `machine-key` in CLEO home. The credential machinery creates that key once,
   exclusively, with permission and length checks. There is no public fallback.

`approveGate` / `rejectGate` look the gate up by its exact stored token and only
move a `pending` gate: an unknown token fails with `E_APPROVAL_NOT_FOUND`, an
already-decided gate with `E_APPROVAL_ALREADY_DECIDED`.

Legacy tokens are refused for decisions and resume, including gates approved
before the upgrade, with `E_APPROVAL_TOKEN_LEGACY`: request a fresh gate with
`cleo playbook run <name>`. Existing legacy rows remain intact; restarting a
playbook executes its earlier steps again, so the owner must review those steps
before restarting it. A `resume:...` row is an audit trace, never an approval
token. The owner can clear an old pending trace with
`cleo orchestrate reject <resumeToken> --reason "clear resume trace"`;
approval or resume of a trace refuses with `E_APPROVAL_RESUME_TRACE`. New traces
are recorded as already approved and never appear in pending approvals.

`cleo orchestrate approve` and `reject` require the same human owner authority as
the owner override: an unrestricted bootstrap role, an owner-marked bound session
(`cleo session start --scope global --name owner --owner`), and the owner's own
stdin/stderr terminal, through the direct CLI. HTTP, MCP and RPC clients cannot
inherit the serving process's owner authority. Setting an approver label or
`CLEO_OWNER_OVERRIDE` does not grant authority. `cleo orchestrate pending` and
`cleo playbook run|resume` disclose tokens only to that owner; other callers see
pending metadata and paused run results without tokens. The installation key is
read only when execution reaches an approval node. The SDK's synchronous database
primitives are trusted in-process APIs; dispatch enforces caller authority.

## Error codes

| Code | Meaning |
|------|---------|
| `E_APPROVAL_NOT_FOUND` | No approval row matches the token |
| `E_APPROVAL_ALREADY_DECIDED` | The approval is already `approved` or `rejected` |
| `E_APPROVAL_TOKEN_LEGACY` | Re-request the gate using a fresh playbook run |
| `E_APPROVAL_RESUME_TRACE` | Audit traces cannot approve or resume; the owner can reject an old pending trace |
| `E_OVERRIDE_NOT_OWNER` | The caller has no owner-marked session or own terminal |
| `E_OVERRIDE_FORBIDDEN_AGENT_ROLE` | The caller runs as a restricted agent role |
| `E_PLAYBOOK_PARSE` | `PlaybookParseError` from `parsePlaybook` (exit code 70), with the offending `field` and `value` |
| `E_PLAYBOOK_RESUME_BLOCKED` | `resumePlaybook` got a token that does not resolve to an `approved` gate |
| `E_PLAYBOOK_RUNTIME_INVALID` | Invalid runtime input, e.g. no entry node, or a node with more than one unconditional successor |

## Policy evaluator

`evaluatePolicy(command, rules = DEFAULT_POLICY_RULES)` classifies a resolved
command string as `auto-approve` or `require-human`. Every `require-human`
rule is tested before any `auto-approve` rule, so an appended auto-approve
rule cannot override a block in the same list, and an unmatched command
returns `{ action: 'require-human', reason: 'default' }`.
`DEFAULT_POLICY_RULES` blocks publish, push, tag, release and workflow
triggers, and auto-approves a small set of QA tools and read-only `cleo`
verbs.

## Related packages

- **`@cleocode/contracts`**: `PlaybookDefinition`, `PlaybookRun`,
  `PlaybookApproval` and the other playbook types used here.
- **`@cleocode/core`**: owns `cleo.db` and its migrations, the playbook
  resolver, the skill-node executor and the guarded deterministic runner.
- **`@cleocode/cleo`**: the `cleo playbook` and `cleo orchestrate
  approve|reject|pending` commands.

## Testing

```bash
pnpm --filter @cleocode/playbooks test
```

Suites in `src/__tests__/` cover the parser, schema, state, policy, approvals,
runtime, guarded deterministic dispatch and the starter playbooks.
