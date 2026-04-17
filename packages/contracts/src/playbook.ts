/**
 * Playbook DSL types — shared between parser, runtime, and CLI.
 * Aligns with CLEO `.cantbook` YAML schema.
 *
 * @task T889 / T904 / W4-6
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
