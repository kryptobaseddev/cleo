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
 *
 * @task T930 — Playbook Runtime State Machine
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  PlaybookAgenticNode,
  PlaybookApprovalNode,
  PlaybookDefinition,
  PlaybookDeterministicNode,
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
}

/**
 * Options accepted by {@link resumePlaybook}. The runtime validates that the
 * supplied approval token resolves to an `approved` {@link PlaybookApproval}
 * row before continuing execution.
 */
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
}

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
  for (const n of def.nodes) {
    outgoing.set(n.id, []);
    incoming.set(n.id, []);
  }
  for (const e of def.edges) {
    outgoing.get(e.from)?.push(e.to);
    incoming.get(e.to)?.push(e.from);
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
    }
  }
  return {
    outgoing: new Map([...outgoing].map(([k, v]) => [k, Object.freeze([...v])])),
    incoming: new Map([...incoming].map(([k, v]) => [k, Object.freeze([...v])])),
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
 * Return the single successor node id for `nodeId`, or `null` if `nodeId` is
 * terminal (no outgoing edges — the "end" state in the design contract).
 *
 * Throws on fan-out (> 1 successor) because the deterministic runtime does
 * not support branching without an explicit `decide`-node contract. A
 * follow-up task can add guarded branching here — see README.
 */
function resolveNextNodeId(nodeId: string, idx: EdgeIndex): string | null {
  const outs = idx.outgoing.get(nodeId) ?? [];
  if (outs.length === 0) return null;
  if (outs.length > 1) {
    throw new Error(
      `${E_PLAYBOOK_RUNTIME_INVALID}: node ${nodeId} has ${outs.length} successors; branching requires an approval/decide node`,
    );
  }
  // Safe: length === 1
  const [next] = outs;
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
}): Promise<ExecutePlaybookResult> {
  const {
    db,
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
      currentId = resolveNextNodeId(node.id, edgeIndex);
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
  const successor = resolveNextNodeId(approvalNode.id, edgeIndex);
  if (successor === null) {
    // Approval at the tail of the graph completes the run immediately.
    const completedAt = (options.now ?? (() => new Date()))().toISOString();
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

  const now = options.now ?? (() => new Date());
  const maxIterationsDefault = options.maxIterationsDefault ?? 3;
  const approvalSecret = options.approvalSecret ?? getPlaybookSecret();
  const context: Record<string, unknown> = { ...run.bindings };
  const iterationCounts: Record<string, number> = { ...run.iterationCounts };

  // Log the approval decision into the context so downstream nodes can act on it.
  context['__lastApproval'] = {
    nodeId: approval.nodeId,
    approvalId: approval.approvalId,
    approver: approval.approver,
    reason: approval.reason,
    approvedAt: approval.approvedAt,
  };

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
  };
  return runFromNode(runArgs);
}
