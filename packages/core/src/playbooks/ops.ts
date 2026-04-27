/**
 * Playbook operation signatures owned by Core.
 *
 * Dispatch uses these signatures as the type source for `OpsFromCore` while
 * playbook runtime behavior remains in `@cleocode/playbooks` and the CLI
 * dispatch handler. The declaration-only registry mirrors the admin domain
 * pattern (T1437) and avoids introducing a Core runtime dependency on the
 * playbooks package.
 *
 * Architecture note (ADR-057 D1 exception — T1456): `executePlaybook` /
 * `resumePlaybook` embed `db: DatabaseSync` as non-wire-serializable runtime
 * infrastructure. The `(projectRoot, params)` Core normalization pattern does
 * **not** apply at the runtime level; this file owns only the wire-format
 * (CLI/SDK) dispatch signature shapes.
 *
 * @task T1442 — playbook dispatch OpsFromCore refactor
 * @see packages/contracts/src/operations/playbook.ts — wire-format Params/Result types
 * @see @cleocode/playbooks — runtime SSoT (executePlaybook, resumePlaybook)
 * @see ADR-057 D1 — uniform Core API normalization (exception documented above)
 */

import type {
  PlaybookListParams,
  PlaybookListResult,
  PlaybookResumeParams,
  PlaybookResumeResult,
  PlaybookRunParams,
  PlaybookRunResult,
  PlaybookStatusParams,
  PlaybookStatusResult,
  PlaybookValidateParams,
  PlaybookValidateResult,
} from '@cleocode/contracts/operations/playbook';

/**
 * Playbook operation record used by dispatch for Core-derived operation
 * inference.
 *
 * Each entry maps an operation name to a typed function signature whose
 * first argument is the wire-format params type and whose return type is the
 * wire-format result type. Dispatch infers the full `TypedOpRecord` via
 * `OpsFromCore<typeof playbookCoreOps>` without requiring per-op explicit
 * `Params`/`Result` imports in the dispatch handler.
 *
 * @example
 * ```ts
 * import type { playbook as corePlaybook } from '@cleocode/core';
 * import type { OpsFromCore } from '../adapters/typed.js';
 *
 * type PlaybookDispatchOps = OpsFromCore<typeof corePlaybook.playbookCoreOps>;
 * ```
 */
export declare const playbookCoreOps: {
  /** Fetch the state of a single playbook run by ID. */
  readonly status: (params: PlaybookStatusParams) => Promise<PlaybookStatusResult>;
  /** List playbook runs with optional status, epic, limit, and offset filters. */
  readonly list: (params: PlaybookListParams) => Promise<PlaybookListResult>;
  /** Parse and validate a `.cantbook` file without executing it. */
  readonly validate: (params: PlaybookValidateParams) => Promise<PlaybookValidateResult>;
  /** Load and execute a named `.cantbook` playbook. */
  readonly run: (params: PlaybookRunParams) => Promise<PlaybookRunResult>;
  /** Resume a paused playbook run once its HITL gate has been approved. */
  readonly resume: (params: PlaybookResumeParams) => Promise<PlaybookResumeResult>;
};
