/**
 * Shared evidence, coverage, authority, and repair contracts for project knowledge.
 *
 * Code placed in `packages/contracts/` per Package-Boundary Check — verified
 * against AGENTS.md. These contracts contain no runtime implementation.
 */

import type {
  BackgroundJobStatus,
  JobFinalizationResult,
  OperationExecutionIdentity,
} from './jobs.js';

/** Availability and freshness of the evidence used for an assessment. */
export type KnowledgeCoverageStatus = 'current' | 'stale' | 'partial' | 'missing' | 'failed';

/** Qualified code-symbol candidate returned when a short name is ambiguous. */
export interface KnowledgeSymbolCandidate {
  /** Exact graph identifier accepted by subsequent lookups. */
  id: string;
  /** Symbol name when available. */
  name: string | null;
  /** Human-readable label. */
  label: string;
  /** Graph node kind. */
  kind: string;
  /** Source path relative to the owning project. */
  filePath: string | null;
}

/** A source reference whose precision limits the claims that can be derived from it. */
export interface KnowledgeEvidenceRef {
  /** SHA-256 of the cited source text, required for authority-changing proposals. */
  contentHash?: string;
  /** Exact cited excerpt, checked against the source before applying authority changes. */
  excerpt?: string;
  /** Stable reference understood by the canonical API for this source. */
  id: string;
  /** Project owning the source; cross-project references retain their original owner. */
  projectId: string;
  /** Source surface, rather than an inferred relationship or similarity score. */
  source: 'task' | 'verification' | 'commit' | 'attachment' | 'memory' | 'index' | 'file';
  /** Revision at which the source was observed; null means unrecorded. */
  revision: string | null;
  /** A file reference does not establish that each symbol in the file changed. */
  precision: 'project' | 'record' | 'file' | 'symbol';
}

/** Historical file evidence resolved against the explicitly configured source root. */
export interface KnowledgeFileEvidence {
  /** File path relative to the configured source root. */
  path: string;
  /** Existing absolute source path, or null when unresolved. */
  resolvedPath: string | null;
  /** Sources establishing a file association, without claiming symbol-level edits. */
  evidence: KnowledgeEvidenceRef[];
}

/** Evidence-backed task footprint before graph symbol expansion. */
export interface TaskKnowledgeEvidence {
  /** Task whose historical evidence was read. */
  taskId: string;
  /** Canonical source root from the published generation, or project root for legacy indexes. */
  sourceRoot: string;
  /** Deduplicated referenced files, including unresolved paths. */
  files: KnowledgeFileEvidence[];
  /** Assessment of the supporting evidence and graph. */
  coverage: KnowledgeCoverage;
  /** Unresolved paths and unsupported evidence formats requiring caller action. */
  findings: KnowledgeRepairFinding[];
}

/**
 * Freshness observations over a persisted source inventory within one caller deadline.
 * @remarks Completed counts terminal observations, including changed, missing, or
 * failed files; it does not mean every observation succeeded. Requested and
 * unassessed are null until the persisted population is available. Extraction
 * failures and runtime-call completeness are separate coverage dimensions.
 * @example
 * ```ts
 * const inventory: KnowledgeInventoryCoverage = {
 *   requested: 503, completed: 502, unassessed: 1,
 *   changed: 1, missing: 0, failed: 0,
 * };
 * ```
 */
export interface KnowledgeInventoryCoverage {
  /** Persisted non-excluded source entries requested; null when not yet known. */
  requested: number | null;
  /** Entries with terminal freshness observations by the deadline, including failures. */
  completed: number;
  /** Requested minus completed; null when the population is not yet known. */
  unassessed: number | null;
  /** Completed entries whose content or filesystem metadata changed, excluding missing files. */
  changed: number;
  /** Completed entries whose owned path is absent; this establishes stale evidence. */
  missing: number;
  /** Completed freshness checks with diagnostic/ownership/read failures, excluding absence. */
  failed: number;
}

/** Coverage is independent of impact severity and never implies complete runtime knowledge. */
export interface KnowledgeCoverage {
  /**
   * Freshness progress for new assessments; absent only on legacy result shapes.
   * @defaultValue undefined for legacy results that did not assess inventory.
   */
  inventory?: KnowledgeInventoryCoverage;
  /** Total reasons before an orientation response selects a bounded sample. */
  reasonCount?: number;
  /** Total references before an orientation response selects a bounded sample. */
  evidenceCount?: number;
  /** Supported command returning the detailed assessment omitted from orientation. */
  detailsCommand?: string;
  /** Deferred maintenance state when the caller's bounded assessment cannot finish. */
  maintenanceState?: KnowledgeRepairState;
  /** Explicit supported next action when maintenance requires a separate invocation. */
  nextAction?: string;
  /** Availability and freshness of the assessed evidence. */
  status: KnowledgeCoverageStatus;
  /** Canonical project identity, preserved across repair and indexing. */
  projectId: string;
  /** Revision being assessed; null explicitly records that it was not established. */
  assessedRevision: string | null;
  /** Revision represented by the index; null explicitly records missing provenance. */
  indexedRevision: string | null;
  /** ISO-8601 time of this assessment. */
  assessedAt: string;
  /** Reasons for the status, including missing sources and diagnostic failures. */
  reasons: string[];
  /** Sources consulted to establish coverage. */
  evidence: KnowledgeEvidenceRef[];
  /** Limits such as static analysis being unable to prove all runtime callers. */
  limitations: string[];
}

/** Authority is established by sourced relationships, not similarity or recency alone. */
export type KnowledgeAuthorityStatus = 'current' | 'historical' | 'conflicted' | 'unverified';

/** An explicit, sourced replacement of one knowledge record by another. */
export interface KnowledgeReplacement {
  /** Replaced record identifier. */
  previousId: string;
  /** Current successor record identifier. */
  successorId: string;
  /** Explanation of the correction, including obsolete wording when relevant. */
  reason: string;
  /** At least one explicit source is required before applying a replacement. */
  evidence: [KnowledgeEvidenceRef, ...KnowledgeEvidenceRef[]];
}

/** Authority assessment that keeps historical records available and conflicts explicit. */
export interface KnowledgeAuthority {
  /** Record being assessed. */
  recordId: string;
  /** Project owning this record, independent of task-number spelling. */
  projectId: string;
  /** Current authority classification. */
  status: KnowledgeAuthorityStatus;
  /** Sources supporting the classification. */
  evidence: KnowledgeEvidenceRef[];
  /** Explicit replacements, retained without rewriting the historical record. */
  replacements: KnowledgeReplacement[];
  /** Conflicting records requiring reconciliation by the caller or owner. */
  conflictingRecordIds: string[];
}

/** A diagnostic error or missing capability is distinct from an assessed clean result. */
export type KnowledgeDiagnosticStatus = 'clean' | 'findings' | 'unavailable' | 'failed';

/** Independently assessed diagnostic dimension. */
export interface KnowledgeDiagnostic {
  /** Outcome of this diagnostic only. */
  status: KnowledgeDiagnosticStatus;
  /** Observed findings, unavailable capabilities, or diagnostic errors. */
  reasons: string[];
  /** Sources actually inspected by this diagnostic. */
  evidence: KnowledgeEvidenceRef[];
}

/** Knowledge health keeps structure, semantics, extraction, and coverage separate. */
export interface KnowledgeHealth {
  /** Total repair findings when orientation omits the detailed repair matrix. */
  findingCount?: number;
  /** Counts by repair lifecycle state when detailed matrix rows are omitted. */
  findingStates?: Partial<Record<KnowledgeRepairState, number>>;
  /** Supported command returning the full diagnostics and repair matrix. */
  detailsCommand?: string;
  /** Structural consistency of stored knowledge. */
  structure: KnowledgeDiagnostic;
  /** Semantic contradictions and authority conflicts. */
  semantics: KnowledgeDiagnostic;
  /** Availability and success of extraction capabilities. */
  extraction: KnowledgeDiagnostic;
  /** Coverage of the project graph. */
  coverage: KnowledgeCoverage;
  /** Repairable defects with explicit evidence and postconditions. */
  findings: KnowledgeRepairFinding[];
}

/** Responsibility for resolving a knowledge defect. */
export type KnowledgeRepairClass = 'automatic' | 'agent-resolvable' | 'owner-decision';

/** Observable repair lifecycle, including unresolved and failed work. */
export type KnowledgeRepairState = 'pending' | 'running' | 'repaired' | 'unresolved' | 'failed';

/** Exact supported operation; the receiver validates arguments against its operation contract. */
export interface KnowledgeRepairAction {
  /** Registered operation identifier; never an arbitrary shell command. */
  operation: string;
  /** Named operation arguments, excluding executable code. */
  arguments: Record<string, string | number | boolean | string[] | null>;
  /** Conditions that must hold before the operation may run. */
  prerequisites: string[];
}

/** Stable repair matrix row describing an observed defect and its recovery path. */
export interface KnowledgeRepairFinding {
  /** Stable identity for deduplicating repeated and concurrent assessments. */
  id: string;
  /** Canonical project in which the defect was observed. */
  projectId: string;
  /** Records affected by the finding. */
  affectedRecordIds: string[];
  /** Observed defect or contradiction. */
  description: string;
  /** Sources demonstrating the defect, with their observed revisions. */
  evidence: KnowledgeEvidenceRef[];
  /** Whether deterministic repair, caller reasoning, or an owner decision is required. */
  repairClass: KnowledgeRepairClass;
  /** Current repair state; failed assessment must not be reported as repaired. */
  state: KnowledgeRepairState;
  /** Exact supported action, or null until a sourced resolution exists. */
  proposedAction: KnowledgeRepairAction | null;
  /** Observable postconditions required before reporting successful repair. */
  verification: string[];
  /** Recovery information; null means mutation is not yet safe to perform. */
  recovery: KnowledgeRepairRecovery | null;
}

/** Reversible recovery information captured before a repair is applied. */
export interface KnowledgeRepairRecovery {
  /** Canonical snapshot reference containing the previous state. */
  snapshotId: string;
  /** Supported operation for restoring the captured state. */
  restoreAction: KnowledgeRepairAction;
}

/** Sourced proposal checked against current state before any mutation. */
export interface KnowledgeRepairProposal {
  /** Stable proposal identity, used as an idempotency key. */
  id: string;
  /** Finding being resolved. */
  findingId: string;
  /** Canonical target project. */
  projectId: string;
  /** Revision on which the proposal depends. */
  expectedRevision: string | null;
  /** Digest of affected source state; a mismatch rejects a stale proposal. */
  expectedStateHash: string;
  /** Proposed supported operation. */
  action: KnowledgeRepairAction;
  /** Explicit sources supplied by the caller, without requiring LLM credentials. */
  evidence: [KnowledgeEvidenceRef, ...KnowledgeEvidenceRef[]];
}

/** One exact resource whose captured image constrains a supported repair. */
export interface KnowledgeRepairResource {
  /** Canonical resource family; no arbitrary SQL table or filesystem action. */
  kind: 'decision' | 'observation' | 'file';
  /** Stable record identity or project-relative canonical source path. */
  id: string;
  /** Whether this resource changes or only supplies supporting evidence. */
  role: 'affected' | 'source';
  /** SHA-256 of the complete stored row or original UTF-8 source bytes. */
  beforeHash: string;
}

/** Authentic retained repair snapshot selected for resource-specific rollback. */
export interface KnowledgeRollbackReference {
  /** Original successful repair receipt identity; its bytes remain unchanged. */
  receiptId: string;
  /** SHA-256 of the complete retained original snapshot and receipt bytes. */
  receiptHash: string;
}

/** Existing sourced proposal enriched with immutable, independently captured execution scope. */
export interface KnowledgePreparedRepairProposal extends KnowledgeRepairProposal {
  /** Version of this authenticated preparation shape. */
  version: 1;
  /** Original retained recovery snapshot, present only for rollback. @defaultValue undefined */
  rollback?: KnowledgeRollbackReference;
  /** Project, actor and immutable retry identity captured before any await. */
  identity: OperationExecutionIdentity;
  /** Exact database file containing the resources and durable pending job. */
  databasePath: string;
  /** Published analysis source root, or the project root for an unindexed scope. */
  sourceRoot: string;
  /** Published generation observed at preparation; null explicitly means absent. */
  expectedGeneration: string | null;
  /** Digest of the full validated index assessment, including explicit absence. */
  assessmentHash: string;
  /** Exact affected rows and authority sources, retained across retries. */
  resources: KnowledgeRepairResource[];
}

/** Durable preparation outcome; no executor is started by this result. */
export interface KnowledgeRepairPreparation {
  /** Existing durable job identity to inspect or explicitly resume. */
  jobId: string;
  /** Current observed job status, never inferred from successful command execution. */
  jobStatus: BackgroundJobStatus;
  /** SHA-256 of the immutable prepared proposal bytes. */
  proposalHash: string;
  /** Exact validated inputs retained in the existing job store. */
  proposal: KnowledgePreparedRepairProposal;
  /** Original caller deadline shared across all foreground stages. */
  deadlineAt: number;
  /** Whether preparation committed after that deadline; committed work is retained. */
  deadlineExceeded: boolean;
}

/** Exact append-only lifecycle payload retained for later inspection. */
export interface KnowledgeRepairLedgerEntry {
  /** Stable original metadata identity. */
  key: string;
  /** Original JSON bytes; inspection never rewrites prior evidence. */
  valueJson: string;
}

/** Authenticated current job state with separate historical attempt and receipt evidence. */
export interface KnowledgeRepairInspection {
  /** Existing durable operation identity. */
  jobId: string;
  /** Observed lifecycle state, independent of a cancellation request. */
  status: BackgroundJobStatus;
  /** Digest of the exact retained immutable proposal bytes. */
  proposalHash: string;
  /** Independently validated immutable input and project/actor scope. */
  proposal: KnowledgePreparedRepairProposal;
  /** Number of claimed attempts. */
  attempts: number;
  /** Latest persisted ownership epoch. */
  fencingEpoch: number;
  /** Current owner token, or null for unstarted work. */
  ownerId: string | null;
  /** Observed lease deadline, or null when absent. */
  leaseExpiresAt: number | null;
  /** Requested cancellation timestamp; does not imply committed effects were undone. */
  cancellationRequestedAt: number | null;
  /** Retained checkpoint bytes, or null when absent. */
  checkpointJson: string | null;
  /** Verified repair receipt, kept separate from unsuccessful attempt outcomes. */
  receipt: KnowledgeRepairReceipt | null;
  /** Separate current recovery receipt, preserving the original historical receipt above. */
  rollbackReceipt: KnowledgeRepairReceipt | null;
  /** Explicit stored-job diagnostic, including committed connection-cleanup failures. */
  diagnosticError: string | null;
  /** Historical entries in append order, limited by the requested page size. */
  ledger: KnowledgeRepairLedgerEntry[];
  /** Total retained matching entries, including those outside this page. */
  ledgerTotal: number;
  /** Whether this response contains the complete retained lifecycle ledger. */
  ledgerComplete: boolean;
}

/** Durable cancellation request plus actual observed state, not a rollback claim. */
export interface KnowledgeRepairCancellation {
  /** Whether pending work was cancelled or a running attempt received a request. */
  requested: boolean;
  /** Actual job and receipt state after the request transaction. */
  inspection: KnowledgeRepairInspection | null;
  /** Diagnostic after a committed request; null means the inspection completed. */
  diagnosticError: string | null;
  /** Original invocation deadline, never renewed by cancellation bookkeeping. */
  deadlineAt: number;
  /** Whether the request committed after that deadline. */
  deadlineExceeded: boolean;
}

/** Verified scoped provenance added by the owned repair execution path. */
export interface KnowledgeRepairExecution {
  /** Original immutable receipt recovered by this operation. @defaultValue undefined */
  rollback?: KnowledgeRollbackReference;
  /** Captured actor and immutable operation scope. */
  identity: OperationExecutionIdentity;
  /** Durable job whose terminal state committed with this receipt. */
  jobId: string;
  /** Unique claim owner for this attempt. */
  ownerId: string;
  /** Monotonic claim fencing epoch. */
  fencingEpoch: number;
  /** Digest of the authentic prepared proposal bytes. */
  proposalHash: string;
  /** Published generation observed before mutation; rollback verifies affected resources independently. */
  generation: string | null;
  /** Exact affected and sourced resources, with hashes before and after mutation. */
  resources: Array<
    KnowledgeRepairResource & {
      /** Complete image hash observed after domain postconditions passed. */
      afterHash: string;
    }
  >;
  /** Append-only lifecycle event identities persisted with the mutation. */
  eventIds: string[];
}

/** Sourced failure observation for one owned repair attempt, distinct from a successful repair receipt. */
export interface KnowledgeRepairAttemptOutcome {
  /** Stable append-only identity derived from job and fencing epoch. */
  id: string;
  /** Immutable proposal identity. */
  proposalId: string;
  /** Authentic proposal byte digest. */
  proposalHash: string;
  /** Captured actor, project and operation identity. */
  identity: OperationExecutionIdentity;
  /** Durable job whose attempted mutation failed. */
  jobId: string;
  /** Unique owner of the observed attempt. */
  ownerId: string;
  /** Persisted ownership epoch. */
  fencingEpoch: number;
  /** Observed failure or cancellation; not inferred from lease expiry. */
  status: 'failed' | 'cancelled';
  /** Original stable refusal code when available. */
  errorCode: string;
  /** Original failure explanation. */
  reason: string;
  /** ISO timestamp at the start of the owned mutation attempt. */
  startedAt: string;
  /** ISO timestamp when this calling service observed the failure. */
  observedAt: string;
  /** Append-only event references committed only when finalization succeeds. */
  eventIds: string[];
}

/** Immediate failure details that distinguish durable bookkeeping from pending finalization. */
export interface KnowledgeRepairAttemptFailure {
  /** Actual observed attempt outcome, not necessarily persisted. */
  attempt: KnowledgeRepairAttemptOutcome;
  /** Atomic commit result or explicit pending finalization with original budget limits. */
  finalization: JobFinalizationResult;
}

/** Current recovery disclosure when a historically completed repair has been rolled back. */
export interface KnowledgeRepairRecoveredState {
  /** Current effect state; the original job and receipt remain historical successes. */
  state: 'rolled-back';
  /** Unmodified successful receipt whose effects were recovered. */
  originalReceipt: KnowledgeRepairReceipt;
  /** Separate authenticated rollback receipt, or null for retained legacy recovery metadata. */
  rollbackReceipt: KnowledgeRepairReceipt | null;
}

/** Durable, reversible record of an attempted repair and its verified outcome. */
export interface KnowledgeRepairReceipt {
  /** Scoped execution provenance; absent on preserved legacy receipts. @defaultValue undefined */
  execution?: KnowledgeRepairExecution;
  /** Supported operation and exact arguments applied by this receipt. */
  action?: KnowledgeRepairAction;
  /** Stable receipt identifier. */
  id: string;
  /** Proposal applied by this attempt. */
  proposalId: string;
  /** Finding associated with the attempt. */
  findingId: string;
  /** Canonical project in which the attempt ran. */
  projectId: string;
  /** Outcome, including incomplete or failed verification. */
  state: KnowledgeRepairState;
  /** One-based attempt number for enforcing retry limits. */
  attempt: number;
  /** ISO-8601 attempt start time. */
  startedAt: string;
  /** ISO-8601 completion time, or null while running. */
  completedAt: string | null;
  /** Captured previous state and supported restoration operation. */
  recovery: KnowledgeRepairRecovery;
  /** Evidence demonstrating the observed postconditions. */
  verificationEvidence: KnowledgeEvidenceRef[];
  /** Failure or unresolved reasons; never silently discarded. */
  reasons: string[];
}

/** Input to the foreground knowledge assessment and repair service. */
export interface KnowledgeDoctorOptions {
  /** Apply bounded deterministic repairs; default is assessment only. */
  fix?: boolean;
  /** Preview proposals without changing knowledge or storing receipts. */
  dryRun?: boolean;
  /** Sourced resolution submitted by the calling agent. */
  proposal?: KnowledgeRepairProposal;
  /** Receipt whose changes should be rolled back after post-state validation. */
  rollback?: string;
  /** Include one task's evidence-derived footprint findings. */
  taskId?: string;
  /** Assess explicit decision-to-task-to-code relationships and unresolved targets. */
  decisionId?: string;
  /** Foreground assessment budget in milliseconds. */
  budgetMs?: number;
}

/** Inspectable assessment, repair proposals, and committed receipts. */
export interface KnowledgeDoctorResult {
  /** Separate structural, semantic, extraction, and graph coverage assessments. */
  health: KnowledgeHealth;
  /** Hash of substantive source state used to reject stale repair proposals. */
  stateHash: string;
  /** Supported proposals requiring caller action or eligible for deterministic repair. */
  proposals: KnowledgeRepairProposal[];
  /** Durable receipts for mutations performed by this invocation. */
  receipts: KnowledgeRepairReceipt[];
  /** Whether this invocation previewed changes only. */
  dryRun: boolean;
}

/** Foreground options for explicit decision-to-code evidence reconciliation. */
export interface DecisionCodeEvidenceOptions {
  /** Optional qualified symbols explicitly mentioned by the canonical decision. */
  symbols?: string[];
  /** Persist verified relationships; default only assesses and proposes them. */
  apply?: boolean;
}

/** A decision relationship whose precision and source state can be revalidated. */
export interface DecisionCodeEvidenceLink {
  /** Versioned provenance discriminator. */
  kind: 'decision-evidence-v1';
  /** Canonical decision source identifier. */
  decisionId: string;
  /** Explicit context task, when present in the canonical decision. */
  taskId: string | null;
  /** Current graph target, a file node or an explicitly named symbol. */
  targetId: string;
  /** File evidence establishes association only, never individual symbol modification. */
  precision: 'file' | 'symbol';
  /** Canonical configured source root. */
  sourceRoot: string;
  /** Source-root-relative target file. */
  filePath: string;
  /** Published graph generation, or null for legacy graphs. */
  generationId: string | null;
  /** Assessed source revision. */
  revision: string | null;
  /** Hash of canonical decision text, rationale, and explicit task association. */
  decisionContentHash: string;
  /** Hash of explicit task file and verification evidence, when a context task exists. */
  taskContentHash: string | null;
  /** Hash of the target file when this relation was assessed. */
  targetContentHash: string;
  /** Retained explicit decision, task, verification, and attachment sources. */
  evidence: KnowledgeEvidenceRef[];
}

/** Results and unresolved findings from deterministic decision evidence reconciliation. */
export interface DecisionCodeEvidenceResult {
  /** Canonical decision assessed. */
  decisionId: string;
  /** Graph coverage assessed separately from link resolution. */
  coverage: KnowledgeCoverage;
  /** Verified candidate relationships, with their exact evidence precision. */
  links: DecisionCodeEvidenceLink[];
  /** Missing, ambiguous, unsupported, or failed evidence resolutions. */
  findings: KnowledgeRepairFinding[];
  /** Number of relationships inserted or refreshed; zero for previews/repeated calls. */
  applied: number;
}

/**
 * Selection and provenance for staging a reversible derived graph-node repair.
 * @remarks An explicit selection must resolve completely to missing, eligible source-backed nodes.
 * @example
 * ```ts
 * const options: KnowledgeBackfillOptions = { nodeIds: ['observation:O-incident'] };
 * ```
 */
export interface KnowledgeBackfillOptions {
  /** Human-readable source of the reviewed repair request. */
  source?: string;
  /** Existing backfill classification retained in the repair ledger. */
  kind?: string;
  /** Only the derived brain_page_nodes target is supported by staged reconstruction. */
  targetTable?: string;
  /** Exact qualified graph node IDs; duplicates, missing sources and ineligible records are rejected. */
  nodeIds?: readonly string[];
}
