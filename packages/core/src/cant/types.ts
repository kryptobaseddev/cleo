/**
 * Runtime types for the CANT DSL workflow executor.
 *
 * These types are used by the TypeScript workflow execution layer to
 * represent execution results, step outcomes, discretion evaluation
 * contexts, and approval tokens.
 *
 * @see docs/specs/CANT-DSL-SPEC.md Section 7 (Runtime) and Section 8 (Approval Tokens)
 */

// ---------------------------------------------------------------------------
// Execution Results
// ---------------------------------------------------------------------------

/** The aggregate result of executing a CANT workflow. */
export interface ExecutionResult {
  /** Whether the workflow completed without errors. */
  success: boolean;
  /** Output bindings from `output name = expr` statements. */
  outputs: Record<string, unknown>;
  /** Results for each executed step in order. */
  steps: StepResult[];
  /** Total wall-clock execution duration in milliseconds. */
  duration: number;
}

/** The result of a single workflow statement execution. */
export interface StepResult {
  /** The step or statement name. */
  name: string;
  /** The type of statement that was executed. */
  type: 'session' | 'pipeline' | 'parallel' | 'conditional' | 'loop' | 'approval' | 'binding' | 'directive' | 'output';
  /** Whether this step completed successfully. */
  success: boolean;
  /** The output value produced by this step, if any. */
  output?: unknown;
  /** Error message if the step failed. */
  error?: string;
  /** Wall-clock execution duration in milliseconds. */
  duration: number;
}

// ---------------------------------------------------------------------------
// Discretion Evaluation
// ---------------------------------------------------------------------------

/** Context provided to a discretion evaluator for AI-judged conditions. */
export interface DiscretionContext {
  /** The current session identifier. */
  sessionId: string;
  /** Task references currently in scope. */
  taskRefs: string[];
  /** The agent performing the evaluation. */
  agentId: string;
  /** All variables in the current workflow scope. */
  variables: Record<string, unknown>;
  /** The raw discretion condition text (between `**` delimiters). */
  condition: string;
  /** Output from preceding pipeline steps or session results. */
  precedingResults: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Approval Tokens (Section 8 of CANT-DSL-SPEC.md)
// ---------------------------------------------------------------------------

/** Valid states for an approval token. */
export type ApprovalTokenStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/**
 * An approval token for human-in-the-loop workflow gates.
 *
 * Tokens are bound to a specific session and workflow. The `workflowHash`
 * provides TOCTOU protection: if the workflow is modified between token
 * creation and approval, the token is invalidated.
 *
 * Security invariants:
 * - Token values MUST NOT appear in audit logs, summaries, or error messages.
 * - `approvalTokensJson` is NEVER included in handoff/debrief serialization.
 * - Status transitions use atomic CAS (pending -> approved|rejected|expired only).
 */
export interface ApprovalToken {
  /** UUID v4 generated via CSPRNG (crypto.randomUUID). */
  token: string;
  /** The session that generated this token. Token is bound to this session. */
  sessionId: string;
  /** The workflow that contains the approval gate. */
  workflowName: string;
  /** The name label of the specific approval gate. */
  gateName: string;
  /**
   * SHA-256 hash of the workflow definition text at the time the token was
   * created. Used for TOCTOU protection.
   */
  workflowHash: string;
  /** The message displayed to the approver. */
  message: string;
  /** ISO 8601 timestamp of token creation. */
  createdAt: string;
  /** ISO 8601 timestamp of token expiration. REQUIRED. Default 24h. */
  expiresAt: string;
  /** Current token state. */
  status: ApprovalTokenStatus;
  /** Identifier of the actor who approved/rejected (informational). */
  approvedBy?: string;
  /** ISO 8601 timestamp of the approval/rejection action. */
  approvedAt?: string;
  /** ISO 8601 timestamp of when the token was consumed by the runtime. */
  usedAt?: string;
  /** Identifier of the agent/workflow that requested approval. */
  requestedBy: string;
}

/** Result of validating an approval token. */
export interface TokenValidation {
  /** Whether the token is valid and can be consumed. */
  valid: boolean;
  /** If invalid, the reason for rejection. */
  reason?: 'not_found' | 'wrong_session' | 'not_pending' | 'expired' | 'hash_mismatch';
  /** The token object if found. */
  token?: ApprovalToken;
}

// ---------------------------------------------------------------------------
// Parallel Execution
// ---------------------------------------------------------------------------

/** Join strategy for parallel block execution. */
export type JoinStrategy = 'all' | 'race' | 'settle';

/** Result of a parallel block execution with the settle strategy. */
export interface SettleResult {
  /** Arms that completed successfully. */
  successes: Array<{ name: string; result: unknown }>;
  /** Arms that failed. */
  failures: Array<{ name: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Execution Scope
// ---------------------------------------------------------------------------

/** Variable scope for workflow execution. */
export interface ExecutionScope {
  /** Variable bindings in the current scope. */
  variables: Record<string, unknown>;
  /** Parent scope for nested blocks (parallel arms, loops, etc.). */
  parent?: ExecutionScope;
}
