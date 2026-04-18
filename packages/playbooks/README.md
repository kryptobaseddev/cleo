# @cleocode/playbooks

**Playbook DSL + runtime for CLEO — T889 Orchestration Coherence v3.**

Playbooks are `.cantbook` YAML documents that describe a multi-step agent workflow as a DAG of nodes (agentic, deterministic, and approval gates) connected by typed edges. This package parses them, persists execution state to `tasks.db`, evaluates HITL auto-policies, and manages HMAC-signed approval tokens for human-in-the-loop gates.

## Status

| Wave | Concern | Status |
|------|---------|--------|
| W4-6 | Drizzle tables + types | shipped |
| W4-7 | `.cantbook` YAML parser | shipped |
| W4-8 | State layer CRUD | shipped |
| W4-9 | HITL auto-policy evaluator | shipped |
| W4-10 | State-machine runtime | pending |
| W4-16 | Approval resume tokens (HMAC) | shipped |

The runtime executor (`runtime.ts`) is the next ship — parser + state + policy + approval primitives are in place.

## Install

This is an internal monorepo package. Consumers use it via workspace dependency:

```jsonc
// package.json
{
  "dependencies": {
    "@cleocode/playbooks": "workspace:*"
  }
}
```

## What a `.cantbook` looks like

```yaml
version: "1.0"
name: release-cut
description: Cut a CalVer release and publish to npm

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

  - id: review
    type: approval
    prompt: "Build + tests green. Publish {{ version }} to npm?"
    depends: [test]

  - id: publish
    type: agentic
    skill: release-publisher
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
    to: publish

error_handlers:
  - on: test-failed
    action: abort
    message: "Tests failed — aborting release."
```

Validation rules enforced by the parser:
- `version` MUST be `"1.0"`.
- `name` MUST be non-empty.
- Node `id`s MUST be unique.
- Every `edges[].from` / `edges[].to` MUST reference a known node id.
- Nodes + edges MUST form a DAG (no cycles).
- `agentic` nodes MUST have `skill` OR `agent` (at least one).
- `deterministic` nodes MUST have `command` + `args`.
- `approval` nodes MUST have `prompt`.
- `depends[]` entries MUST be valid node ids.
- `iteration_cap` / `max_iterations` MUST be in `0..10` (hard limit).

## Quick API

```typescript
import {
  parsePlaybook,
  createPlaybookRun,
  updatePlaybookRun,
  evaluatePolicy,
  createApprovalGate,
  approveGate,
  rejectGate,
  DEFAULT_POLICY_RULES,
} from '@cleocode/playbooks';

// 1. Parse a .cantbook file
const { playbook, hash } = parsePlaybook(yamlSource);

// 2. Create a persisted run
const run = createPlaybookRun(tasksDb, {
  runId: 'run_abc123',
  playbookName: playbook.name,
  playbookHash: hash,
  bindings: { version: '2026.4.90' },
  epicId: 'T889',
  sessionId: 'ses_xyz',
});

// 3. Evaluate auto-policy at an approval node
const { autoPassed, reason } = evaluatePolicy(node, DEFAULT_POLICY_RULES, context);

// 4. Create an approval gate (pending) or auto-pass it
const approval = createApprovalGate(tasksDb, {
  runId: run.runId,
  nodeId: 'review',
  autoPassed,
});

// 5. Resolve the gate (human approves via the resume token)
approveGate(tasksDb, approval.token, { approver: 'keaton', reason: 'LGTM' });
```

## Database tables

Both tables live in `tasks.db`. Migration: `packages/core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/`.

### `playbook_runs`

| Column | Type | Notes |
|--------|------|-------|
| `run_id` | text PK | caller-supplied run id |
| `playbook_name` | text | from parsed playbook |
| `playbook_hash` | text | SHA-256 of source (parser computes) |
| `current_node` | text | id of the active node, `null` when done |
| `bindings` | json text | accumulated input + per-node output bindings |
| `error_context` | json text | populated when `status = 'failed'` |
| `status` | text | `running \| paused \| failed \| succeeded \| cancelled` |
| `iteration_counts` | json text | `{ nodeId: count }` — enforced against `iteration_cap` |
| `epic_id` | text | linked task epic (optional) |
| `session_id` | text | linked CLEO session (optional) |
| `started_at` | text | ISO-8601, defaults to `now()` |
| `completed_at` | text | ISO-8601 when terminal |

### `playbook_approvals`

| Column | Type | Notes |
|--------|------|-------|
| `approval_id` | text PK | |
| `run_id` | text | FK → `playbook_runs.run_id` |
| `node_id` | text | approval node id in the playbook |
| `token` | text UNIQUE | HMAC resume token |
| `requested_at` | text | ISO-8601 |
| `approved_at` | text | ISO-8601 on approve/reject |
| `approver` | text | who acted |
| `reason` | text | free-form rationale |
| `status` | text | `pending \| approved \| rejected` |
| `auto_passed` | int 0/1 | set by the policy evaluator |

## Approval tokens (HMAC)

Resume tokens are HMAC-SHA-256 signed with the secret resolved from `getPlaybookSecret(env)`:

1. `CLEO_PLAYBOOK_SECRET` (preferred)
2. `CLEO_SECRET` (fallback)
3. Hard error if neither is set — approval nodes cannot be created without a secret.

Tokens encode `{runId, nodeId, issuedAt}` and are verified before any `approveGate` / `rejectGate` call. Replay-resistant: an already-decided approval returns `E_APPROVAL_ALREADY_DECIDED`.

## Error codes

| Constant | Meaning |
|----------|---------|
| `E_APPROVAL_NOT_FOUND` | Token does not match any pending approval row |
| `E_APPROVAL_ALREADY_DECIDED` | Approval is already `approved` or `rejected` |
| `PlaybookParseError` | Thrown by `parsePlaybook` with a list of validation issues |

## Policy evaluator

`evaluatePolicy(node, rules, context)` matches an approval node against an ordered list of `PolicyRule`s. The first rule that matches decides: `autoPassed: true | false` plus a `reason`. Used to let low-risk approval gates auto-pass (e.g. "build dist unchanged from last green run") without bothering a human. `DEFAULT_POLICY_RULES` ships a safe conservative default set.

## Related packages

- **`@cleocode/contracts`** — `PlaybookDefinition`, `PlaybookRun`, `PlaybookApproval` type contracts consumed here.
- **`@cleocode/core`** — owns `tasks.db` lifecycle. Playbook migrations are applied by core's drizzle runner.
- **`@cleocode/cleo`** — CLI surface that will expose `cleo playbook run`, `cleo playbook approve <token>` once the runtime (W4-10) lands.

## Testing

```bash
pnpm --filter @cleocode/playbooks test
```

Smoke, parser, schema, state, policy, and approval test suites cover the shipped surface.
