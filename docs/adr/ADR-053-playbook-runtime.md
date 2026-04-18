# ADR-053: Playbook Runtime as a Deterministic State Machine

**Status**: Accepted (2026-04-18)
**Date**: 2026-04-18
**Task**: T930 (epic T910 — Orchestration Coherence v4)
**Commit**: `f3dcceb02`
**Scope**: `packages/playbooks`, `packages/contracts/src/playbook.ts`

> Note: an earlier ADR at `.cleo/adrs/ADR-053-project-agnostic-release-pipeline.md`
> also bears the number 53. The two live in separate directories and cover
> unrelated concerns (release pipeline vs. playbook runtime). The
> `.cleo/adrs/` tree is the historical in-repo log; `docs/adr/` is the shipping
> canonical tree used by ADR-052 (T933) and this ADR (T930/T910). Future ADRs
> land under `docs/adr/`.

## Context

Epic T889 "Orchestration Coherence v3" shipped the foundation types,
registry, resolver, canonical composer, and parser for a declarative
`.cantbook` playbook DSL. What it did **not** ship was the executable runtime
— the piece that turns a validated `PlaybookDefinition` into a live sequence
of agent dispatches, deterministic commands, and human approval gates.

Four properties were non-negotiable for the runtime:

1. **Provider-neutral.** CLEO targets Claude Code, OpenAI Agents, Cursor,
   Codex, Gemini CLI, Pi, Kimi, Opencode, and direct SDK calls through the
   Vercel AI SDK. The runtime cannot import or instantiate any provider SDK.
2. **Testable without mocks of `@cleocode/*`.** Every execution branch —
   success, retry, iteration-cap, approval pause, approval reject, resume —
   must be exercisable with stub dispatchers. This rules out procedural code
   that reaches into the core package to dispatch work.
3. **Auditable and resumable.** HITL approval gates are a load-bearing
   requirement (T889 Wave D-16). Paused runs must survive process restarts and
   carry cryptographic evidence of the approval decision.
4. **Declarative at the authoring layer.** Operators should author flows in
   YAML (`.cantbook`), not TypeScript. The runtime is the executor, not the
   specification.

These constraints rule out both "ad-hoc procedural code with a big `switch`"
and "inherit-from-a-framework" solutions. The decision is about picking the
right abstraction between those extremes.

## Decision

Implement the playbook runtime as a **pure-function state-machine executor**
with dependency-injected dispatchers. Concretely:

### Node kinds (3, discriminated union)

```typescript
type PlaybookNode =
  | PlaybookAgenticNode       // type: 'agentic'
  | PlaybookDeterministicNode // type: 'deterministic'
  | PlaybookApprovalNode;     // type: 'approval'
```

- `agentic` — dispatched through an injected `AgentDispatcher`. The dispatcher
  owns the provider SDK call.
- `deterministic` — command + args, dispatched through an injected
  `DeterministicRunner`. Falls back to `AgentDispatcher.dispatch` with
  `agentId = "deterministic:<command>"` if no runner is supplied, so tests
  can stub one path.
- `approval` — HITL gate. Writes a `PlaybookApproval` row with an HMAC-signed
  resume token and pauses the run.

The graph's **entry node** is any node with no predecessors (including
`depends[]` reverse edges). The graph's **end state** is a node with no
successors. Entry and end are derived from the graph rather than being
explicit node kinds — this avoids dead surface area in the DSL.

### Dependency-injected dispatchers

```typescript
interface AgentDispatcher {
  dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult>;
}

interface DeterministicRunner {
  run(input: DeterministicRunInput): Promise<DeterministicRunResult>;
}
```

The runtime receives these at call time. It never constructs them. It never
imports from `@cleocode/core`, `@cleocode/adapters`, or any provider SDK. A
test fixture can therefore cover every branch with a 10-line stub.

### Iteration caps + escalation

Each node carries `on_failure.max_iterations` (default 3, parser-enforced
max 10) and optional `on_failure.inject_into`. Retry semantics:

- `cap === 0` disables retries; first failure is fatal.
- `cap > 0` allows up to `cap` total attempts.
- When the cap fires and `inject_into` names another node, control jumps
  there with `__lastError` / `__lastFailedNode` in context, and the injection
  target's own iteration counter resets.
- When the cap fires with no valid `inject_into`, the run terminates with
  `terminalStatus: 'exceeded_iteration_cap'`.

### HITL resume tokens (HMAC-SHA256)

Tokens are 32-char hex HMAC-SHA256 derived from:

```
HMAC(secret, "runId:nodeId:canonicalBindings")
```

Bindings are canonicalized via sorted-keys JSON so semantically identical
payloads always yield the same token. Determinism prevents duplicate gates
for the same step. Production deployments MUST set `CLEO_PLAYBOOK_SECRET`;
the dev fallback is clearly marked as such and is not suitable for
production.

Tokens bind `{runId, nodeId, bindings}` cryptographically so they cannot be
forged or replayed across executions. When the secret rotates, existing
tokens are invalidated because the HMAC output changes.

### Persistence

- `playbook_runs` (in `tasks.db`) — one row per execution. `current_node` and
  `bindings` are updated after every step so crashes are recoverable.
- `playbook_approvals` (in `tasks.db`) — one row per HITL gate. Status is one
  of `pending` / `approved` / `rejected`. `auto_passed = 1` when policy
  pre-approved (see `evaluatePolicy` in `packages/playbooks/src/policy.ts`).

Updates use BEGIN/COMMIT transactions so partial failures cannot leave a
half-mutated row.

### Terminal statuses

```typescript
type PlaybookTerminalStatus =
  | 'completed'
  | 'failed'
  | 'pending_approval'
  | 'exceeded_iteration_cap';
```

Every call to `executePlaybook` or `resumePlaybook` returns an
`ExecutePlaybookResult` carrying the terminal status, final context,
failed/exceeded node id (when applicable), and the approval token (when
paused).

## Consequences

### Positive

- **Provider-neutral.** The runtime compiles and tests without any
  `@cleocode/adapters` import. Porting to a new LLM provider requires zero
  changes to the runtime — only a new dispatcher implementation.
- **Testable.** 100% of branches are covered with stub dispatchers. No
  `vi.mock('@cleocode/core')` is required.
- **Auditable.** Every HITL decision writes a cryptographic token to
  `playbook_approvals`. The `auto_passed` flag distinguishes policy-approved
  gates from human-approved ones.
- **Resumable.** A killed process leaves `playbook_runs.status='paused'` (for
  HITL) or `status='running'` with a known `current_node` (for crash). The
  runtime can resume from the last-persisted point.
- **Declarative DSL.** Operators write YAML; the runtime compiles it into a
  graph. Adding a new "kind of step" means adding a node type, not rewriting
  the executor.
- **Fail-closed.** Unknown node kinds, missing successors, unresolved
  `inject_into`, and dispatcher exceptions all surface as typed terminal
  statuses. Nothing is silently swallowed.

### Negative

- **YAML is not typed at authoring time.** Authors lose TypeScript feedback in
  the `.cantbook` file itself. The parser (`packages/playbooks/src/parser.ts`)
  validates shape + cycle detection + ID uniqueness, so invalid flows fail
  fast — but only at parse time, not in the IDE.
- **Three node kinds is a ceiling until the next breaking change.** Adding
  a fourth kind (e.g. a dedicated `decide` branch node) requires a schema
  version bump. This is intentional: the current surface is small enough to
  keep the parser + runtime simple.
- **HITL secret management is now a deployment concern.** `CLEO_PLAYBOOK_SECRET`
  must be set in production or tokens are worthless. The dev fallback is a
  known string and must not be used outside local development.
- **The runtime does not implement branching.** A node with >1 successor is
  currently an error. Branching requires an explicit `decide` or `approval`
  node contract — deferred to a future ADR if the need becomes concrete.

### Neutral

- **Iteration cap default is 3.** Lower than the parser's maximum (10). Can
  be overridden per node or globally via `maxIterationsDefault`. The cap
  exists because infinite retry is never the right behaviour in an
  LLM-driven flow.

## Alternatives Considered

### (a) XState library

A mature JS state-machine library with hierarchical states, guards, actions,
and visualization tooling.

**Rejected because**:
- Opinionated at every layer — its event/action/context model would leak into
  CLEO's spawn contract.
- Heavy. ~20 KB minified plus its own type gymnastics. The full XState feature
  set (parallel states, history, actor model) is unused by the playbook DSL.
- Its "state machine" abstraction conflates DSL authoring and runtime
  concerns. CLEO already has a DSL (`.cantbook`); XState wants to be the DSL.
- Dependency injection would require fighting the `invoke` / `services`
  pattern.

### (b) LangGraph-style procedural orchestration

Author flows as TypeScript code with explicit node functions and edges.
Popular in recent agentic frameworks.

**Rejected because**:
- Flows are code, not data. `.cantbook` YAML lets non-programmers edit
  playbooks and lets the runtime validate them statically.
- No declarative persistence model. Every framework that ships this pattern
  bolts on its own `checkpoint` primitive, which is exactly what
  `playbook_runs` is — but scoped to CLEO semantics.
- Harder to audit. Code is harder to diff than a YAML edge list, and harder
  for a reviewer to reason about than a declared graph.

### (c) Temporal.io workflow engine

External service with durable execution, history replay, timers, signals.

**Rejected because**:
- Requires running a separate service. CLEO is a CLI + local SQLite; adding a
  distributed workflow engine is a violation of the "no daemons" design
  constraint.
- Worker registration, signal semantics, and SDK versioning dominate the
  integration cost.
- The feature it offers that would matter (durable replay on arbitrary
  process death) is already provided by `playbook_runs` + atomic SQLite
  updates. The trade-off is worse crash granularity — the runtime resumes
  from the last completed node, not mid-node — but for an LLM-driven flow
  that's indistinguishable from a fresh dispatch.

### (d) Ad-hoc procedural code

A big `switch (node.type)` inside a loop, dispatching to hard-coded provider
calls. What existed before T930.

**Rejected because**: fails every one of the four non-negotiable properties.
No HITL audit trail, no resume, no provider neutrality, no test story.

## References

- T930 — Playbook Runtime State Machine (commit `f3dcceb02`)
- T910 — Orchestration Coherence v4 epic
- T889 — Orchestration Coherence v3 Foundation (parser + state + policy +
  approval; the runtime's prerequisites)
- `packages/playbooks/src/runtime.ts` — state-machine executor
- `packages/playbooks/src/approval.ts` — HMAC-SHA256 resume tokens
- `packages/playbooks/src/policy.ts` — auto-approve vs require-human policy
- `packages/playbooks/src/schema.ts` — Drizzle table definitions
- `packages/playbooks/starter/` — three reference playbooks (rcasd, ivtr,
  release)
- `packages/contracts/src/playbook.ts` — public DSL + run + approval types
- [ADR-052](ADR-052-sdk-consolidation.md) — SDK consolidation (Vercel AI SDK)
- ADR-051 — Programmatic Gate Integrity (evidence-based verify)
- ADR-049 — Harness sovereignty
- [Orchestration Flow](../architecture/orchestration-flow.md) — 6-layer
  architectural overview
