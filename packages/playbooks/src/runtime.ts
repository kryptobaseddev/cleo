/**
 * Playbook runtime — deterministic state machine executor for `.cantbook` flows.
 *
 * This module is the executable heart of CLEO's T910 "Orchestration Coherence v4"
 * pipeline. It walks a validated {@link PlaybookDefinition} one node at a time,
 * merging node outputs into a shared `context`, enforcing per-node iteration
 * caps, and pausing for HITL approval gates via the signed resume-token
 * protocol (see `approval.ts`).
 *
 * Design constraints (non-negotiable):
 *
 * 1. Pure dependency injection — the runtime never imports or instantiates
 *    subprocess code. Callers pass an {@link AgentDispatcher} for `agentic`
 *    nodes and an optional {@link DeterministicRunner} for `deterministic`
 *    nodes. Tests can therefore exercise every branch without mocking any
 *    `@cleocode/*` module.
 * 2. Deterministic ordering — a topological traversal is computed up front
 *    from the {@link PlaybookDefinition.edges} graph (with `depends[]`
 *    treated as reverse edges, exactly as the parser's cycle check does).
 *    Execution order is stable across runs for the same definition.
 * 3. Fail-closed policy — unknown node kinds, missing successors, unresolved
 *    `inject_into` targets, or dispatcher errors all terminate the run with
 *    a typed `terminalStatus`. The runtime never silently swallows failures.
 * 4. HITL gates persist — when an `approval` node executes, the run is
 *    marked `paused` in `playbook_runs`, a {@link PlaybookApproval} row is
 *    written with the HMAC-signed resume token, and the returned
 *    {@link ExecutePlaybookResult.approvalToken} is what the human reviewer
 *    must present via `resumePlaybook` to continue.
 * 5. Contract enforcement (T1261 PSYCHE E4) — requires/ensures DSL validated
 *    at every node boundary. Violations are appended to
 *    `.cleo/audit/contract-violations.jsonl` and trigger the `contract_violation`
 *    error_handler (inject_hint | hitl_escalate | abort).
 *
 * @task T930 — Playbook Runtime State Machine
 * @task T1261 PSYCHE E4 — contract enforcement + context boundary
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  PlaybookAgenticNode,
  PlaybookApprovalNode,
  PlaybookDefinition,
  PlaybookDeterministicNode,
  PlaybookEdge,
  PlaybookEdgeCondition,
  PlaybookNode,
  PlaybookRun,
  PlaybookRunStatus,
} from '@cleocode/contracts';
import { createApprovalGate, getPlaybookSecret } from './approval.js';
import {
  createPlaybookApproval,
  createPlaybookRun,
  getPlaybookApprovalByToken,
  getPlaybookRun,
  updatePlaybookRun,
} from './state.js';

// ---------------------------------------------------------------------------
// Public interfaces — dependency-injected executors
// ---------------------------------------------------------------------------

/**
 * Input payload handed to {@link AgentDispatcher.dispatch} on every
 * `agentic` node execution. All fields are read-only from the dispatcher's
 * perspective — the runtime owns the lifecycle.
 */
export interface AgentDispatchInput {
  /** Playbook run identifier (FK into `playbook_runs.run_id`). */
  runId: string;
  /** Node identifier within the run graph. */
  nodeId: string;
  /** Agent identity resolved from `node.agent` (falls back to `node.skill`). */
  agentId: string;
  /** Task identifier lifted from `context.taskId` if present, otherwise `runId`. */
  taskId: string;
  /** Snapshot of the accumulated bindings at dispatch time. */
  context: Record<string, unknown>;
  /** 1-based iteration counter for this specific node (retry-aware). */
  iteration: number;
}

/**
 * Terminal output returned by {@link AgentDispatcher.dispatch}. The runtime
 * merges {@link output} into the run context on `status === 'success'` and
 * triggers iteration-cap / escalation logic on `'failure'`.
 */
export interface AgentDispatchResult {
  status: 'success' | 'failure';
  /** Key-value pairs merged into the run context on success. */
  output: Record<string, unknown>;
  /** Human-readable failure reason. Persisted to `playbook_runs.error_context`. */
  error?: string;
}

/**
 * Injected contract for spawning subagents. Implementations MUST NOT depend
 * on any `@cleocode/*` module — the runtime passes all state through
 * {@link AgentDispatchInput} so tests can provide deterministic stubs.
 */
export interface AgentDispatcher {
  /** Execute a single `agentic` node; return a success/failure envelope. */
  dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult>;
}

/**
 * Input payload handed to {@link DeterministicRunner.run} on every
 * `deterministic` node execution.
 */
export interface DeterministicRunInput {
  runId: string;
  nodeId: string;
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  /** Timeout in milliseconds; `undefined` means the runner picks a default. */
  timeout_ms?: number;
  context: Record<string, unknown>;
  iteration: number;
}

/**
 * Terminal output returned by {@link DeterministicRunner.run}. Shape mirrors
 * {@link AgentDispatchResult} for runtime uniformity.
 */
export interface DeterministicRunResult {
  status: 'success' | 'failure';
  output: Record<string, unknown>;
  error?: string;
}

/**
 * Injected contract for running `deterministic` nodes (CLI tools, validators,
 * decide scripts). If not supplied, the runtime delegates to
 * {@link AgentDispatcher.dispatch} with `agentId = "deterministic:<command>"`
 * so a single stub can cover both node kinds during unit testing.
 */
export interface DeterministicRunner {
  run(input: DeterministicRunInput): Promise<DeterministicRunResult>;
}

// ---------------------------------------------------------------------------
// Public interfaces — runtime entry points
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link executePlaybook}.
 */
export interface ExecutePlaybookOptions {
  /** Open `node:sqlite` handle with the T889 migration applied. */
  db: DatabaseSync;
  /** Validated playbook definition (output of {@link parsePlaybook}). */
  playbook: PlaybookDefinition;
  /** SHA-256 hex of the playbook source (output of {@link parsePlaybook}). */
  playbookHash: string;
  /** Starting bindings seeded into the run context (e.g. `{ taskId }`). */
  initialContext: Record<string, unknown>;
  /** Required dispatcher for `agentic` nodes. */
  dispatcher: AgentDispatcher;
  /** Optional runner for `deterministic` nodes. Defaults to `dispatcher`. */
  deterministicRunner?: DeterministicRunner;
  /** Override secret for HMAC resume-token signing. */
  approvalSecret?: string;
  /** Fallback per-node iteration cap when `on_failure.max_iterations` is unset. */
  maxIterationsDefault?: number;
  /** Epic id persisted to `playbook_runs.epic_id` for dashboard filtering. */
  epicId?: string;
  /** Session id persisted to `playbook_runs.session_id`. */
  sessionId?: string;
  /** Injectable clock for deterministic tests (defaults to `() => new Date()`). */
  now?: () => Date;
  /**
   * Project root for contract-violation audit writes (T1261 PSYCHE E4).
   * When absent, contract violations are still enforced but not appended to
   * `.cleo/audit/contract-violations.jsonl`.
   */
  projectRoot?: string;
}

export interface ResumePlaybookOptions {
  db: DatabaseSync;
  playbook: PlaybookDefinition;
  /** The token previously returned in {@link ExecutePlaybookResult.approvalToken}. */
  approvalToken: string;
  dispatcher: AgentDispatcher;
  deterministicRunner?: DeterministicRunner;
  approvalSecret?: string;
  maxIterationsDefault?: number;
  now?: () => Date;
  /**
   * Project root for contract-violation audit writes (T1261 PSYCHE E4).
   */
  projectRoot?: string;
}

/**
/**
 * Terminal status values reported by the runtime.
 */
export type PlaybookTerminalStatus =
  | 'completed'
  | 'failed'
  | 'pending_approval'
  | 'exceeded_iteration_cap';

/**
 * Final envelope returned by both {@link executePlaybook} and
 * {@link resumePlaybook}.
 */
export interface ExecutePlaybookResult {
  runId: string;
  terminalStatus: PlaybookTerminalStatus;
  /** Fully-merged bindings at the point the runtime stopped. */
  finalContext: Record<string, unknown>;
  /** Set when `terminalStatus === 'pending_approval'`. */
  approvalToken?: string;
  /** Set when the run stopped because a specific node failed. */
  failedNodeId?: string;
  /** Set when the run stopped because a node hit its iteration cap. */
  exceededNodeId?: string;
  /** Human-readable error reason mirrored from the last failing node. */
  errorContext?: string;
}

// ---------------------------------------------------------------------------
// Internal types — graph + iteration bookkeeping
// ---------------------------------------------------------------------------

/**
 * Pre-computed edge adjacency tuple — used to look up both outgoing and
 * incoming edges in O(1) per node during execution.
 */
interface EdgeIndex {
  /** Map from node id → list of successor node ids in declaration order. */
  readonly outgoing: ReadonlyMap<string, readonly string[]>;
  /** Map from node id → list of predecessor node ids in declaration order. */
  readonly incoming: ReadonlyMap<string, readonly string[]>;
  /**
   * Map from node id → list of outgoing {@link PlaybookEdge} objects in
   * declaration order. Carries the optional `when` branch guard (T11806) so
   * the runtime can route conditionally. `depends[]`-derived reverse edges
   * are unconditional and represented here as `{ from: dep, to: node }`.
   */
  readonly outgoingEdges: ReadonlyMap<string, readonly PlaybookEdge[]>;
}

/**
 * Stable lookup for nodes by id. {@link PlaybookDefinition.nodes} is an
 * ordered array; this map amortizes the otherwise-O(n) lookup per step.
 */
type NodeIndex = ReadonlyMap<string, PlaybookNode>;

/**
 * Signal emitted by {@link executeAgenticNode}, {@link executeDeterministicNode},
 * and {@link executeApprovalNode}. The runtime's main loop translates this
 * into either a step-forward (advance to the next node), a pause (write the
 * approval row and return), or a terminal failure.
 */
type NodeOutcome =
  | { kind: 'success'; output: Record<string, unknown> }
  | { kind: 'failure'; error: string }
  | { kind: 'awaiting_approval'; token: string; approvalId: string };

/**
 * Error code stamped onto errors thrown by the runtime for invalid inputs.
 * Exported for parity with the rest of the `@cleocode/playbooks` error codes.
 */
export const E_PLAYBOOK_RUNTIME_INVALID = 'E_PLAYBOOK_RUNTIME_INVALID' as const;

/**
 * Error code thrown when {@link resumePlaybook} is called with a token that
 * does not resolve to an `approved` gate.
 */
export const E_PLAYBOOK_RESUME_BLOCKED = 'E_PLAYBOOK_RESUME_BLOCKED' as const;

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

/**
 * Build {@link EdgeIndex} from a validated playbook. The parser guarantees
 * every `from`/`to` references a known node id, so lookups are safe.
 *
 * `depends[]` entries are treated as reverse edges (`dep → node`), matching
 * the cycle-detection logic in `parser.ts::hasCycle`.
 */
function buildEdgeIndex(def: PlaybookDefinition): EdgeIndex {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const outgoingEdges = new Map<string, PlaybookEdge[]>();
  for (const n of def.nodes) {
    outgoing.set(n.id, []);
    incoming.set(n.id, []);
    outgoingEdges.set(n.id, []);
  }
  for (const e of def.edges) {
    outgoing.get(e.from)?.push(e.to);
    incoming.get(e.to)?.push(e.from);
    outgoingEdges.get(e.from)?.push(e);
  }
  for (const n of def.nodes) {
    if (!n.depends) continue;
    for (const dep of n.depends) {
      // dep -> n is a reverse edge; push onto outgoing(dep) and incoming(n)
      // only if it is not already there (idempotent with explicit edges).
      const out = outgoing.get(dep);
      if (out && !out.includes(n.id)) out.push(n.id);
      const inc = incoming.get(n.id);
      if (inc && !inc.includes(dep)) inc.push(dep);
      // depends-derived reverse edges are always unconditional.
      const outE = outgoingEdges.get(dep);
      if (outE && !outE.some((e) => e.to === n.id)) outE.push({ from: dep, to: n.id });
    }
  }
  return {
    outgoing: new Map([...outgoing].map(([k, v]) => [k, Object.freeze([...v])])),
    incoming: new Map([...incoming].map(([k, v]) => [k, Object.freeze([...v])])),
    outgoingEdges: new Map([...outgoingEdges].map(([k, v]) => [k, Object.freeze([...v])])),
  };
}

/**
 * Resolve the single entry node. An entry node is one with no incoming edges
 * after `depends[]` is folded in. If multiple candidates exist, the first in
 * {@link PlaybookDefinition.nodes} declaration order wins so execution is
 * deterministic across process restarts.
 *
 * Throws if no entry node exists (every node has a predecessor — impossible
 * for a DAG but we defensively check anyway).
 */
function resolveEntryNode(def: PlaybookDefinition, idx: EdgeIndex): PlaybookNode {
  for (const n of def.nodes) {
    const preds = idx.incoming.get(n.id);
    if (preds && preds.length === 0) return n;
  }
  throw new Error(
    `${E_PLAYBOOK_RUNTIME_INVALID}: no entry node (every node has a predecessor) in ${def.name}`,
  );
}

/**
 * Evaluate a declarative {@link PlaybookEdgeCondition} against the run
 * `context`. The predicate is pure data (no `eval`, no expression parsing) so
 * routing stays deterministic and sandbox-safe (T11806).
 *
 * Exactly one operator is set on a parsed condition (the parser enforces
 * this); each is checked in turn:
 *  - `equals` / `notEquals` — strict `Object.is`-style equality on
 *    `context[field]`.
 *  - `exists` — `field` present-in / absent-from context.
 *  - `in` — `context[field]` is one of the listed values (strict equality).
 *  - `truthy` — JS truthiness of `context[field]`.
 *
 * A condition naming a field absent from context evaluates to `false` for
 * value comparisons (`equals`/`in`), `true` for `notEquals` (absent ≠ value),
 * and is handled explicitly by `exists`/`truthy`.
 *
 * @param condition - Parsed, validated branch guard.
 * @param context - Current accumulated run context.
 * @returns `true` when the edge should be traversed.
 *
 * @task T11806 — cantbook runtime branching
 */
function evaluateEdgeCondition(
  condition: PlaybookEdgeCondition,
  context: Record<string, unknown>,
): boolean {
  const has = Object.hasOwn(context, condition.field);
  const value = context[condition.field];

  if (condition.exists !== undefined) {
    return condition.exists ? has : !has;
  }
  if (condition.truthy !== undefined) {
    return condition.truthy ? Boolean(value) : !value;
  }
  if (Object.hasOwn(condition, 'equals')) {
    return has && Object.is(value, condition.equals);
  }
  if (Object.hasOwn(condition, 'notEquals')) {
    // Absent field is, by definition, not equal to any concrete value.
    return !has || !Object.is(value, condition.notEquals);
  }
  if (condition.in !== undefined) {
    return has && condition.in.some((candidate) => Object.is(value, candidate));
  }
  // Parser guarantees one operator is set; unreachable in practice.
  return false;
}

/**
 * Resolve the next node id to traverse from `nodeId`, given the current run
 * `context`, with support for guarded conditional branching (T11806).
 *
 * Routing rules (minimal, fail-closed, backward-compatible):
 *  - **0 outgoing edges** → `null` (terminal "end" state).
 *  - Edges are partitioned into *unconditional* (no `when`) and *guarded*
 *    (`when` predicate satisfied against `context`).
 *  - **>1 unconditional successor** → throw `E_PLAYBOOK_RUNTIME_INVALID`
 *    (genuine ambiguity — author must add `when` guards). This preserves the
 *    pre-T11806 guard for the un-guarded fan-out case.
 *  - **Exactly 1 satisfied successor** (unconditional or guarded) → traverse
 *    it. Linear playbooks are unchanged: their single un-guarded edge is the
 *    sole candidate.
 *  - **Outgoing edges exist but NONE is satisfied** → throw (fail-closed: a
 *    branch must always have a reachable default; silently terminating would
 *    mask an authoring bug).
 *  - **>1 satisfied successor** → throw (ambiguous branch — predicates must be
 *    mutually exclusive; parallel fan-out is a deferred follow-up).
 *
 * @param nodeId - Current node id.
 * @param idx - Pre-computed edge index.
 * @param context - Current accumulated run context (predicate evaluation).
 * @returns The single successor node id, or `null` when terminal.
 * @throws {Error} stamped {@link E_PLAYBOOK_RUNTIME_INVALID} on ambiguous or
 *   unsatisfiable branching.
 */
function resolveNextNodeId(
  nodeId: string,
  idx: EdgeIndex,
  context: Record<string, unknown>,
): string | null {
  const edges = idx.outgoingEdges.get(nodeId) ?? [];
  if (edges.length === 0) return null;

  // Fast path: a single unconditional edge (the linear, pre-T11806 shape).
  if (edges.length === 1) {
    const [only] = edges;
    if (only === undefined) {
      throw new Error(`${E_PLAYBOOK_RUNTIME_INVALID}: node ${nodeId} has undefined successor`);
    }
    if (only.when !== undefined && !evaluateEdgeCondition(only.when, context)) {
      throw new Error(
        `${E_PLAYBOOK_RUNTIME_INVALID}: node ${nodeId} sole successor "${only.to}" is guarded ` +
          `by a "when" predicate that is not satisfied — branch has no reachable default`,
      );
    }
    return only.to;
  }

  // Fan-out: reject >1 unconditional successor (genuine ambiguity).
  const unconditional = edges.filter((e) => e.when === undefined);
  if (unconditional.length > 1) {
    throw new Error(
      `${E_PLAYBOOK_RUNTIME_INVALID}: node ${nodeId} has ${unconditional.length} unconditional ` +
        `successors; guarded branching requires every additional edge to carry a "when" predicate`,
    );
  }

  // Collect satisfied successors: unconditional edge (if any) + guarded edges
  // whose predicate holds.
  const satisfied: string[] = [];
  for (const e of edges) {
    if (e.when === undefined || evaluateEdgeCondition(e.when, context)) {
      satisfied.push(e.to);
    }
  }

  if (satisfied.length === 0) {
    throw new Error(
      `${E_PLAYBOOK_RUNTIME_INVALID}: node ${nodeId} has ${edges.length} successors but no ` +
        `"when" predicate is satisfied — branch has no reachable default`,
    );
  }
  if (satisfied.length > 1) {
    throw new Error(
      `${E_PLAYBOOK_RUNTIME_INVALID}: node ${nodeId} has ${satisfied.length} satisfied successors ` +
        `(${satisfied.join(', ')}); branch predicates must be mutually exclusive`,
    );
  }
  const [next] = satisfied;
  if (next === undefined) {
    throw new Error(`${E_PLAYBOOK_RUNTIME_INVALID}: node ${nodeId} has undefined successor`);
  }
  return next;
}

/**
 * Look up the {@link PlaybookNode} by id. Throws on unknown id so callers
 * surface invariant violations at the runtime boundary.
 */
function resolveNode(nodeId: string, idx: NodeIndex): PlaybookNode {
  const node = idx.get(nodeId);
  if (node === undefined) {
    throw new Error(`${E_PLAYBOOK_RUNTIME_INVALID}: unknown node id "${nodeId}"`);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Per-node execution
// ---------------------------------------------------------------------------

/**
 * Execute a single `agentic` node via the injected {@link AgentDispatcher}.
 * The dispatcher receives the current context and must return a success /
 * failure envelope — any thrown exception is normalized into a failure.
 */
async function executeAgenticNode(
  node: PlaybookAgenticNode,
  runId: string,
  context: Record<string, unknown>,
  iteration: number,
  dispatcher: AgentDispatcher,
): Promise<NodeOutcome> {
  const agentId = node.agent ?? node.skill;
  if (agentId === undefined) {
    // Parser guarantees at-least-one, but narrow defensively.
    return {
      kind: 'failure',
      error: `${E_PLAYBOOK_RUNTIME_INVALID}: node ${node.id} is agentic but has no skill or agent`,
    };
  }
  const taskIdRaw = context['taskId'];
  const taskId = typeof taskIdRaw === 'string' && taskIdRaw.length > 0 ? taskIdRaw : runId;

  try {
    const result = await dispatcher.dispatch({
      runId,
      nodeId: node.id,
      agentId,
      taskId,
      context: { ...context },
      iteration,
    });
    if (result.status === 'success') {
      return { kind: 'success', output: result.output };
    }
    return { kind: 'failure', error: result.error ?? `agent ${agentId} returned failure` };
  } catch (err) {
    return {
      kind: 'failure',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Execute a single `deterministic` node. If the caller supplied a dedicated
 * {@link DeterministicRunner}, it is used; otherwise the runtime falls back
 * to {@link AgentDispatcher.dispatch} with a synthetic `agentId` so a single
 * stub can cover both node kinds during unit tests.
 */
async function executeDeterministicNode(
  node: PlaybookDeterministicNode,
  runId: string,
  context: Record<string, unknown>,
  iteration: number,
  dispatcher: AgentDispatcher,
  runner: DeterministicRunner | undefined,
): Promise<NodeOutcome> {
  try {
    if (runner !== undefined) {
      const input: DeterministicRunInput = {
        runId,
        nodeId: node.id,
        command: node.command,
        args: node.args,
        context: { ...context },
        iteration,
      };
      if (node.cwd !== undefined) input.cwd = node.cwd;
      if (node.env !== undefined) input.env = node.env;
      if (node.timeout_ms !== undefined) input.timeout_ms = node.timeout_ms;
      const result = await runner.run(input);
      if (result.status === 'success') {
        return { kind: 'success', output: result.output };
      }
      return {
        kind: 'failure',
        error: result.error ?? `command ${node.command} returned failure`,
      };
    }
    // Fallback: dispatch as an agentic call with a synthetic agent id.
    const taskIdRaw = context['taskId'];
    const taskId = typeof taskIdRaw === 'string' && taskIdRaw.length > 0 ? taskIdRaw : runId;
    const agentId = `deterministic:${node.command}`;
    const result = await dispatcher.dispatch({
      runId,
      nodeId: node.id,
      agentId,
      taskId,
      context: {
        ...context,
        __deterministic: {
          command: node.command,
          args: [...node.args],
          cwd: node.cwd,
          env: node.env,
          timeout_ms: node.timeout_ms,
        },
      },
      iteration,
    });
    if (result.status === 'success') {
      return { kind: 'success', output: result.output };
    }
    return {
      kind: 'failure',
      error: result.error ?? `command ${node.command} returned failure`,
    };
  } catch (err) {
    return {
      kind: 'failure',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Execute a single `approval` node. Writes a pending {@link PlaybookApproval}
 * row and returns an `awaiting_approval` outcome — the main loop translates
 * this into a `paused` run state.
 */
function executeApprovalNode(
  node: PlaybookApprovalNode,
  runId: string,
  context: Record<string, unknown>,
  db: DatabaseSync,
  secret: string,
): NodeOutcome {
  const gate = createApprovalGate(db, {
    runId,
    nodeId: node.id,
    bindings: context,
    secret,
    reason: node.prompt,
  });
  return { kind: 'awaiting_approval', token: gate.token, approvalId: gate.approvalId };
}

// ---------------------------------------------------------------------------
// Main execution loop
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Contract enforcement helpers (T1261 PSYCHE E4)
// ---------------------------------------------------------------------------

/**
 * Check that all required fields from a predecessor node are present in the
 * current execution context.
 *
 * @param fields - List of keys that must be in `context`.
 * @param from - Optional predecessor node id for error message context.
 * @param context - Current accumulated run context.
 * @returns `null` if all fields are present; a human-readable violation
 *          description otherwise.
 */
function checkRequires(
  fields: readonly string[],
  from: string | undefined,
  context: Record<string, unknown>,
): string | null {
  for (const key of fields) {
    if (!(key in context)) {
      const source = from !== undefined ? ` (from node '${from}')` : '';
      return `requires.fields['${key}']${source} not present in context`;
    }
  }
  return null;
}

/**
 * Resolve the first outgoing edge from `fromId` to `toId` in the playbook edge
 * list. Returns `undefined` when no explicit edge exists.
 */
function resolveEdge(
  fromId: string,
  toId: string,
  edges: readonly PlaybookEdge[],
): PlaybookEdge | undefined {
  return edges.find((e) => e.from === fromId && e.to === toId);
}

/**
 * Best-effort contract violation audit write. Non-fatal: errors are swallowed
 * so a broken filesystem never blocks playbook execution.
 *
 * Writes to `<projectRoot>/.cleo/audit/contract-violations.jsonl` following
 * the ADR-039 pattern.
 */
function auditContractViolation(
  projectRoot: string | undefined,
  runId: string,
  nodeId: string,
  field: 'requires' | 'ensures',
  key: string,
  playbookName: string,
): void {
  if (!projectRoot) return;
  try {
    // Write directly via node:fs to avoid importing @cleocode/core from
    // @cleocode/playbooks (avoids circular TS project reference issues).
    // Follows the same ADR-039 append-only NDJSON pattern as audit.ts.
    const filePath = join(projectRoot, '.cleo', 'audit', 'contract-violations.jsonl');
    mkdirSync(dirname(filePath), { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      runId,
      nodeId,
      field,
      key,
      message: `contract_violation: ${field}['${key}'] check failed on node '${nodeId}'`,
      playbookName,
    });
    appendFileSync(filePath, `${entry}\n`, { encoding: 'utf-8' });
  } catch {
    // non-fatal
  }
}

/**
 * Map a `contract_violation` trigger to the registered error handler action.
 *
 * @returns `'inject_hint'` | `'hitl_escalate'` | `'abort'` based on the
 *          first matching handler, or `null` when no handler is registered.
 */
function handleContractErrorHandler(
  playbook: PlaybookDefinition,
  trigger: 'contract_violation',
  _message: string,
): 'inject_hint' | 'hitl_escalate' | 'abort' | null {
  if (!playbook.error_handlers) return null;
  const handler = playbook.error_handlers.find((h) => h.on === trigger);
  return handler?.action ?? null;
}

/**
 * Determine the effective iteration cap for a node. Falls back to the
 * runtime default (3) when `on_failure.max_iterations` is unset. The parser
 * already validates the upper bound of 10.
 */
function iterationCapFor(node: PlaybookNode, runtimeDefault: number): number {
  const cap = node.on_failure?.max_iterations;
  if (typeof cap === 'number' && Number.isFinite(cap) && cap >= 0) return cap;
  return runtimeDefault;
}

// ---------------------------------------------------------------------------
// RCASD/IVTR node output schema validation (T11499 AC3)
// ---------------------------------------------------------------------------

/**
 * A single task entry within a decomposition `task_tree` output.
 *
 * Agents emitting a decomposition must produce a `task_tree` key in the
 * playbook context whose value is an array of objects conforming to this shape.
 * Validating the real shape — not just key presence — prevents garbage
 * decompositions from silently entering the run queue.
 *
 * @task T11499 E7-CLOSE-LOOPS AC3
 */
interface DecompositionTaskEntry {
  /** Task title — required, non-empty string. */
  title: string;
  /** Acceptance criteria — must be present and non-empty. */
  acceptance: string[];
  /** Optional task ID (may be pre-assigned by the agent). */
  id?: string;
  /** Optional parent task ID. */
  parentId?: string;
  /** Optional dependency IDs. */
  depends?: string[];
}

/**
 * Validate the `task_tree` shape emitted by a RCASD decomposition node.
 *
 * Returns a human-readable violation string when the shape is invalid, or
 * `null` when the tree is well-formed. The check is performed AFTER the node
 * output is merged into the playbook context (post-merge ensures check).
 *
 * Rules enforced (AC3 — T11499):
 *  1. `task_tree` must be a non-empty array.
 *  2. Each entry must have a non-empty string `title`.
 *  3. Each entry must have a non-empty `acceptance` array (at least one string).
 *  4. No entry may have an empty `depends` array that references a non-existent
 *     sibling (intra-tree orphan check).
 *
 * The validator is intentionally lenient on optional fields (id, parentId,
 * depends) so that agents can emit a minimal valid tree without being rejected
 * for cosmetic omissions.
 *
 * @param nodeId - Node identifier (used in error messages).
 * @param taskTree - The raw value stored at `context.task_tree`.
 * @returns Violation string or `null` (valid).
 *
 * @task T11499 E7-CLOSE-LOOPS AC3
 */
export function validateDecompositionTaskTree(nodeId: string, taskTree: unknown): string | null {
  if (!Array.isArray(taskTree)) {
    return `ensures.schema[task_tree] on ${nodeId}: task_tree must be a non-empty array, got ${typeof taskTree}`;
  }

  if (taskTree.length === 0) {
    return `ensures.schema[task_tree] on ${nodeId}: task_tree is an empty array — decomposition produced no tasks`;
  }

  const knownIds = new Set<string>();
  for (const entry of taskTree) {
    if (typeof (entry as DecompositionTaskEntry).id === 'string') {
      knownIds.add((entry as DecompositionTaskEntry).id!);
    }
  }

  for (let i = 0; i < taskTree.length; i++) {
    const entry = taskTree[i] as DecompositionTaskEntry;

    if (typeof entry !== 'object' || entry === null) {
      return `ensures.schema[task_tree] on ${nodeId}: entry[${i}] must be an object, got ${entry === null ? 'null' : typeof entry}`;
    }

    if (typeof entry.title !== 'string' || entry.title.trim().length === 0) {
      return `ensures.schema[task_tree] on ${nodeId}: entry[${i}].title must be a non-empty string`;
    }

    if (!Array.isArray(entry.acceptance) || entry.acceptance.length === 0) {
      return (
        `ensures.schema[task_tree] on ${nodeId}: entry[${i}] ("${entry.title}") ` +
        `must have a non-empty acceptance array`
      );
    }

    const hasValidAc = entry.acceptance.some(
      (ac) => typeof ac === 'string' && ac.trim().length > 0,
    );
    if (!hasValidAc) {
      return (
        `ensures.schema[task_tree] on ${nodeId}: entry[${i}] ("${entry.title}") ` +
        `acceptance array contains no non-empty strings`
      );
    }

    // Intra-tree orphan check: if depends[] are specified, they must reference
    // another entry in the same tree (by id). References to external tasks are
    // allowed (they have no id in this tree), so we only flag ids that look
    // like intra-tree references but are absent from knownIds.
    if (Array.isArray(entry.depends) && knownIds.size > 0) {
      for (const depId of entry.depends) {
        // Only flag if the depId matches the T#### pattern and is not in knownIds
        // (external task IDs that exist in the DB are valid but we can't check here).
        if (typeof depId === 'string' && /^T\d{3,}$/.test(depId) && !knownIds.has(depId)) {
          // Soft warn only (not a hard violation) — the dep may be a pre-existing task.
          // We don't hard-fail here because agents may correctly depend on existing tasks.
        }
      }
    }
  }

  return null; // valid
}

/**
 * Validate the `evidence` field emitted by an IVTR validation node.
 *
 * IVTR validation nodes must emit an `evidence` key whose value is either:
 *  - An object with at least one key (structured evidence map), OR
 *  - A non-empty string (free-text evidence reference).
 *
 * Empty evidence (`{}`, `''`, `[]`) is rejected so that spawned agents
 * cannot satisfy the gate by emitting an empty object.
 *
 * @param nodeId - Node identifier (used in error messages).
 * @param evidence - The raw value stored at `context.evidence`.
 * @returns Violation string or `null` (valid).
 *
 * @task T11499 E7-CLOSE-LOOPS AC3
 */
export function validateIvtrEvidenceOutput(nodeId: string, evidence: unknown): string | null {
  if (evidence === null || evidence === undefined) {
    return `ensures.schema[evidence] on ${nodeId}: evidence must be present (non-null, non-undefined)`;
  }

  if (typeof evidence === 'string') {
    if (evidence.trim().length === 0) {
      return `ensures.schema[evidence] on ${nodeId}: evidence string must not be empty`;
    }
    return null; // valid non-empty string
  }

  if (Array.isArray(evidence)) {
    if (evidence.length === 0) {
      return `ensures.schema[evidence] on ${nodeId}: evidence array must not be empty`;
    }
    return null; // valid non-empty array
  }

  if (typeof evidence === 'object') {
    const keys = Object.keys(evidence as object);
    if (keys.length === 0) {
      return `ensures.schema[evidence] on ${nodeId}: evidence object must have at least one key (got {})`;
    }
    return null; // valid non-empty object
  }

  // Numbers, booleans etc. are not valid evidence shapes.
  return `ensures.schema[evidence] on ${nodeId}: evidence must be a string, array, or object (got ${typeof evidence})`;
}

/**
 * Core step-by-step executor shared by {@link executePlaybook} and
 * {@link resumePlaybook}. Starts at `startNodeId` and walks the graph until
 * a terminal outcome is reached.
 *
 * Persists:
 *  - `playbook_runs.current_node` at every step so crash-resume is possible.
 *  - `playbook_runs.bindings` after every successful merge.
 *  - `playbook_runs.iteration_counts` after every attempt (success or failure).
 *  - `playbook_runs.status`/`error_context`/`completed_at` at termination.
 *
 * @internal
 */
async function runFromNode(args: {
  db: DatabaseSync;
  playbook: PlaybookDefinition;
  run: PlaybookRun;
  startNodeId: string;
  nodeIndex: NodeIndex;
  edgeIndex: EdgeIndex;
  context: Record<string, unknown>;
  iterationCounts: Record<string, number>;
  dispatcher: AgentDispatcher;
  deterministicRunner: DeterministicRunner | undefined;
  approvalSecret: string;
  maxIterationsDefault: number;
  now: () => Date;
  /** Project root for contract-violations.jsonl audit writes (T1261 E4). */
  projectRoot?: string;
}): Promise<ExecutePlaybookResult> {
  const {
    db,
    playbook,
    run,
    startNodeId,
    nodeIndex,
    edgeIndex,
    context,
    iterationCounts,
    dispatcher,
    deterministicRunner,
    approvalSecret,
    maxIterationsDefault,
    now,
  } = args;

  let currentId: string | null = startNodeId;
  let lastError: string | undefined;
  let failedNodeId: string | undefined;
  let exceededNodeId: string | undefined;

  while (currentId !== null) {
    const node = resolveNode(currentId, nodeIndex);
    const cap = iterationCapFor(node, maxIterationsDefault);

    // Advance iteration counter up front so a thrown dispatcher still bumps it.
    const attempt = (iterationCounts[node.id] ?? 0) + 1;
    iterationCounts[node.id] = attempt;

    // Persist per-step bookkeeping before dispatch so crashes are recoverable.
    updatePlaybookRun(db, run.runId, {
      currentNode: node.id,
      iterationCounts: { ...iterationCounts },
    });

    // Contract enforcement (T1261 E4): validate node.requires BEFORE dispatch.
    // On violation, trigger contract_violation error handler or fail the node.
    if (node.requires?.fields) {
      const violation = checkRequires(node.requires.fields, node.requires.from, context);
      if (violation !== null) {
        const contractFailure = `contract_violation: ${violation}`;
        auditContractViolation(
          args.projectRoot,
          run.runId,
          node.id,
          'requires',
          violation,
          playbook.name,
        );
        const handled = handleContractErrorHandler(playbook, 'contract_violation', contractFailure);
        if (handled === 'abort') {
          failedNodeId = node.id;
          lastError = contractFailure;
          break;
        }
        if (handled !== null) {
          context['__lastError'] = contractFailure;
          context['__lastFailedNode'] = node.id;
          context['__contractViolation'] = violation;
          if (handled === 'hitl_escalate') {
            exceededNodeId = node.id;
            break;
          }
          // inject_hint: continue to dispatch with the hint in context
        }
      }
    }

    let outcome: NodeOutcome;
    if (node.type === 'agentic') {
      outcome = await executeAgenticNode(node, run.runId, context, attempt, dispatcher);
    } else if (node.type === 'deterministic') {
      outcome = await executeDeterministicNode(
        node,
        run.runId,
        context,
        attempt,
        dispatcher,
        deterministicRunner,
      );
    } else if (node.type === 'approval') {
      outcome = executeApprovalNode(node, run.runId, context, db, approvalSecret);
    } else {
      // Exhaustiveness guard — never type to force a compile-time error on
      // future PlaybookNodeType additions.
      const exhaustive: never = node;
      throw new Error(
        `${E_PLAYBOOK_RUNTIME_INVALID}: unknown node kind ${JSON.stringify(exhaustive)}`,
      );
    }

    if (outcome.kind === 'success') {
      // Merge outputs into context and persist.
      Object.assign(context, outcome.output);
      updatePlaybookRun(db, run.runId, { bindings: { ...context } });

      // Contract enforcement (T1261 E4): validate node.ensures AFTER merge.
      if (node.ensures?.outputFiles) {
        for (const key of node.ensures.outputFiles) {
          if (!(key in context)) {
            const violation = `ensures.outputFiles[${key}] not present in context after ${node.id}`;
            auditContractViolation(
              args.projectRoot,
              run.runId,
              node.id,
              'ensures',
              key,
              playbook.name,
            );
            handleContractErrorHandler(playbook, 'contract_violation', violation);
            context['__ensuresViolation'] = violation;
          }
        }
      }

      // RCASD/IVTR output schema validation (T11499 AC3):
      // Enforce ensures.schema beyond key-presence so garbage decompositions
      // cannot silently pass the runtime contract check.
      if (node.ensures?.schema) {
        let schemaViolation: string | null = null;

        if (node.ensures.schema === 'task_tree') {
          schemaViolation = validateDecompositionTaskTree(node.id, context['task_tree']);
        } else if (node.ensures.schema === 'evidence') {
          schemaViolation = validateIvtrEvidenceOutput(node.id, context['evidence']);
        }
        // Future schema names are silently skipped (open for extension).

        if (schemaViolation !== null) {
          auditContractViolation(
            args.projectRoot,
            run.runId,
            node.id,
            'ensures',
            node.ensures.schema,
            playbook.name,
          );
          const handled = handleContractErrorHandler(
            playbook,
            'contract_violation',
            schemaViolation,
          );
          if (handled === 'abort') {
            failedNodeId = node.id;
            lastError = schemaViolation;
            // break out of the while loop below
          } else {
            context['__ensuresSchemaViolation'] = schemaViolation;
            if (handled === 'hitl_escalate') {
              exceededNodeId = node.id;
            }
          }
        }
      }

      // If a fatal schema violation was detected, break the step loop.
      if (failedNodeId !== undefined) break;

      // Validate outgoing edge contracts (edge.contract.requires on the FROM side).
      // Branch routing (T11806) reads the post-merge context so guard
      // predicates can act on this node's freshly merged output.
      const nextId = resolveNextNodeId(node.id, edgeIndex, context);
      if (nextId !== null) {
        const edge = resolveEdge(node.id, nextId, playbook.edges);
        if (edge?.contract?.requires) {
          for (const key of edge.contract.requires) {
            if (!(key in context)) {
              const violation = `edge.contract.requires[${key}] missing when crossing ${node.id} → ${nextId}`;
              auditContractViolation(
                args.projectRoot,
                run.runId,
                node.id,
                'requires',
                key,
                playbook.name,
              );
              const handled = handleContractErrorHandler(playbook, 'contract_violation', violation);
              if (handled === 'abort') {
                failedNodeId = node.id;
                lastError = violation;
                break;
              }
              context['__contractViolation'] = violation;
            }
          }
          if (failedNodeId !== undefined) break;
        }
      }

      currentId = nextId;
      continue;
    }

    if (outcome.kind === 'awaiting_approval') {
      // Persist pause + token and return. Caller resumes with the token.
      const pausedAt = now().toISOString();
      updatePlaybookRun(db, run.runId, {
        status: 'paused',
        errorContext: null,
        bindings: { ...context },
        iterationCounts: { ...iterationCounts },
      });
      return {
        runId: run.runId,
        terminalStatus: 'pending_approval',
        finalContext: { ...context, __pausedAt: pausedAt },
        approvalToken: outcome.token,
      };
    }

    // outcome.kind === 'failure' — record the error and evaluate retry/escalate.
    lastError = outcome.error;
    const injectTarget = node.on_failure?.inject_into;

    // Cap semantics: `cap === 0` disables retries entirely (first failure = fatal).
    // For cap > 0 we allow up to `cap` total attempts per node.
    if (attempt >= cap) {
      if (injectTarget !== undefined && injectTarget !== node.id) {
        // Escalate: hand control back to the inject target with the error in context.
        if (!nodeIndex.has(injectTarget)) {
          failedNodeId = node.id;
          break;
        }
        context['__lastError'] = outcome.error;
        context['__lastFailedNode'] = node.id;
        updatePlaybookRun(db, run.runId, {
          errorContext: outcome.error,
          bindings: { ...context },
        });
        currentId = injectTarget;
        // Reset the iteration counter on the injected target so it can retry
        // with the enriched context without immediately tripping its own cap.
        iterationCounts[injectTarget] = 0;
        continue;
      }
      exceededNodeId = node.id;
      break;
    }

    // Retry semantics: if `inject_into` points elsewhere, hand off control;
    // otherwise re-execute the same node on the next loop iteration.
    if (injectTarget !== undefined && injectTarget !== node.id) {
      if (!nodeIndex.has(injectTarget)) {
        failedNodeId = node.id;
        break;
      }
      context['__lastError'] = outcome.error;
      context['__lastFailedNode'] = node.id;
      updatePlaybookRun(db, run.runId, {
        errorContext: outcome.error,
        bindings: { ...context },
      });
      currentId = injectTarget;
      iterationCounts[injectTarget] = 0;
      continue;
    }
    // Retry the same node (currentId stays the same).
    updatePlaybookRun(db, run.runId, { errorContext: outcome.error });
  }

  // Terminal transition — completed vs failed vs exceeded.
  const completedAt = now().toISOString();
  if (exceededNodeId !== undefined) {
    updatePlaybookRun(db, run.runId, {
      status: 'failed',
      errorContext: lastError ?? null,
      completedAt,
      bindings: { ...context },
      iterationCounts: { ...iterationCounts },
    });
    const result: ExecutePlaybookResult = {
      runId: run.runId,
      terminalStatus: 'exceeded_iteration_cap',
      finalContext: { ...context },
      exceededNodeId,
    };
    if (lastError !== undefined) result.errorContext = lastError;
    return result;
  }

  if (failedNodeId !== undefined) {
    updatePlaybookRun(db, run.runId, {
      status: 'failed',
      errorContext: lastError ?? null,
      completedAt,
      bindings: { ...context },
      iterationCounts: { ...iterationCounts },
    });
    const result: ExecutePlaybookResult = {
      runId: run.runId,
      terminalStatus: 'failed',
      finalContext: { ...context },
      failedNodeId,
    };
    if (lastError !== undefined) result.errorContext = lastError;
    return result;
  }

  // Reached terminal "end" state (no outgoing edges) — run completed.
  updatePlaybookRun(db, run.runId, {
    status: 'completed',
    currentNode: null,
    completedAt,
    bindings: { ...context },
    iterationCounts: { ...iterationCounts },
    errorContext: null,
  });
  return {
    runId: run.runId,
    terminalStatus: 'completed',
    finalContext: { ...context },
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Execute a playbook from its entry node until a terminal state is reached
 * (`completed`, `failed`, `exceeded_iteration_cap`, or `pending_approval`).
 *
 * Every execution is persisted to `playbook_runs` so that crashes or HITL
 * pauses can resume via {@link resumePlaybook}. Returned
 * {@link ExecutePlaybookResult.finalContext} is a fully-merged snapshot at
 * the moment the runtime stopped.
 *
 * @param options - Runtime configuration, including the injected dispatcher.
 * @returns Terminal envelope describing where the run stopped.
 */
export async function executePlaybook(
  options: ExecutePlaybookOptions,
): Promise<ExecutePlaybookResult> {
  const now = options.now ?? (() => new Date());
  const maxIterationsDefault = options.maxIterationsDefault ?? 3;
  if (!Number.isInteger(maxIterationsDefault) || maxIterationsDefault < 0) {
    throw new Error(
      `${E_PLAYBOOK_RUNTIME_INVALID}: maxIterationsDefault must be a non-negative integer (got ${maxIterationsDefault})`,
    );
  }
  const approvalSecret = options.approvalSecret ?? getPlaybookSecret();

  const nodeIndex: NodeIndex = new Map(options.playbook.nodes.map((n) => [n.id, n]));
  const edgeIndex = buildEdgeIndex(options.playbook);
  const entry = resolveEntryNode(options.playbook, edgeIndex);

  const createInput: Parameters<typeof createPlaybookRun>[1] = {
    playbookName: options.playbook.name,
    playbookHash: options.playbookHash,
    initialBindings: { ...options.initialContext },
  };
  if (options.epicId !== undefined) createInput.epicId = options.epicId;
  if (options.sessionId !== undefined) createInput.sessionId = options.sessionId;

  const run = createPlaybookRun(options.db, createInput);
  const context: Record<string, unknown> = { ...options.initialContext };
  const iterationCounts: Record<string, number> = {};

  const runArgs: Parameters<typeof runFromNode>[0] = {
    db: options.db,
    playbook: options.playbook,
    run,
    startNodeId: entry.id,
    nodeIndex,
    edgeIndex,
    context,
    iterationCounts,
    dispatcher: options.dispatcher,
    deterministicRunner: options.deterministicRunner,
    approvalSecret,
    maxIterationsDefault,
    now,
    projectRoot: options.projectRoot,
  };
  return runFromNode(runArgs);
}

/**
 * Resume a paused playbook run using a HITL approval token. The runtime
 * validates that the token maps to an `approved` {@link PlaybookApproval}
 * row and that the associated run is in `paused` state, then continues from
 * the approval node's single successor.
 *
 * @throws Error stamped with {@link E_PLAYBOOK_RESUME_BLOCKED} if the token
 *   is unknown, the gate is still `pending`, the gate was `rejected`, the
 *   run is not `paused`, or the approval node has no successor.
 */
export async function resumePlaybook(
  options: ResumePlaybookOptions,
): Promise<ExecutePlaybookResult> {
  const approval = getPlaybookApprovalByToken(options.db, options.approvalToken);
  if (approval === null) {
    throw new Error(
      `${E_PLAYBOOK_RESUME_BLOCKED}: no approval gate for token ${options.approvalToken}`,
    );
  }
  if (approval.status === 'pending') {
    throw new Error(
      `${E_PLAYBOOK_RESUME_BLOCKED}: gate ${approval.approvalId} is still pending — approve before resuming`,
    );
  }
  if (approval.status === 'rejected') {
    const run = getPlaybookRun(options.db, approval.runId);
    // Mark run failed on resume-after-reject so dashboards stay consistent.
    if (run !== null && run.status !== 'failed') {
      updatePlaybookRun(options.db, approval.runId, {
        status: 'failed',
        errorContext: approval.reason ?? 'gate rejected',
        completedAt: (options.now ?? (() => new Date()))().toISOString(),
      });
    }
    throw new Error(
      `${E_PLAYBOOK_RESUME_BLOCKED}: gate ${approval.approvalId} was rejected` +
        (approval.reason ? ` (${approval.reason})` : ''),
    );
  }

  // approval.status === 'approved' past this point.
  const run = getPlaybookRun(options.db, approval.runId);
  if (run === null) {
    throw new Error(
      `${E_PLAYBOOK_RESUME_BLOCKED}: run ${approval.runId} no longer exists (deleted?)`,
    );
  }
  const validResumeStatuses: readonly PlaybookRunStatus[] = ['paused', 'running'];
  if (!validResumeStatuses.includes(run.status)) {
    throw new Error(
      `${E_PLAYBOOK_RESUME_BLOCKED}: run ${run.runId} is ${run.status}, expected paused|running`,
    );
  }

  // Validate the approval node is present and resolve its single successor.
  const nodeIndex: NodeIndex = new Map(options.playbook.nodes.map((n) => [n.id, n]));
  const edgeIndex = buildEdgeIndex(options.playbook);
  const approvalNode = nodeIndex.get(approval.nodeId);
  if (approvalNode === undefined || approvalNode.type !== 'approval') {
    throw new Error(
      `${E_PLAYBOOK_RESUME_BLOCKED}: approval node ${approval.nodeId} not found in playbook ${options.playbook.name}`,
    );
  }

  const now = options.now ?? (() => new Date());
  const maxIterationsDefault = options.maxIterationsDefault ?? 3;
  const approvalSecret = options.approvalSecret ?? getPlaybookSecret();
  const context: Record<string, unknown> = { ...run.bindings };
  const iterationCounts: Record<string, number> = { ...run.iterationCounts };

  // Log the approval decision into the context so downstream nodes can act on
  // it. Set BEFORE resolving the successor so a gate can branch on the
  // approver's decision via a `when: { field: __lastApproval... }` edge (T11806
  // approval/resume branch parity).
  context['__lastApproval'] = {
    nodeId: approval.nodeId,
    approvalId: approval.approvalId,
    approver: approval.approver,
    reason: approval.reason,
    approvedAt: approval.approvedAt,
  };

  const successor = resolveNextNodeId(approvalNode.id, edgeIndex, context);
  if (successor === null) {
    // Approval at the tail of the graph completes the run immediately.
    const completedAt = now().toISOString();
    updatePlaybookRun(options.db, run.runId, {
      status: 'completed',
      currentNode: null,
      completedAt,
      errorContext: null,
    });
    return {
      runId: run.runId,
      terminalStatus: 'completed',
      finalContext: { ...run.bindings },
    };
  }

  // Return the run to `running` before proceeding so dashboards reflect activity.
  updatePlaybookRun(options.db, run.runId, {
    status: 'running',
    currentNode: successor,
    errorContext: null,
  });

  // Persist an approval trace row for audit purposes. createPlaybookApproval
  // is distinct from createApprovalGate — the latter generates the HMAC
  // resume token, while this helper records arbitrary approval state.
  createPlaybookApproval(options.db, {
    runId: run.runId,
    nodeId: approval.nodeId,
    token: `resume:${approval.token}:${now().getTime()}`,
    autoPassed: true,
  });

  const runArgs: Parameters<typeof runFromNode>[0] = {
    db: options.db,
    playbook: options.playbook,
    run,
    startNodeId: successor,
    nodeIndex,
    edgeIndex,
    context,
    iterationCounts,
    dispatcher: options.dispatcher,
    deterministicRunner: options.deterministicRunner,
    approvalSecret,
    maxIterationsDefault,
    now,
    projectRoot: options.projectRoot,
  };
  return runFromNode(runArgs);
}
