/**
 * Playbook DSL types — shared between parser, runtime, and CLI.
 * Aligns with CLEO `.cantbook` YAML schema.
 *
 * @task T889 / T904 / W4-6
 * @task T1261 PSYCHE E4 — context_files thin-agent boundary, ContractViolationRecord
 */

export type PlaybookNodeType = 'agentic' | 'deterministic' | 'approval';
export type PlaybookRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type PlaybookApprovalStatus = 'pending' | 'approved' | 'rejected';
export type PlaybookPolicy = 'conservative' | 'permissive' | 'custom';

export interface PlaybookInput {
  name: string;
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface PlaybookEnsures {
  outputFiles?: string[];
  exitCode?: number;
  schema?: string;
}

export interface PlaybookRequires {
  from?: string;
  fields?: string[];
  schema?: string;
}

export interface PlaybookNodeOnFailure {
  inject_into?: string;
  max_iterations?: number;
  escalate?: boolean;
}

export interface PlaybookNodeBase {
  id: string;
  type: PlaybookNodeType;
  description?: string;
  depends?: string[];
  requires?: PlaybookRequires;
  ensures?: PlaybookEnsures;
  on_failure?: PlaybookNodeOnFailure;
}

export interface PlaybookAgenticNode extends PlaybookNodeBase {
  type: 'agentic';
  skill?: string;
  agent?: string;
  role?: 'orchestrator' | 'lead' | 'worker';
  inputs?: Record<string, string>;
  /**
   * Thin-agent context boundary — when present, the spawned agent is
   * restricted to only the listed file paths (relative to project root).
   * Enforced at spawn time by composeSpawnPayload (T1261 PSYCHE E4).
   */
  context_files?: string[];
}

export interface PlaybookDeterministicNode extends PlaybookNodeBase {
  type: 'deterministic';
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
}

export interface PlaybookApprovalNode extends PlaybookNodeBase {
  type: 'approval';
  prompt: string;
  policy?: PlaybookPolicy;
}

export type PlaybookNode = PlaybookAgenticNode | PlaybookDeterministicNode | PlaybookApprovalNode;

export interface PlaybookEdge {
  from: string;
  to: string;
  contract?: {
    requires?: string[];
    ensures?: string[];
  };
}

export interface PlaybookErrorHandler {
  on: 'agentic_timeout' | 'iteration_cap_exceeded' | 'contract_violation';
  action: 'inject_hint' | 'hitl_escalate' | 'abort';
  message?: string;
}

export interface PlaybookDefinition {
  version: string;
  name: string;
  description?: string;
  inputs?: PlaybookInput[];
  nodes: PlaybookNode[];
  edges: PlaybookEdge[];
  error_handlers?: PlaybookErrorHandler[];
}

export interface PlaybookRun {
  runId: string;
  playbookName: string;
  playbookHash: string;
  currentNode: string | null;
  bindings: Record<string, unknown>;
  errorContext: string | null;
  status: PlaybookRunStatus;
  iterationCounts: Record<string, number>;
  epicId?: string;
  sessionId?: string;
  startedAt: string;
  completedAt?: string;
}

export interface PlaybookApproval {
  approvalId: string;
  runId: string;
  nodeId: string;
  token: string;
  requestedAt: string;
  approvedAt?: string;
  approver?: string;
  reason?: string;
  status: PlaybookApprovalStatus;
  autoPassed: boolean;
}

/**
 * Audit record written to `.cleo/audit/contract-violations.jsonl` whenever
 * a playbook contract is violated at a node edge boundary.
 *
 * Conforms to the ADR-039 LAFS envelope pattern — each line is standalone
 * JSON that can be streamed without a wrapper array.
 *
 * @task T1261 PSYCHE E4
 */
export interface ContractViolationRecord {
  /** ISO-8601 UTC timestamp of the violation. */
  timestamp: string;
  /** Playbook run identifier from `playbook_runs.run_id`. */
  runId: string;
  /** Node id where the violation was detected. */
  nodeId: string;
  /** Edge field that violated the contract (`requires` or `ensures`). */
  field: 'requires' | 'ensures';
  /** Name of the missing or failed key. */
  key: string;
  /** Human-readable description of what was expected vs received. */
  message: string;
  /** Playbook name for human diagnostics. */
  playbookName: string;
}
