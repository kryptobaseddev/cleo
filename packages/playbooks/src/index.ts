/**
 * @cleocode/playbooks — Playbook DSL + runtime for T889 Orchestration Coherence v3.
 *
 * This package is scaffolded in Wave 0. Subsequent waves will populate:
 * - `schema.ts`     (W4-6)  — types + Drizzle table defs
 * - `parser.ts`     (W4-7)  — .cantbook YAML parser
 * - `state.ts`      (W4-8)  — DB CRUD for playbook_runs + playbook_approvals
 * - `policy.ts`     (W4-9)  — HITL auto-policy rules
 * - `runtime.ts`    (W4-10) — state machine executor
 * - `approval.ts`   (W4-16) — resume token generation + approval ops
 * - `skill-composer.ts` (W4-2..5) — three-source skill bundle composer
 *
 * @remarks
 * Only the {@link PLAYBOOKS_PACKAGE_VERSION} constant is exported from the
 * Wave 0 scaffold. Each follow-up wave adds a named barrel export here.
 *
 * @task T889 Orchestration Coherence v3 — Wave 0 scaffold
 */

/**
 * Package version string matching the monorepo's CalVer cadence.
 *
 * Consumers can use this to assert dependency alignment at runtime
 * (e.g. ensuring the `@cleocode/playbooks` runtime matches CLEO core).
 */
export const PLAYBOOKS_PACKAGE_VERSION: string = '2026.4.85';

export {
  approveGate,
  type CreateApprovalGateInput,
  createApprovalGate,
  E_APPROVAL_ALREADY_DECIDED,
  E_APPROVAL_NOT_FOUND,
  generateResumeToken,
  getPendingApprovals,
  getPlaybookSecret,
  rejectGate,
} from './approval.js';
// W4-7: .cantbook YAML parser → PlaybookDefinition
export {
  type ParsePlaybookResult,
  PlaybookParseError,
  parsePlaybook,
} from './parser.js';
// W4-9: HITL auto-policy evaluator
export {
  DEFAULT_POLICY_RULES,
  type EvaluatePolicyResult,
  evaluatePolicy,
  type PolicyRule,
} from './policy.js';
// W4-10 / T930: playbook runtime state machine + HITL resume
export {
  type AgentDispatcher,
  type AgentDispatchInput,
  type AgentDispatchResult,
  type DeterministicRunInput,
  type DeterministicRunner,
  type DeterministicRunResult,
  E_PLAYBOOK_RESUME_BLOCKED,
  E_PLAYBOOK_RUNTIME_INVALID,
  type ExecutePlaybookOptions,
  type ExecutePlaybookResult,
  executePlaybook,
  type PlaybookTerminalStatus,
  type ResumePlaybookOptions,
  resumePlaybook,
} from './runtime.js';
// W4-8: state layer CRUD for playbook_runs + playbook_approvals
export {
  type CreatePlaybookApprovalInput,
  type CreatePlaybookRunInput,
  createPlaybookApproval,
  createPlaybookRun,
  deletePlaybookRun,
  getPlaybookApprovalByToken,
  getPlaybookRun,
  type ListPlaybookRunsOptions,
  listPlaybookApprovals,
  listPlaybookRuns,
  updatePlaybookApproval,
  updatePlaybookRun,
} from './state.js';
