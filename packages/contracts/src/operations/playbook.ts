/**
 * Playbook Domain Operations — wire-format Params/Result types.
 *
 * This file provides the canonical wire-format types for the four playbook
 * operations exposed by the dispatch layer (`cleo playbook run|list|status|resume|validate`).
 *
 * ## Architecture note (ADR-057 D1 exception — T1456)
 *
 * The playbook runtime lives in `@cleocode/playbooks`, not `packages/core/src/`.
 * `executePlaybook` / `resumePlaybook` embed `db: DatabaseSync` as non-wire-serializable
 * runtime infrastructure, so the `(projectRoot, params: XParams)` Core normalization
 * pattern does **not** apply here. `@cleocode/playbooks` is the authoritative SSoT for
 * runtime function shapes; this file owns the wire-format (CLI/SDK) Params/Result types.
 *
 * Wire-format domain types (`PlaybookRun`, `PlaybookApproval`, `PlaybookRunStatus`, etc.)
 * are exported from `packages/contracts/src/playbook.ts` and re-used here.
 *
 * @task T1456 — playbook domain Core API alignment
 * @see ADR-057 D1 — uniform Core API normalization (exception documented above)
 * @see packages/contracts/src/playbook.ts — PlaybookRun, PlaybookApproval, PlaybookRunStatus
 * @see @cleocode/playbooks — ExecutePlaybookOptions, ResumePlaybookOptions (runtime SSoT)
 */

import type { PlaybookRun, PlaybookRunStatus } from '../playbook.js';

// ---------------------------------------------------------------------------
// playbook.status
// ---------------------------------------------------------------------------

/** Wire params for `cleo playbook status <runId>`. */
export interface PlaybookStatusParams {
  /** ID of the playbook run to inspect. */
  runId: string;
}

/** Wire result for `cleo playbook status`. */
export type PlaybookStatusResult = PlaybookRun;

// ---------------------------------------------------------------------------
// playbook.list
// ---------------------------------------------------------------------------

/** Wire params for `cleo playbook list`. */
export interface PlaybookListParams {
  /** Filter by run status. CLI-friendly aliases (`active` → `running`, `pending` → `paused`) are
   *  normalised by the dispatch handler before reaching Core. */
  status?: PlaybookRunStatus | 'active' | 'pending' | 'completed';
  /** Filter to runs launched for a specific epic. */
  epicId?: string;
  /** Maximum number of runs to return (default: all). */
  limit?: number;
  /** Offset into the full result list (applied client-side). */
  offset?: number;
}

/** Wire result for `cleo playbook list`. */
export interface PlaybookListResult {
  /** Ordered from newest to oldest; pagination applied client-side. */
  runs: PlaybookRun[];
  /** Number of runs in this page. */
  count: number;
  /** Total runs before pagination. */
  total: number;
  /** Effective status filter after alias normalisation. */
  statusFilter?: PlaybookRunStatus;
}

// ---------------------------------------------------------------------------
// playbook.validate
// ---------------------------------------------------------------------------

/** Wire params for `cleo playbook validate`. */
export interface PlaybookValidateParams {
  /** Absolute or relative path to a `.cantbook` file. Mutually exclusive with `name`. */
  file?: string;
  /** Playbook name resolved through the standard search path. Mutually exclusive with `file`. */
  name?: string;
}

/** Wire result for `cleo playbook validate`. */
export interface PlaybookValidateResult {
  valid: true;
  /** Resolved on-disk path. */
  sourcePath: string;
  /** SHA-256 hex hash of the source. */
  sourceHash: string;
  /** Playbook definition name from the YAML front-matter. */
  name: string;
  /** Playbook version string. */
  version: string;
  /** Total number of nodes in the playbook graph. */
  nodeCount: number;
  /** Total number of edges in the playbook graph. */
  edgeCount: number;
  /** Whether any node declares `requires:` pre-conditions. */
  hasRequires: boolean;
  /** Whether any node declares `ensures:` post-conditions. */
  hasEnsures: boolean;
  /** Whether the playbook defines top-level `error_handlers`. */
  hasErrorHandlers: boolean;
}

// ---------------------------------------------------------------------------
// playbook.run
// ---------------------------------------------------------------------------

/** Wire params for `cleo playbook run <name>`. */
export interface PlaybookRunParams {
  /** Name of the `.cantbook` playbook to execute (resolved through the standard search path). */
  name: string;
  /**
   * Initial context object injected into the playbook execution environment.
   * Accepts either a parsed object or a JSON-serialised string; the dispatch
   * handler normalises to an object before invoking the runtime.
   */
  context?: Record<string, unknown> | string;
}

/** Wire result for `cleo playbook run`. */
export interface PlaybookRunResult {
  runId: string;
  terminalStatus: 'completed' | 'paused' | 'failed' | 'cancelled';
  finalContext: Record<string, unknown>;
  /** HMAC-signed resume token; present only when `terminalStatus === 'paused'`. */
  approvalToken?: string;
  /** ID of the node that failed; present only on `terminalStatus === 'failed'`. */
  failedNodeId?: string;
  /** ID of the node that exceeded its budget; present only on timeout. */
  exceededNodeId?: string;
  /** Human-readable error context; present only on failure. */
  errorContext?: string;
  /** Canonical name of the playbook that was run. */
  playbookName: string;
  /** Resolved on-disk source path. */
  playbookSource: string;
}

// ---------------------------------------------------------------------------
// playbook.resume
// ---------------------------------------------------------------------------

/** Wire params for `cleo playbook resume <runId>`. */
export interface PlaybookResumeParams {
  /** ID of the paused playbook run to resume. */
  runId: string;
}

/** Wire result for `cleo playbook resume`. */
export interface PlaybookResumeResult {
  runId: string;
  terminalStatus: 'completed' | 'paused' | 'failed' | 'cancelled';
  finalContext: Record<string, unknown>;
  /** HMAC-signed resume token; present only when the resumed run paused again. */
  approvalToken?: string;
  /** ID of the node that failed on resume; present only on `terminalStatus === 'failed'`. */
  failedNodeId?: string;
  /** ID of the node that exceeded its budget on resume. */
  exceededNodeId?: string;
  /** Human-readable error context; present only on failure. */
  errorContext?: string;
}
