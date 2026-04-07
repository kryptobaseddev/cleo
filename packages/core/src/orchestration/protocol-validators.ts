/**
 * Protocol validators for all 9 CLEO protocols.
 * Validates manifest entries and outputs against protocol requirements.
 *
 * @task T4499
 * @epic T4498
 */

import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/** Protocol violation entry. */
export interface ProtocolViolation {
  requirement: string;
  severity: 'error' | 'warning';
  message: string;
  fix: string;
}

/** Protocol validation result. */
export interface ProtocolValidationResult {
  valid: boolean;
  protocol: string;
  violations: ProtocolViolation[];
  score: number;
}

/** Manifest entry structure for validation. */
export interface ManifestEntryInput {
  id?: string;
  file?: string;
  title?: string;
  date?: string;
  status?: string;
  agent_type?: string;
  topics?: string[];
  key_findings?: string[];
  actionable?: boolean;
  needs_followup?: string[];
  linked_tasks?: string[];
  sources?: string[];
}

/**
 * All supported protocol types.
 *
 * The canonical set covers all 9 RCASD-IVTR pipeline stages plus the 3
 * cross-cutting protocols that compose with specific stages:
 *
 * - Pipeline stages: research, consensus, architecture-decision,
 *   specification, decomposition, implementation, validation, testing, release
 * - Cross-cutting: contribution (at implementation),
 *   artifact-publish (at release), provenance (at release)
 *
 * @task T260 — unify pipeline stages and cross-cutting protocols
 */
export const PROTOCOL_TYPES = [
  'research',
  'consensus',
  'architecture-decision',
  'specification',
  'decomposition',
  'implementation',
  'contribution',
  'validation',
  'testing',
  'release',
  'artifact-publish',
  'provenance',
] as const;

export type ProtocolType = (typeof PROTOCOL_TYPES)[number];

/**
 * Map protocol types to exit codes.
 *
 * Pipeline protocols use the 60-67 orchestrator range. Cross-cutting
 * protocols with dedicated ranges (artifact-publish 85-89, provenance 90-94)
 * use their own codes. Architecture-decision uses 84 PROVENANCE_REQUIRED
 * because every ADR MUST be generated from an accepted Consensus verdict
 * (ADR-001) — the provenance chain is the whole point.
 *
 * @task T260
 */
export const PROTOCOL_EXIT_CODES: Record<ProtocolType, ExitCode> = {
  research: ExitCode.PROTOCOL_MISSING, // 60
  consensus: ExitCode.INVALID_RETURN_MESSAGE, // 61
  specification: ExitCode.MANIFEST_ENTRY_MISSING, // 62
  decomposition: ExitCode.SPAWN_VALIDATION_FAILED, // 63
  implementation: ExitCode.AUTONOMOUS_BOUNDARY, // 64
  contribution: ExitCode.HANDOFF_REQUIRED, // 65
  release: ExitCode.RESUME_FAILED, // 66
  testing: ExitCode.CONCURRENT_SESSION, // 67 (shared: both testing and validation are lifecycle gates)
  validation: ExitCode.LIFECYCLE_GATE_FAILED, // 80
  'architecture-decision': ExitCode.PROVENANCE_REQUIRED, // 84 (ADR-001: must link to consensus)
  'artifact-publish': ExitCode.ARTIFACT_PUBLISH_FAILED, // 88 (dedicated)
  provenance: ExitCode.ATTESTATION_INVALID, // 94 (dedicated)
};

// ============================================================
// Common validation helpers
// ============================================================

function checkRequiredField(entry: ManifestEntryInput, field: keyof ManifestEntryInput): boolean {
  const value = entry[field];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' && value.trim().length === 0) return false;
  return true;
}

function checkArrayMinLength(
  entry: ManifestEntryInput,
  field: keyof ManifestEntryInput,
  min: number,
): boolean {
  const value = entry[field];
  if (!Array.isArray(value)) return false;
  return value.length >= min;
}

function checkAgentType(entry: ManifestEntryInput, expected: string): boolean {
  return entry.agent_type === expected;
}

// ============================================================
// Research Protocol (RSCH-*)
// ============================================================

/** @task T4499 */
export function validateResearchProtocol(
  entry: ManifestEntryInput,
  options: { strict?: boolean; hasCodeChanges?: boolean } = {},
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // RSCH-001: MUST NOT implement code
  if (options.hasCodeChanges) {
    violations.push({
      requirement: 'RSCH-001',
      severity: 'error',
      message: 'Research task modified code',
      fix: 'Revert code changes, research is read-only',
    });
    score -= 30;
  }

  // RSCH-006: MUST include 3-7 key findings
  const findings = entry.key_findings ?? [];
  if (findings.length < 3 || findings.length > 7) {
    violations.push({
      requirement: 'RSCH-006',
      severity: 'error',
      message: `Key findings must be 3-7, got ${findings.length}`,
      fix: 'Add/remove findings in manifest entry',
    });
    score -= 20;
  }

  // RSCH-007: MUST set agent_type: research
  if (!checkAgentType(entry, 'research')) {
    violations.push({
      requirement: 'RSCH-007',
      severity: 'error',
      message: `agent_type must be research, got ${entry.agent_type ?? 'undefined'}`,
      fix: 'Update manifest entry agent_type field',
    });
    score -= 15;
  }

  // RSCH-002: SHOULD document sources (warning)
  if (options.strict && !checkArrayMinLength(entry, 'sources', 1)) {
    violations.push({
      requirement: 'RSCH-002',
      severity: 'warning',
      message: 'Sources field missing',
      fix: 'Add sources array to manifest',
    });
    score -= 10;
  }

  const hasErrors = violations.some((v) => v.severity === 'error');
  return { valid: !hasErrors, protocol: 'research', violations, score: Math.max(0, score) };
}

// ============================================================
// Consensus Protocol (CONS-*)
// ============================================================

export interface VotingMatrix {
  options: Array<{ name: string; confidence: number; rationale?: string }>;
  threshold?: number;
}

/** @task T4499 */
export function validateConsensusProtocol(
  entry: ManifestEntryInput,
  votingMatrix: VotingMatrix = { options: [] },
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // CONS-001: MUST have voting matrix with >= 2 options
  if (votingMatrix.options.length < 2) {
    violations.push({
      requirement: 'CONS-001',
      severity: 'error',
      message: `Voting matrix must have >= 2 options, got ${votingMatrix.options.length}`,
      fix: 'Add more options to voting matrix',
    });
    score -= 25;
  }

  // CONS-003: MUST have confidence scores (0.0-1.0)
  const invalidConfidence = votingMatrix.options.filter(
    (o) => o.confidence < 0.0 || o.confidence > 1.0,
  );
  if (invalidConfidence.length > 0) {
    violations.push({
      requirement: 'CONS-003',
      severity: 'error',
      message: 'Confidence scores must be 0.0-1.0',
      fix: 'Fix confidence values in voting matrix',
    });
    score -= 20;
  }

  // CONS-004: MUST meet threshold (50% by default)
  const threshold = votingMatrix.threshold ?? 0.5;
  const topConfidence =
    votingMatrix.options.length > 0
      ? Math.max(...votingMatrix.options.map((o) => o.confidence))
      : 0;
  if (topConfidence < threshold) {
    violations.push({
      requirement: 'CONS-004',
      severity: 'error',
      message: `Threshold not met (${threshold * 100}% required, got ${topConfidence * 100}%)`,
      fix: 'Increase confidence or add more supporting rationale',
    });
    score -= 30;
  }

  // CONS-007: MUST set agent_type: analysis
  if (!checkAgentType(entry, 'analysis')) {
    violations.push({
      requirement: 'CONS-007',
      severity: 'error',
      message: `agent_type must be analysis, got ${entry.agent_type ?? 'undefined'}`,
      fix: 'Update manifest entry agent_type field',
    });
    score -= 15;
  }

  const hasErrors = violations.some((v) => v.severity === 'error');
  return { valid: !hasErrors, protocol: 'consensus', violations, score: Math.max(0, score) };
}

// ============================================================
// Specification Protocol (SPEC-*)
// ============================================================

/** @task T4499 */
export function validateSpecificationProtocol(
  entry: ManifestEntryInput,
  specContent?: string,
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // SPEC-001: MUST contain RFC 2119 keywords
  if (specContent) {
    const rfc2119Keywords = [
      'MUST',
      'MUST NOT',
      'SHALL',
      'SHALL NOT',
      'SHOULD',
      'SHOULD NOT',
      'MAY',
      'REQUIRED',
      'OPTIONAL',
    ];
    const hasRfc = rfc2119Keywords.some((kw) => specContent.includes(kw));
    if (!hasRfc) {
      violations.push({
        requirement: 'SPEC-001',
        severity: 'error',
        message: 'Specification must contain RFC 2119 keywords',
        fix: 'Add MUST, SHOULD, MAY keywords to requirements',
      });
      score -= 25;
    }
  }

  // SPEC-002: MUST include version
  if (!checkRequiredField(entry, 'id')) {
    violations.push({
      requirement: 'SPEC-002',
      severity: 'error',
      message: 'Specification must have an identifier',
      fix: 'Add version/id to specification metadata',
    });
    score -= 15;
  }

  // SPEC-007: MUST set agent_type: specification
  if (!checkAgentType(entry, 'specification')) {
    violations.push({
      requirement: 'SPEC-007',
      severity: 'error',
      message: `agent_type must be specification, got ${entry.agent_type ?? 'undefined'}`,
      fix: 'Update manifest entry agent_type field',
    });
    score -= 15;
  }

  // SPEC-003: MUST have output file
  if (!checkRequiredField(entry, 'file')) {
    violations.push({
      requirement: 'SPEC-003',
      severity: 'error',
      message: 'Specification must produce an output file',
      fix: 'Write specification document to file',
    });
    score -= 20;
  }

  const hasErrors = violations.some((v) => v.severity === 'error');
  return { valid: !hasErrors, protocol: 'specification', violations, score: Math.max(0, score) };
}

// ============================================================
// Decomposition Protocol (DCOMP-*)
// ============================================================

/** @task T4499 */
export function validateDecompositionProtocol(
  entry: ManifestEntryInput,
  options: {
    siblingCount?: number;
    descriptionClarity?: boolean;
    maxSiblings?: number;
    maxDepth?: number;
  } = {},
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // DCOMP-001: Siblings must respect hierarchy.maxSiblings policy (0 = unlimited)
  const maxSiblings = options.maxSiblings ?? 0;
  if (options.siblingCount !== undefined && maxSiblings > 0 && options.siblingCount > maxSiblings) {
    violations.push({
      requirement: 'DCOMP-001',
      severity: 'error',
      message: `Too many siblings: ${options.siblingCount} (max ${maxSiblings})`,
      fix: 'Split into sub-epics or reduce task count',
    });
    score -= 25;
  }

  // DCOMP-002: Each task must have clear description
  if (options.descriptionClarity === false) {
    violations.push({
      requirement: 'DCOMP-002',
      severity: 'error',
      message: 'Task descriptions must be clear and actionable',
      fix: 'Rewrite descriptions with specific acceptance criteria',
    });
    score -= 20;
  }

  // DCOMP-007: MUST set agent_type: decomposition
  if (!checkAgentType(entry, 'decomposition')) {
    violations.push({
      requirement: 'DCOMP-007',
      severity: 'error',
      message: `agent_type must be decomposition, got ${entry.agent_type ?? 'undefined'}`,
      fix: 'Update manifest entry agent_type field',
    });
    score -= 15;
  }

  const hasErrors = violations.some((v) => v.severity === 'error');
  return { valid: !hasErrors, protocol: 'decomposition', violations, score: Math.max(0, score) };
}

// ============================================================
// Implementation Protocol (IMPL-*)
// ============================================================

/** @task T4499 */
export function validateImplementationProtocol(
  entry: ManifestEntryInput,
  options: { hasTaskTags?: boolean } = {},
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // IMPL-001: MUST include @task tags on new functions
  if (options.hasTaskTags === false) {
    violations.push({
      requirement: 'IMPL-001',
      severity: 'error',
      message: 'Missing @task tags on new functions',
      fix: 'Add @task T#### tags to all new function docstrings',
    });
    score -= 20;
  }

  // IMPL-003: MUST have output file
  if (!checkRequiredField(entry, 'file')) {
    violations.push({
      requirement: 'IMPL-003',
      severity: 'error',
      message: 'Implementation must produce an output file',
      fix: 'Write implementation output to file',
    });
    score -= 20;
  }

  // IMPL-007: MUST set agent_type: implementation
  if (!checkAgentType(entry, 'implementation')) {
    violations.push({
      requirement: 'IMPL-007',
      severity: 'error',
      message: `agent_type must be implementation, got ${entry.agent_type ?? 'undefined'}`,
      fix: 'Update manifest entry agent_type field',
    });
    score -= 15;
  }

  // IMPL-004: MUST have linked tasks
  if (!checkArrayMinLength(entry, 'linked_tasks', 1)) {
    violations.push({
      requirement: 'IMPL-004',
      severity: 'error',
      message: 'Implementation must link to at least one task',
      fix: 'Add linked_tasks array with task IDs',
    });
    score -= 15;
  }

  const hasErrors = violations.some((v) => v.severity === 'error');
  return { valid: !hasErrors, protocol: 'implementation', violations, score: Math.max(0, score) };
}

// ============================================================
// Contribution Protocol (CONT-*)
// ============================================================

/** @task T4499 */
export function validateContributionProtocol(
  entry: ManifestEntryInput,
  options: { hasContributionTags?: boolean } = {},
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // CONT-001: MUST include @contribution tags
  if (options.hasContributionTags === false) {
    violations.push({
      requirement: 'CONT-001',
      severity: 'error',
      message: 'Missing @task/@contribution tags',
      fix: 'Add @contribution tags to contributed code',
    });
    score -= 20;
  }

  // CONT-007: MUST set agent_type: contribution
  if (!checkAgentType(entry, 'contribution')) {
    violations.push({
      requirement: 'CONT-007',
      severity: 'error',
      message: `agent_type must be contribution, got ${entry.agent_type ?? 'undefined'}`,
      fix: 'Update manifest entry agent_type field',
    });
    score -= 15;
  }

  // CONT-003: MUST have linked tasks
  if (!checkArrayMinLength(entry, 'linked_tasks', 1)) {
    violations.push({
      requirement: 'CONT-003',
      severity: 'error',
      message: 'Contribution must link to at least one task',
      fix: 'Add linked_tasks array with task IDs',
    });
    score -= 15;
  }

  const hasErrors = violations.some((v) => v.severity === 'error');
  return { valid: !hasErrors, protocol: 'contribution', violations, score: Math.max(0, score) };
}

// ============================================================
// Release Protocol (REL-*)
// ============================================================

/** @task T4499 */
export function validateReleaseProtocol(
  entry: ManifestEntryInput,
  options: { version?: string; hasChangelog?: boolean } = {},
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // REL-001: MUST have valid version format (X.Y.Z or YYYY.M.patch)
  if (options.version) {
    if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/.test(options.version)) {
      violations.push({
        requirement: 'REL-001',
        severity: 'error',
        message: `Invalid version format: ${options.version}`,
        fix: 'Use valid version format: X.Y.Z or YYYY.M.patch (CalVer)',
      });
      score -= 30;
    }
  }

  // REL-002: MUST have changelog
  if (options.hasChangelog === false) {
    violations.push({
      requirement: 'REL-002',
      severity: 'error',
      message: 'Release must include changelog',
      fix: 'Generate changelog before shipping',
    });
    score -= 20;
  }

  // REL-007: MUST set agent_type: release
  if (!checkAgentType(entry, 'release')) {
    violations.push({
      requirement: 'REL-007',
      severity: 'error',
      message: `agent_type must be release, got ${entry.agent_type ?? 'undefined'}`,
      fix: 'Update manifest entry agent_type field',
    });
    score -= 15;
  }

  const hasErrors = violations.some((v) => v.severity === 'error');
  return { valid: !hasErrors, protocol: 'release', violations, score: Math.max(0, score) };
}

// ============================================================
// Artifact Publish Protocol (ARTF-*)
// ============================================================

/** @task T4499 */
export function validateArtifactPublishProtocol(
  entry: ManifestEntryInput,
  options: { artifactType?: string; buildPassed?: boolean } = {},
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // ARTF-001: MUST specify artifact type
  if (!options.artifactType) {
    violations.push({
      requirement: 'ARTF-001',
      severity: 'error',
      message: 'Artifact type must be specified',
      fix: 'Set artifact type (npm, docker, binary, etc.)',
    });
    score -= 25;
  }

  // ARTF-002: Build MUST pass
  if (options.buildPassed === false) {
    violations.push({
      requirement: 'ARTF-002',
      severity: 'error',
      message: 'Build must pass before publishing',
      fix: 'Fix build errors and retry',
    });
    score -= 30;
  }

  // ARTF-007: MUST set agent_type: artifact-publish
  if (!checkAgentType(entry, 'artifact-publish')) {
    violations.push({
      requirement: 'ARTF-007',
      severity: 'error',
      message: `agent_type must be artifact-publish, got ${entry.agent_type ?? 'undefined'}`,
      fix: 'Update manifest entry agent_type field',
    });
    score -= 15;
  }

  const hasErrors = violations.some((v) => v.severity === 'error');
  return { valid: !hasErrors, protocol: 'artifact-publish', violations, score: Math.max(0, score) };
}

// ============================================================
// Provenance Protocol (PROV-*)
// ============================================================

/** @task T4499 */
export function validateProvenanceProtocol(
  entry: ManifestEntryInput,
  options: { hasAttestation?: boolean; hasSbom?: boolean } = {},
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // PROV-001: MUST have attestation
  if (options.hasAttestation === false) {
    violations.push({
      requirement: 'PROV-001',
      severity: 'error',
      message: 'Provenance attestation is required',
      fix: 'Generate SLSA provenance attestation',
    });
    score -= 30;
  }

  // PROV-002: SHOULD have SBOM
  if (options.hasSbom === false) {
    violations.push({
      requirement: 'PROV-002',
      severity: 'warning',
      message: 'SBOM is recommended for provenance',
      fix: 'Generate Software Bill of Materials',
    });
    score -= 10;
  }

  // PROV-007: MUST set agent_type: provenance
  if (!checkAgentType(entry, 'provenance')) {
    violations.push({
      requirement: 'PROV-007',
      severity: 'error',
      message: `agent_type must be provenance, got ${entry.agent_type ?? 'undefined'}`,
      fix: 'Update manifest entry agent_type field',
    });
    score -= 15;
  }

  const hasErrors = violations.some((v) => v.severity === 'error');
  return { valid: !hasErrors, protocol: 'provenance', violations, score: Math.max(0, score) };
}

// ============================================================
// Architecture Decision Record Protocol (ADR-*)
// ============================================================

/**
 * ADR lifecycle status values.
 * @task T260
 */
export type AdrStatus = 'proposed' | 'accepted' | 'superseded' | 'deprecated';

/** Architecture decision options for validator. */
export interface ArchitectureDecisionOptions {
  /** Content of the ADR markdown document, used to verify required sections. */
  adrContent?: string;
  /** Current status of the decision record. */
  status?: AdrStatus;
  /** Whether a human-in-the-loop review has been completed (ADR-003). */
  hitlReviewed?: boolean;
  /** Whether downstream artifacts are flagged for review after supersession. */
  downstreamFlagged?: boolean;
  /** Whether the record is persisted in the canonical SQLite decisions table. */
  persistedInDb?: boolean;
}

/**
 * Validate an Architecture Decision Record manifest entry.
 *
 * Enforces the 8 MUST requirements from `architecture-decision.md`:
 * ADR-001 (consensus provenance), ADR-002 (manifest link), ADR-003 (HITL),
 * ADR-004 (required sections), ADR-005 (cascade on supersession),
 * ADR-006 (SQLite persistence), ADR-007 (agent_type), ADR-008 (spec block).
 *
 * ADR-005, ADR-006, and ADR-008 require runtime state the caller must
 * provide via options — this validator checks the options and never
 * performs side-effectful I/O.
 *
 * @task T260
 */
export function validateArchitectureDecisionProtocol(
  entry: ManifestEntryInput & { consensus_manifest_id?: string },
  options: ArchitectureDecisionOptions = {},
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // ADR-001 / ADR-002: MUST be generated from accepted Consensus and
  // include a `consensus_manifest_id` link.
  if (!entry.consensus_manifest_id || entry.consensus_manifest_id.trim().length === 0) {
    violations.push({
      requirement: 'ADR-001',
      severity: 'error',
      message: 'ADR must link to the originating consensus manifest',
      fix: 'Add consensus_manifest_id to manifest entry referencing the accepted consensus',
    });
    score -= 25;
  }

  // ADR-003: Transition from proposed→accepted requires explicit HITL review.
  if (options.status === 'accepted' && options.hitlReviewed === false) {
    violations.push({
      requirement: 'ADR-003',
      severity: 'error',
      message: 'ADR cannot be accepted without HITL (human-in-the-loop) review',
      fix: 'Have a human review and approve the ADR before promoting to accepted',
    });
    score -= 30;
  }

  // ADR-004: MUST include Context, Options Evaluated, Decision, Rationale, Consequences.
  if (options.adrContent) {
    const requiredSections = [
      /##\s+.*Context/i,
      /##\s+.*Option/i,
      /##\s+.*Decision/i,
      /##\s+.*Rationale/i,
      /##\s+.*Consequences/i,
    ];
    const missing = requiredSections.filter((re) => !re.test(options.adrContent!)).length;
    if (missing > 0) {
      violations.push({
        requirement: 'ADR-004',
        severity: 'error',
        message: `ADR missing ${missing} of 5 required sections (Context, Options, Decision, Rationale, Consequences)`,
        fix: 'Add all five canonical sections to the ADR body',
      });
      score -= 20;
    }
  }

  // ADR-005: If the record is superseded, downstream artifacts MUST be flagged.
  if (options.status === 'superseded' && options.downstreamFlagged === false) {
    violations.push({
      requirement: 'ADR-005',
      severity: 'error',
      message: 'Superseded ADR has not triggered downstream invalidation cascade',
      fix: 'Flag linked specifications, decomposition, and implementations for review',
    });
    score -= 20;
  }

  // ADR-006: MUST be persisted in the canonical SQLite decisions table.
  if (options.persistedInDb === false) {
    violations.push({
      requirement: 'ADR-006',
      severity: 'error',
      message: 'ADR not persisted in canonical decisions SQLite table',
      fix: 'Insert the decision via the Drizzle ORM architectureDecisions table',
    });
    score -= 15;
  }

  // ADR-007: MUST set agent_type: decision
  if (!checkAgentType(entry, 'decision')) {
    violations.push({
      requirement: 'ADR-007',
      severity: 'error',
      message: `agent_type must be decision, got ${entry.agent_type ?? 'undefined'}`,
      fix: 'Update manifest entry agent_type field to "decision"',
    });
    score -= 15;
  }

  // ADR (output file): MUST produce an ADR markdown document.
  if (!checkRequiredField(entry, 'file')) {
    violations.push({
      requirement: 'ADR-004',
      severity: 'error',
      message: 'ADR must produce an output markdown file',
      fix: 'Write the ADR to disk and reference it in the manifest entry',
    });
    score -= 10;
  }

  const hasErrors = violations.some((v) => v.severity === 'error');
  return {
    valid: !hasErrors,
    protocol: 'architecture-decision',
    violations,
    score: Math.max(0, score),
  };
}

// ============================================================
// Validation Protocol (VALID-*)
// ============================================================

/** Validation-stage options for validator. */
export interface ValidationStageOptions {
  /** Whether static analysis / type check passed (VALID-001). */
  specMatchConfirmed?: boolean;
  /** Whether the existing test suite ran successfully (VALID-002). */
  testSuitePassed?: boolean;
  /** Whether upstream protocol compliance checks passed (VALID-003). */
  protocolComplianceChecked?: boolean;
}

/**
 * Validate a manifest entry against the validation stage protocol.
 *
 * Enforces VALID-001..007 from `validation.md`. The validation stage runs
 * static analysis, type checking, and pre-test quality gates. This validator
 * verifies the manifest entry captures a real validation run; runtime gate
 * enforcement happens in the lifecycle state machine, not here.
 *
 * @task T260
 */
export function validateValidationProtocol(
  entry: ManifestEntryInput,
  options: ValidationStageOptions = {},
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // VALID-001: MUST verify implementation matches specification
  if (options.specMatchConfirmed === false) {
    violations.push({
      requirement: 'VALID-001',
      severity: 'error',
      message: 'Validation must confirm implementation matches specification',
      fix: 'Run spec-match validation before reporting completion',
    });
    score -= 25;
  }

  // VALID-002: MUST run existing test suite and report results
  if (options.testSuitePassed === false) {
    violations.push({
      requirement: 'VALID-002',
      severity: 'error',
      message: 'Existing test suite failed during validation',
      fix: 'Fix failing tests before completing the validation stage',
    });
    score -= 25;
  }

  // VALID-003: MUST check protocol compliance
  if (options.protocolComplianceChecked === false) {
    violations.push({
      requirement: 'VALID-003',
      severity: 'error',
      message: 'Upstream protocol compliance not checked',
      fix: 'Run cleo check protocol for every upstream protocol before validation exits',
    });
    score -= 20;
  }

  // VALID-005: MUST write validation summary (key_findings) to manifest
  if (!checkArrayMinLength(entry, 'key_findings', 1)) {
    violations.push({
      requirement: 'VALID-005',
      severity: 'error',
      message: 'Validation must record summary findings in manifest entry',
      fix: 'Populate key_findings with pass/fail counts and coverage',
    });
    score -= 15;
  }

  // VALID-006: MUST set agent_type: validation
  if (!checkAgentType(entry, 'validation')) {
    violations.push({
      requirement: 'VALID-006',
      severity: 'error',
      message: `agent_type must be validation, got ${entry.agent_type ?? 'undefined'}`,
      fix: 'Update manifest entry agent_type field to "validation"',
    });
    score -= 15;
  }

  const hasErrors = violations.some((v) => v.severity === 'error');
  return { valid: !hasErrors, protocol: 'validation', violations, score: Math.max(0, score) };
}

// ============================================================
// Testing Protocol (TEST-*)
// ============================================================

/**
 * Project-agnostic test framework identifiers.
 *
 * The testing protocol is deliberately framework-neutral. Whichever
 * framework the project uses, the protocol only cares that tests run
 * autonomously via a framework adapter and loop until the spec is met.
 *
 * @task T260
 */
export type TestFramework =
  | 'vitest'
  | 'jest'
  | 'mocha'
  | 'pytest'
  | 'unittest'
  | 'go-test'
  | 'cargo-test'
  | 'rspec'
  | 'phpunit'
  | 'bats'
  | 'other';

/** Testing-stage options for validator. */
export interface TestingOptions {
  /** Detected or declared test framework for the current worktree. */
  framework?: TestFramework;
  /** Total number of tests executed. */
  testsRun?: number;
  /** Number of tests that passed. */
  testsPassed?: number;
  /** Number of tests that failed. */
  testsFailed?: number;
  /** Coverage percentage achieved (0-100). */
  coveragePercent?: number;
  /** Minimum coverage threshold from project config. */
  coverageThreshold?: number;
  /** Whether the implementation→validate→test loop converged (spec met). */
  ivtLoopConverged?: boolean;
  /** Number of IVT loop iterations until convergence. */
  ivtLoopIterations?: number;
}

/**
 * Validate a manifest entry against the testing protocol.
 *
 * This validator is **project-agnostic**: it makes no assumption about the
 * underlying test framework. It enforces the invariant that tests ran via
 * a detected framework, achieved 100% pass rate, and (if an IVT loop was
 * used) converged before the stage completes.
 *
 * Enforces TEST-001..007 from the post-2026-04 rewrite of `testing.md`.
 *
 * @task T260
 */
export function validateTestingProtocol(
  entry: ManifestEntryInput,
  options: TestingOptions = {},
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // TEST-001: MUST identify the detected test framework (project-agnostic).
  if (!options.framework) {
    violations.push({
      requirement: 'TEST-001',
      severity: 'error',
      message: 'Test framework not identified for the current worktree',
      fix: 'Detect or declare the project test framework before running tests',
    });
    score -= 20;
  }

  // TEST-004: MUST achieve 100% pass rate before release.
  if (
    options.testsRun !== undefined &&
    options.testsFailed !== undefined &&
    options.testsFailed > 0
  ) {
    violations.push({
      requirement: 'TEST-004',
      severity: 'error',
      message: `${options.testsFailed} of ${options.testsRun} tests failed`,
      fix: 'Fix failing tests; re-enter the IVT loop until all pass',
    });
    score -= 30;
  }

  // TEST-005: IVT loop MUST converge (spec satisfied) before testing exits.
  if (options.ivtLoopConverged === false) {
    violations.push({
      requirement: 'TEST-005',
      severity: 'error',
      message: 'Implement→Validate→Test loop has not converged on specification',
      fix: 'Continue IVT iterations until implementation satisfies the spec',
    });
    score -= 25;
  }

  // TEST-006: MUST include test summary (key_findings) in manifest.
  if (!checkArrayMinLength(entry, 'key_findings', 1)) {
    violations.push({
      requirement: 'TEST-006',
      severity: 'error',
      message: 'Testing output must record pass/fail summary in key_findings',
      fix: 'Populate key_findings with framework, pass count, fail count, coverage',
    });
    score -= 10;
  }

  // TEST-007: MUST set agent_type: testing
  if (!checkAgentType(entry, 'testing')) {
    violations.push({
      requirement: 'TEST-007',
      severity: 'error',
      message: `agent_type must be testing, got ${entry.agent_type ?? 'undefined'}`,
      fix: 'Update manifest entry agent_type field to "testing"',
    });
    score -= 15;
  }

  // Coverage threshold (advisory, non-blocking unless explicit threshold given).
  if (
    options.coveragePercent !== undefined &&
    options.coverageThreshold !== undefined &&
    options.coveragePercent < options.coverageThreshold
  ) {
    violations.push({
      requirement: 'TEST-004',
      severity: 'warning',
      message: `Coverage ${options.coveragePercent}% below threshold ${options.coverageThreshold}%`,
      fix: 'Add tests for uncovered code paths',
    });
    score -= 5;
  }

  const hasErrors = violations.some((v) => v.severity === 'error');
  return { valid: !hasErrors, protocol: 'testing', violations, score: Math.max(0, score) };
}

// ============================================================
// Unified Dispatcher
// ============================================================

/**
 * Validate a manifest entry against a specific protocol.
 * Throws CleoError with appropriate exit code on strict failure.
 * @task T4499
 */
export function validateProtocol(
  protocol: ProtocolType,
  entry: ManifestEntryInput,
  options: Record<string, unknown> = {},
  strict: boolean = false,
): ProtocolValidationResult {
  let result: ProtocolValidationResult;

  switch (protocol) {
    case 'research':
      result = validateResearchProtocol(
        entry,
        options as { strict?: boolean; hasCodeChanges?: boolean },
      );
      break;
    case 'consensus':
      result = validateConsensusProtocol(entry, options.votingMatrix as VotingMatrix);
      break;
    case 'specification':
      result = validateSpecificationProtocol(entry, options.specContent as string);
      break;
    case 'decomposition':
      result = validateDecompositionProtocol(
        entry,
        options as {
          siblingCount?: number;
          descriptionClarity?: boolean;
          maxSiblings?: number;
          maxDepth?: number;
        },
      );
      break;
    case 'implementation':
      result = validateImplementationProtocol(entry, options as { hasTaskTags?: boolean });
      break;
    case 'contribution':
      result = validateContributionProtocol(entry, options as { hasContributionTags?: boolean });
      break;
    case 'release':
      result = validateReleaseProtocol(
        entry,
        options as { version?: string; hasChangelog?: boolean },
      );
      break;
    case 'artifact-publish':
      result = validateArtifactPublishProtocol(
        entry,
        options as { artifactType?: string; buildPassed?: boolean },
      );
      break;
    case 'provenance':
      result = validateProvenanceProtocol(
        entry,
        options as { hasAttestation?: boolean; hasSbom?: boolean },
      );
      break;
    case 'architecture-decision':
      result = validateArchitectureDecisionProtocol(
        entry as ManifestEntryInput & { consensus_manifest_id?: string },
        options as ArchitectureDecisionOptions,
      );
      break;
    case 'validation':
      result = validateValidationProtocol(entry, options as ValidationStageOptions);
      break;
    case 'testing':
      result = validateTestingProtocol(entry, options as TestingOptions);
      break;
    default:
      throw new CleoError(ExitCode.CONCURRENT_SESSION, `Unknown protocol: ${protocol as string}`);
  }

  if (!result.valid && strict) {
    const exitCode = PROTOCOL_EXIT_CODES[protocol];
    throw new CleoError(
      exitCode,
      `Protocol validation failed for ${protocol}: ${result.violations
        .filter((v) => v.severity === 'error')
        .map((v) => v.message)
        .join('; ')}`,
    );
  }

  return result;
}
