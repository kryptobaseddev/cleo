/**
 * Protocol validators for all 9 CLEO protocols.
 * Validates manifest entries and outputs against protocol requirements.
 *
 * @task T4499
 * @epic T4498
 */

import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';

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

/** All supported protocol types. */
export const PROTOCOL_TYPES = [
  'research',
  'consensus',
  'specification',
  'decomposition',
  'implementation',
  'contribution',
  'release',
  'artifact-publish',
  'provenance',
] as const;

export type ProtocolType = typeof PROTOCOL_TYPES[number];

/** Map protocol types to exit codes. */
export const PROTOCOL_EXIT_CODES: Record<ProtocolType, ExitCode> = {
  'research': ExitCode.PROTOCOL_MISSING,         // 60
  'consensus': ExitCode.INVALID_RETURN_MESSAGE,   // 61
  'specification': ExitCode.MANIFEST_ENTRY_MISSING, // 62
  'decomposition': ExitCode.SPAWN_VALIDATION_FAILED, // 63
  'implementation': ExitCode.AUTONOMOUS_BOUNDARY,  // 64
  'contribution': ExitCode.HANDOFF_REQUIRED,       // 65
  'release': ExitCode.RESUME_FAILED,               // 66
  'artifact-publish': ExitCode.CONCURRENT_SESSION,  // 67
  'provenance': ExitCode.CONCURRENT_SESSION,        // 67 (shared with artifact-publish)
};

// ============================================================
// Common validation helpers
// ============================================================

function checkRequiredField(
  entry: ManifestEntryInput,
  field: keyof ManifestEntryInput,
): boolean {
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

  const hasErrors = violations.some(v => v.severity === 'error');
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
    o => o.confidence < 0.0 || o.confidence > 1.0,
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
  const topConfidence = votingMatrix.options.length > 0
    ? Math.max(...votingMatrix.options.map(o => o.confidence))
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

  const hasErrors = violations.some(v => v.severity === 'error');
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
    const rfc2119Keywords = ['MUST', 'MUST NOT', 'SHALL', 'SHALL NOT', 'SHOULD', 'SHOULD NOT', 'MAY', 'REQUIRED', 'OPTIONAL'];
    const hasRfc = rfc2119Keywords.some(kw => specContent.includes(kw));
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

  const hasErrors = violations.some(v => v.severity === 'error');
  return { valid: !hasErrors, protocol: 'specification', violations, score: Math.max(0, score) };
}

// ============================================================
// Decomposition Protocol (DCOMP-*)
// ============================================================

/** @task T4499 */
export function validateDecompositionProtocol(
  entry: ManifestEntryInput,
  options: { siblingCount?: number; descriptionClarity?: boolean } = {},
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // DCOMP-001: Max 7 siblings per parent
  if (options.siblingCount !== undefined && options.siblingCount > 7) {
    violations.push({
      requirement: 'DCOMP-001',
      severity: 'error',
      message: `Too many siblings: ${options.siblingCount} (max 7)`,
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

  const hasErrors = violations.some(v => v.severity === 'error');
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

  const hasErrors = violations.some(v => v.severity === 'error');
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

  const hasErrors = violations.some(v => v.severity === 'error');
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

  // REL-001: MUST have valid semver
  if (options.version) {
    if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/.test(options.version)) {
      violations.push({
        requirement: 'REL-001',
        severity: 'error',
        message: `Invalid semver: ${options.version}`,
        fix: 'Use valid semver format: MAJOR.MINOR.PATCH',
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

  const hasErrors = violations.some(v => v.severity === 'error');
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

  const hasErrors = violations.some(v => v.severity === 'error');
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

  const hasErrors = violations.some(v => v.severity === 'error');
  return { valid: !hasErrors, protocol: 'provenance', violations, score: Math.max(0, score) };
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
      result = validateResearchProtocol(entry, options as { strict?: boolean; hasCodeChanges?: boolean });
      break;
    case 'consensus':
      result = validateConsensusProtocol(entry, options.votingMatrix as VotingMatrix);
      break;
    case 'specification':
      result = validateSpecificationProtocol(entry, options.specContent as string);
      break;
    case 'decomposition':
      result = validateDecompositionProtocol(entry, options as { siblingCount?: number; descriptionClarity?: boolean });
      break;
    case 'implementation':
      result = validateImplementationProtocol(entry, options as { hasTaskTags?: boolean });
      break;
    case 'contribution':
      result = validateContributionProtocol(entry, options as { hasContributionTags?: boolean });
      break;
    case 'release':
      result = validateReleaseProtocol(entry, options as { version?: string; hasChangelog?: boolean });
      break;
    case 'artifact-publish':
      result = validateArtifactPublishProtocol(entry, options as { artifactType?: string; buildPassed?: boolean });
      break;
    case 'provenance':
      result = validateProvenanceProtocol(entry, options as { hasAttestation?: boolean; hasSbom?: boolean });
      break;
    default:
      throw new CleoError(ExitCode.CONCURRENT_SESSION, `Unknown protocol: ${protocol as string}`);
  }

  if (!result.valid && strict) {
    const exitCode = PROTOCOL_EXIT_CODES[protocol];
    throw new CleoError(
      exitCode,
      `Protocol validation failed for ${protocol}: ${result.violations.filter(v => v.severity === 'error').map(v => v.message).join('; ')}`,
    );
  }

  return result;
}
