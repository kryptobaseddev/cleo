/**
 * Bounded knowledge summaries for orientation responses.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified
 * against AGENTS.md. Full diagnostics remain available through doctor knowledge.
 */
import type {
  KnowledgeCoverage,
  KnowledgeDiagnostic,
  KnowledgeEvidenceRef,
  KnowledgeHealth,
  KnowledgeReplacement,
} from '@cleocode/contracts';

const DETAILS_COMMAND = 'cleo doctor knowledge';

function preview(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function reference(evidence: KnowledgeEvidenceRef): KnowledgeEvidenceRef {
  const { excerpt: _excerpt, ...source } = evidence;
  return source;
}

/**
 * Preserve coverage status and provenance without letting per-file reasons consume orientation.
 * @param coverage - Complete read-only assessment.
 * @returns A bounded sample with exact original counts and a detailed follow-up command.
 * @remarks The complete assessment remains unchanged; status and provenance are preserved.
 * @example
 * ```ts
 * const summary = compactKnowledgeCoverage(coverage);
 * ```
 */
export function compactKnowledgeCoverage(coverage: KnowledgeCoverage): KnowledgeCoverage {
  return {
    ...coverage,
    reasons: coverage.reasons.slice(0, 2).map((reason) => preview(reason)),
    evidence: coverage.evidence.slice(0, 1).map(reference),
    limitations: coverage.limitations.slice(0, 1).map((reason) => preview(reason)),
    reasonCount: coverage.reasonCount ?? coverage.reasons.length,
    evidenceCount: coverage.evidenceCount ?? coverage.evidence.length,
    detailsCommand: DETAILS_COMMAND,
  };
}

function diagnostic(value: KnowledgeDiagnostic): KnowledgeDiagnostic {
  return {
    status: value.status,
    reasons: value.reasons.slice(0, 1).map((r) => preview(r)),
    evidence: [],
  };
}

/**
 * Keep independent diagnostic states visible while deferring the repair matrix to its query.
 * @param health - Complete assessment produced by bounded maintenance.
 * @returns Compact health retaining the real finding count, never an implied empty healthy result.
 * @remarks State counts distinguish pending work from an assessed empty matrix.
 * @example
 * ```ts
 * const summary = compactKnowledgeHealth(health);
 * ```
 */
export function compactKnowledgeHealth(health: KnowledgeHealth): KnowledgeHealth {
  const findingStates: NonNullable<KnowledgeHealth['findingStates']> = {};
  for (const finding of health.findings) {
    findingStates[finding.state] = (findingStates[finding.state] ?? 0) + 1;
  }
  return {
    structure: diagnostic(health.structure),
    semantics: diagnostic(health.semantics),
    extraction: diagnostic(health.extraction),
    coverage: compactKnowledgeCoverage(health.coverage),
    findings: [],
    findingCount: health.findingCount ?? health.findings.length,
    findingStates: health.findingStates ?? findingStates,
    detailsCommand: DETAILS_COMMAND,
  };
}

/**
 * Keep sourced replacement identities visible without repeating potentially large source excerpts.
 * @param corrections - Verified replacements read from immutable repair receipts.
 * @returns Bounded presentation copies; stored receipts and source evidence remain unchanged.
 * @remarks Source identifiers and hashes remain available; full excerpts stay in canonical receipts.
 * @example
 * ```ts
 * const visible = compactKnowledgeCorrections(corrections);
 * ```
 */
export function compactKnowledgeCorrections(
  corrections: KnowledgeReplacement[],
): KnowledgeReplacement[] {
  return corrections.slice(0, 3).map((correction) => ({
    previousId: correction.previousId,
    successorId: correction.successorId,
    reason: preview(correction.reason),
    evidence: [reference(correction.evidence[0])],
  }));
}
