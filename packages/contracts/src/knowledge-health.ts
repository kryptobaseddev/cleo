/**
 * Shared evidence, coverage, authority, and repair contracts for project knowledge.
 *
 * Code placed in `packages/contracts/` per Package-Boundary Check — verified
 * against AGENTS.md. These contracts contain no runtime implementation.
 */

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

/** Coverage is independent of impact severity and never implies complete runtime knowledge. */
export interface KnowledgeCoverage {
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

/** Durable, reversible record of an attempted repair and its verified outcome. */
export interface KnowledgeRepairReceipt {
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
