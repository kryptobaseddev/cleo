/**
 * Protocol Rule Definitions for CLEO MCP Server
 *
 * @task T2918
 * @epic T2908
 *
 * Defines validation rules for all 7 RCSD-IVTR protocols.
 *
 * Reference: lib/protocol-validation.sh, protocols/*.md
 */

/**
 * RFC 2119 requirement levels
 */
export type RequirementLevel = 'MUST' | 'SHOULD' | 'MAY';

/**
 * Violation severity
 */
export type ViolationSeverity = 'error' | 'warning';

/**
 * Protocol rule definition
 */
export interface ProtocolRule {
  /** Rule identifier (e.g., RSCH-001) */
  id: string;
  /** RFC 2119 level */
  level: RequirementLevel;
  /** Rule description */
  message: string;
  /** Suggested fix command */
  fix: string;
  /** Validation function */
  validate: (
    manifestEntry: Record<string, unknown>,
    additionalData?: Record<string, unknown>
  ) => Promise<boolean> | boolean;
}

/**
 * Protocol violation result
 */
export interface ProtocolViolation {
  requirement: string;
  severity: ViolationSeverity;
  message: string;
  fix: string;
}

/**
 * Protocol validation result
 */
export interface ProtocolValidationResult {
  valid: boolean;
  violations: ProtocolViolation[];
  score: number;
}

/**
 * Helper: Check if field exists and is non-empty
 */
function hasField(obj: Record<string, unknown>, field: string): boolean {
  const value = obj[field];
  return value !== null && value !== undefined && value !== '';
}

/**
 * Helper: Check array field length
 */
function arrayLengthInRange(
  obj: Record<string, unknown>,
  field: string,
  min: number,
  max: number
): boolean {
  const value = obj[field];
  if (!Array.isArray(value)) {
    return false;
  }
  return value.length >= min && value.length <= max;
}

/**
 * Helper: Check enum value
 */
function hasEnumValue(obj: Record<string, unknown>, field: string, values: string[]): boolean {
  const value = obj[field];
  return typeof value === 'string' && values.includes(value);
}

/**
 * Research Protocol Rules (RSCH-*)
 */
const RESEARCH_RULES: ProtocolRule[] = [
  {
    id: 'RSCH-001',
    level: 'MUST',
    message: 'Research task must not modify code',
    fix: 'Revert code changes, research is read-only',
    validate: (entry, data) => {
      return !data?.hasCodeChanges;
    },
  },
  {
    id: 'RSCH-002',
    level: 'SHOULD',
    message: 'Should document sources',
    fix: 'Add sources array to manifest',
    validate: (entry) => {
      return hasField(entry, 'sources');
    },
  },
  {
    id: 'RSCH-003',
    level: 'MUST',
    message: 'Must link research to task via linked_tasks',
    fix: 'Add linked_tasks array referencing the task and epic IDs',
    validate: (entry) => {
      const linkedTasks = entry.linked_tasks;
      return Array.isArray(linkedTasks) && linkedTasks.length > 0;
    },
  },
  {
    id: 'RSCH-004',
    level: 'MUST',
    message: 'Must append entry to MANIFEST.jsonl',
    fix: 'Append manifest entry with correct format',
    validate: (entry) => {
      return hasField(entry, 'id') && hasField(entry, 'file') && hasField(entry, 'date');
    },
  },
  {
    id: 'RSCH-005',
    level: 'MUST',
    message: 'Must write output file with required structure (title, summary, content)',
    fix: 'Ensure output file contains title, summary, and content sections',
    validate: (entry) => {
      return hasField(entry, 'file') && hasField(entry, 'title') && hasField(entry, 'status');
    },
  },
  {
    id: 'RSCH-006',
    level: 'MUST',
    message: 'Must include 3-7 key findings',
    fix: 'Add/remove findings in manifest entry',
    validate: (entry) => {
      return arrayLengthInRange(entry, 'key_findings', 3, 7);
    },
  },
  {
    id: 'RSCH-007',
    level: 'MUST',
    message: 'Must set agent_type: research',
    fix: 'Update manifest entry agent_type field',
    validate: (entry) => {
      return hasEnumValue(entry, 'agent_type', ['research']);
    },
  },
];

/**
 * Consensus Protocol Rules (CONS-*)
 */
const CONSENSUS_RULES: ProtocolRule[] = [
  {
    id: 'CONS-001',
    level: 'MUST',
    message: 'Must have voting matrix with ≥2 options',
    fix: 'Add more options to voting matrix',
    validate: (entry, data) => {
      const votingMatrix = data?.votingMatrix as Record<string, unknown> | undefined;
      if (!votingMatrix) return false;
      const options = votingMatrix.options as unknown[];
      return Array.isArray(options) && options.length >= 2;
    },
  },
  {
    id: 'CONS-002',
    level: 'MUST',
    message: 'Must include rationale for each voting option',
    fix: 'Add rationale string to each option in voting matrix',
    validate: (entry, data) => {
      const votingMatrix = data?.votingMatrix as Record<string, unknown> | undefined;
      if (!votingMatrix) return false;
      const options = votingMatrix.options as Array<{ rationale?: string }>;
      if (!Array.isArray(options)) return false;
      return options.every((opt) => typeof opt.rationale === 'string' && opt.rationale.length > 0);
    },
  },
  {
    id: 'CONS-003',
    level: 'MUST',
    message: 'Must include confidence scores (0.0-1.0)',
    fix: 'Fix confidence values in voting matrix',
    validate: (entry, data) => {
      const votingMatrix = data?.votingMatrix as Record<string, unknown> | undefined;
      if (!votingMatrix) return false;
      const options = votingMatrix.options as Array<{ confidence?: number }>;
      if (!Array.isArray(options)) return false;
      return options.every((opt) => {
        const conf = opt.confidence;
        return typeof conf === 'number' && conf >= 0.0 && conf <= 1.0;
      });
    },
  },
  {
    id: 'CONS-004',
    level: 'MUST',
    message: 'Must meet threshold (50% required)',
    fix: 'Increase confidence or add more supporting rationale',
    validate: (entry, data) => {
      const votingMatrix = data?.votingMatrix as Record<string, unknown> | undefined;
      if (!votingMatrix) return false;
      const options = votingMatrix.options as Array<{ confidence?: number }>;
      if (!Array.isArray(options)) return false;
      const maxConfidence = Math.max(...options.map((o) => o.confidence || 0));
      return maxConfidence >= 0.5;
    },
  },
  {
    id: 'CONS-005',
    level: 'SHOULD',
    message: 'Should record dissenting opinions',
    fix: 'Add dissent field to voting matrix for minority options',
    validate: (entry, data) => {
      const votingMatrix = data?.votingMatrix as Record<string, unknown> | undefined;
      if (!votingMatrix) return true; // Optional: SHOULD level
      return hasField(votingMatrix as Record<string, unknown>, 'dissent') ||
        hasField(votingMatrix as Record<string, unknown>, 'notes');
    },
  },
  {
    id: 'CONS-006',
    level: 'MUST',
    message: 'Must escalate to HITL when threshold not reached',
    fix: 'Set needs_followup with HITL escalation when no option meets threshold',
    validate: (entry, data) => {
      const votingMatrix = data?.votingMatrix as Record<string, unknown> | undefined;
      if (!votingMatrix) return false;
      const options = votingMatrix.options as Array<{ confidence?: number }>;
      if (!Array.isArray(options)) return false;
      const maxConfidence = Math.max(...options.map((o) => o.confidence || 0));
      // If threshold met, rule passes (no escalation needed)
      if (maxConfidence >= 0.5) return true;
      // If threshold not met, must have escalation flag
      const needsFollowup = entry.needs_followup;
      return Array.isArray(needsFollowup) && needsFollowup.length > 0;
    },
  },
  {
    id: 'CONS-007',
    level: 'MUST',
    message: 'Must set agent_type: analysis',
    fix: 'Update manifest entry agent_type field',
    validate: (entry) => {
      return hasEnumValue(entry, 'agent_type', ['analysis']);
    },
  },
];

/**
 * Specification Protocol Rules (SPEC-*)
 */
const SPECIFICATION_RULES: ProtocolRule[] = [
  {
    id: 'SPEC-001',
    level: 'MUST',
    message: 'Must include RFC 2119 keywords',
    fix: 'Add MUST/SHOULD/MAY requirements to specification',
    validate: (entry, data) => {
      const fileContent = data?.fileContent as string | undefined;
      if (!fileContent) return false;
      return /\b(MUST|SHOULD|MAY|MUST NOT|SHOULD NOT|MAY NOT)\b/.test(fileContent);
    },
  },
  {
    id: 'SPEC-002',
    level: 'MUST',
    message: 'Must have version field',
    fix: 'Add version field to manifest entry',
    validate: (entry) => {
      return hasField(entry, 'version');
    },
  },
  {
    id: 'SPEC-003',
    level: 'SHOULD',
    message: 'Should include authority/scope section',
    fix: 'Add authority section defining specification scope',
    validate: (entry, data) => {
      const fileContent = data?.fileContent as string | undefined;
      if (!fileContent) return true; // Optional
      return /\b(authority|scope)\b/i.test(fileContent);
    },
  },
  {
    id: 'SPEC-004',
    level: 'SHOULD',
    message: 'Should include conformance criteria',
    fix: 'Add conformance section defining how to verify compliance',
    validate: (entry, data) => {
      const fileContent = data?.fileContent as string | undefined;
      if (!fileContent) return true; // SHOULD level, pass when no content
      return /\b(conformance|compliance|verification)\b/i.test(fileContent);
    },
  },
  {
    id: 'SPEC-005',
    level: 'SHOULD',
    message: 'Should include change log section',
    fix: 'Add change log tracking version history',
    validate: (entry, data) => {
      const fileContent = data?.fileContent as string | undefined;
      if (!fileContent) return true; // SHOULD level
      return /\b(change\s*log|revision\s*history|version\s*history)\b/i.test(fileContent);
    },
  },
  {
    id: 'SPEC-006',
    level: 'SHOULD',
    message: 'Should include references section',
    fix: 'Add references to related specifications and documents',
    validate: (entry, data) => {
      const fileContent = data?.fileContent as string | undefined;
      if (!fileContent) return true; // SHOULD level
      return /\b(references|see also|related)\b/i.test(fileContent);
    },
  },
  {
    id: 'SPEC-007',
    level: 'MUST',
    message: 'Must set agent_type: specification',
    fix: 'Update manifest entry agent_type field',
    validate: (entry) => {
      return hasEnumValue(entry, 'agent_type', ['specification']);
    },
  },
];

/**
 * Decomposition Protocol Rules (DCMP-*)
 */
const DECOMPOSITION_RULES: ProtocolRule[] = [
  {
    id: 'DCMP-001',
    level: 'MUST',
    message: 'Must follow MECE principle (mutually exclusive, collectively exhaustive)',
    fix: 'Ensure tasks do not overlap and cover all requirements',
    validate: (entry, data) => {
      // Check for duplicate task titles in sibling list (overlap detection)
      const siblingTitles = data?.siblingTitles as string[] | undefined;
      if (!siblingTitles) return true; // No sibling data available, pass
      const uniqueTitles = new Set(siblingTitles.map((t) => t.toLowerCase().trim()));
      return uniqueTitles.size === siblingTitles.length;
    },
  },
  {
    id: 'DCMP-002',
    level: 'MUST',
    message: 'Must map dependencies (no cycles allowed)',
    fix: 'Add depends field to tasks and verify no circular references',
    validate: (entry, data) => {
      const hasCycles = data?.hasCycles as boolean | undefined;
      return hasCycles !== true; // Pass if no cycle data or no cycles
    },
  },
  {
    id: 'DCMP-003',
    level: 'MUST',
    message: 'Must respect max depth 3 (epic→task→subtask)',
    fix: 'Flatten hierarchy to max 3 levels',
    validate: (entry, data) => {
      const depth = data?.hierarchyDepth as number | undefined;
      return depth === undefined || depth <= 3;
    },
  },
  {
    id: 'DCMP-004',
    level: 'MUST',
    message: 'Must verify atomicity for leaf tasks',
    fix: 'Ensure leaf tasks are atomic and independently completable',
    validate: (entry, data) => {
      const isLeaf = data?.isLeafTask as boolean | undefined;
      if (!isLeaf) return true; // Not a leaf task, pass
      // Leaf tasks must have a clear description
      return hasField(entry, 'description') &&
        typeof entry.description === 'string' &&
        (entry.description as string).length >= 10;
    },
  },
  {
    id: 'DCMP-005',
    level: 'MUST',
    message: 'Must not include time estimates',
    fix: 'Remove time estimates, use relative sizing',
    validate: (entry) => {
      const title = entry.title as string | undefined;
      const description = entry.description as string | undefined;
      const text = `${title} ${description}`;
      return !/\b\d+\s*(hour|day|week|minute|hr|min)s?\b/i.test(text);
    },
  },
  {
    id: 'DCMP-006',
    level: 'MUST',
    message: 'Must enforce max 7 siblings per parent',
    fix: 'Break epic into smaller sub-epics or reduce task count',
    validate: (entry, data) => {
      const siblingCount = data?.siblingCount as number | undefined;
      return siblingCount === undefined || siblingCount <= 7;
    },
  },
  {
    id: 'DCMP-007',
    level: 'MUST',
    message: 'Must set agent_type: specification',
    fix: 'Update manifest entry agent_type field',
    validate: (entry) => {
      return hasEnumValue(entry, 'agent_type', ['specification']);
    },
  },
];

/**
 * Implementation Protocol Rules (IMPL-*)
 */
const IMPLEMENTATION_RULES: ProtocolRule[] = [
  {
    id: 'IMPL-003',
    level: 'MUST',
    message: 'Must include @task provenance tags',
    fix: 'Add @task T#### comment above new functions',
    validate: (entry, data) => {
      const hasNewFunctions = data?.hasNewFunctions as boolean | undefined;
      const hasProvenanceTags = data?.hasProvenanceTags as boolean | undefined;

      // If no new functions, rule passes
      if (!hasNewFunctions) return true;

      // If new functions exist, must have provenance tags
      return hasProvenanceTags === true;
    },
  },
  {
    id: 'IMPL-004',
    level: 'SHOULD',
    message: 'Should pass all tests after implementation',
    fix: 'Run test suite and fix failing tests before completion',
    validate: (entry, data) => {
      const testsPassed = data?.testsPassed as boolean | undefined;
      if (testsPassed === undefined) return true; // SHOULD level, pass when no data
      return testsPassed === true;
    },
  },
  {
    id: 'IMPL-005',
    level: 'MUST',
    message: 'Must use atomic file operations for all writes',
    fix: 'Use temp file → validate → backup → rename pattern for writes',
    validate: (entry, data) => {
      const usesAtomicOps = data?.usesAtomicOperations as boolean | undefined;
      if (usesAtomicOps === undefined) return true; // No data available, pass
      return usesAtomicOps === true;
    },
  },
  {
    id: 'IMPL-006',
    level: 'SHOULD',
    message: 'Should follow project code style',
    fix: 'Run linter and fix style violations',
    validate: (entry, data) => {
      const lintPassed = data?.lintPassed as boolean | undefined;
      if (lintPassed === undefined) return true; // SHOULD level, pass when no data
      return lintPassed === true;
    },
  },
  {
    id: 'IMPL-007',
    level: 'MUST',
    message: 'Must set agent_type: implementation',
    fix: 'Update manifest entry agent_type field',
    validate: (entry) => {
      return hasEnumValue(entry, 'agent_type', ['implementation']);
    },
  },
];

/**
 * Contribution Protocol Rules (CONT-*)
 */
const CONTRIBUTION_RULES: ProtocolRule[] = [
  {
    id: 'CONT-001',
    level: 'MUST',
    message: 'Must follow commit message conventions (<type>: <summary>)',
    fix: 'Use commit format: feat|fix|docs|test|refactor|chore: summary',
    validate: (entry, data) => {
      const commitMessage = data?.commitMessage as string | undefined;
      if (!commitMessage) return true; // No commit data available, pass
      return /^(feat|fix|docs|test|refactor|chore)(\(.+\))?:\s/.test(commitMessage);
    },
  },
  {
    id: 'CONT-002',
    level: 'MUST',
    message: 'Must include provenance tags (@task/@session)',
    fix: 'Add @task and @session tags to code',
    validate: (entry, data) => {
      const hasNewFunctions = data?.hasNewFunctions as boolean | undefined;
      const hasProvenanceTags = data?.hasProvenanceTags as boolean | undefined;

      if (!hasNewFunctions) return true;
      return hasProvenanceTags === true;
    },
  },
  {
    id: 'CONT-003',
    level: 'MUST',
    message: 'Must pass validation gates before merge',
    fix: 'Run cleo --validate and fix all violations before merging',
    validate: (entry, data) => {
      const validationPassed = data?.validationPassed as boolean | undefined;
      if (validationPassed === undefined) return true; // No data, pass
      return validationPassed === true;
    },
  },
  {
    id: 'CONT-005',
    level: 'SHOULD',
    message: 'Should flag conflicts with other sessions',
    fix: 'Check for conflicting sessions: cleo session list --active',
    validate: (entry, data) => {
      const hasConflicts = data?.hasConflicts as boolean | undefined;
      if (hasConflicts === undefined) return true; // SHOULD level, pass when no data
      return hasConflicts === false;
    },
  },
  {
    id: 'CONT-007',
    level: 'MUST',
    message: 'Must set agent_type: implementation',
    fix: 'Update manifest entry agent_type field',
    validate: (entry) => {
      return hasEnumValue(entry, 'agent_type', ['implementation']);
    },
  },
];

/**
 * Release Protocol Rules (RLSE-*)
 */
const RELEASE_RULES: ProtocolRule[] = [
  {
    id: 'RLSE-001',
    level: 'MUST',
    message: 'Must follow semver (major.minor.patch)',
    fix: 'Use format X.Y.Z (e.g., 0.74.5)',
    validate: (entry, data) => {
      const version = data?.version as string | undefined;
      if (!version) return false;
      return /^\d+\.\d+\.\d+$/.test(version);
    },
  },
  {
    id: 'RLSE-002',
    level: 'MUST',
    message: 'Must have changelog entry',
    fix: 'Add entry to CHANGELOG.md',
    validate: (entry, data) => {
      const changelogEntry = data?.changelogEntry as string | undefined;
      return !!changelogEntry;
    },
  },
  {
    id: 'RLSE-003',
    level: 'SHOULD',
    message: 'Should pass all tests before release',
    fix: 'Run test suite: ./tests/run-all-tests.sh',
    validate: (entry, data) => {
      const testsPassed = data?.testsPassed as boolean | undefined;
      if (testsPassed === undefined) return true; // SHOULD level, pass when no data
      return testsPassed === true;
    },
  },
  {
    id: 'RLSE-004',
    level: 'MUST',
    message: 'Must have git tag matching version',
    fix: 'Create git tag: git tag v{version}',
    validate: (entry, data) => {
      const gitTag = data?.gitTag as string | undefined;
      const version = data?.version as string | undefined;
      if (!gitTag || !version) return true; // No git data available, pass
      // Tag should match version (with or without 'v' prefix)
      return gitTag === version || gitTag === `v${version}`;
    },
  },
  {
    id: 'RLSE-005',
    level: 'MUST',
    message: 'Must have consistent version across VERSION file, README, and package.json',
    fix: 'Run dev/validate-version.sh to check version consistency',
    validate: (entry, data) => {
      const versionConsistent = data?.versionConsistent as boolean | undefined;
      if (versionConsistent === undefined) return true; // No data available, pass
      return versionConsistent === true;
    },
  },
  {
    id: 'RLSE-006',
    level: 'SHOULD',
    message: 'Should include rollback plan',
    fix: 'Document rollback procedure in release notes',
    validate: (entry, data) => {
      const hasRollbackPlan = data?.hasRollbackPlan as boolean | undefined;
      if (hasRollbackPlan === undefined) return true; // SHOULD level, pass when no data
      return hasRollbackPlan === true;
    },
  },
  {
    id: 'RLSE-007',
    level: 'MUST',
    message: 'Must set agent_type: documentation or release',
    fix: 'Set agent_type appropriately',
    validate: (entry) => {
      return hasEnumValue(entry, 'agent_type', ['documentation', 'release']);
    },
  },
];

/**
 * Validation Protocol Rules (VALID-*)
 */
const VALIDATION_RULES: ProtocolRule[] = [
  {
    id: 'VALID-001',
    level: 'MUST',
    message: 'Must verify output matches spec',
    fix: 'Add validation_result field with pass/fail',
    validate: (entry) => {
      return hasField(entry, 'validation_result');
    },
  },
  {
    id: 'VALID-002',
    level: 'MUST',
    message: 'Must execute test suite during validation',
    fix: 'Run test suite and record results in manifest',
    validate: (entry, data) => {
      const testResults = data?.testResults as Record<string, unknown> | undefined;
      if (!testResults) return true; // No test data, pass (tests may not apply)
      return hasField(testResults as Record<string, unknown>, 'pass_rate');
    },
  },
  {
    id: 'VALID-003',
    level: 'MUST',
    message: 'Must check protocol compliance',
    fix: 'Set status to complete/partial/blocked',
    validate: (entry) => {
      return hasEnumValue(entry, 'status', ['complete', 'partial', 'blocked']);
    },
  },
  {
    id: 'VALID-004',
    level: 'SHOULD',
    message: 'Should generate validation report',
    fix: 'Add key_findings array with validation details',
    validate: (entry) => {
      return hasField(entry, 'key_findings');
    },
  },
  {
    id: 'VALID-005',
    level: 'SHOULD',
    message: 'Should classify violation severity (error/warning)',
    fix: 'Include severity classification in validation results',
    validate: (entry, data) => {
      const violations = data?.violations as Array<{ severity?: string }> | undefined;
      if (!violations || violations.length === 0) return true; // No violations, pass
      return violations.every(
        (v) => v.severity === 'error' || v.severity === 'warning'
      );
    },
  },
  {
    id: 'VALID-006',
    level: 'MUST',
    message: 'Must set agent_type: validation',
    fix: 'Set agent_type to validation',
    validate: (entry) => {
      return hasEnumValue(entry, 'agent_type', ['validation']);
    },
  },
];

/**
 * Testing Protocol Rules (TEST-*)
 */
const TESTING_RULES: ProtocolRule[] = [
  {
    id: 'TEST-001',
    level: 'MUST',
    message: 'Must use configured test framework',
    fix: 'Use project test framework (BATS for shell, Jest for TS)',
    validate: (entry, data) => {
      const testFramework = data?.testFramework as string | undefined;
      if (!testFramework) return true; // No framework specified, pass
      const validFrameworks = ['bats', 'jest', 'vitest', 'mocha', 'pytest'];
      return validFrameworks.includes(testFramework.toLowerCase());
    },
  },
  {
    id: 'TEST-002',
    level: 'SHOULD',
    message: 'Should follow test file naming conventions',
    fix: 'Name test files: feature-name.bats or feature-name.test.ts',
    validate: (entry, data) => {
      const testFiles = data?.testFiles as string[] | undefined;
      if (!testFiles || testFiles.length === 0) return true; // SHOULD level, pass
      return testFiles.every((f) =>
        /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(f) || /\.bats$/.test(f)
      );
    },
  },
  {
    id: 'TEST-003',
    level: 'SHOULD',
    message: 'Should meet coverage thresholds',
    fix: 'Increase test coverage to meet project thresholds',
    validate: (entry, data) => {
      const coveragePercent = data?.coveragePercent as number | undefined;
      if (coveragePercent === undefined) return true; // SHOULD level, pass when no data
      return coveragePercent >= 80; // Default threshold
    },
  },
  {
    id: 'TEST-004',
    level: 'MUST',
    message: 'Must achieve 100% pass rate',
    fix: 'Fix failing tests before completion',
    validate: (entry, data) => {
      const testResults = data?.testResults as Record<string, unknown> | undefined;
      if (!testResults) return false;
      const passRate = testResults.pass_rate as number | undefined;
      return passRate === 1.0 || passRate === 1;
    },
  },
  {
    id: 'TEST-005',
    level: 'MUST',
    message: 'Must cover all MUST requirements from specification',
    fix: 'Add tests for each MUST requirement in the spec',
    validate: (entry, data) => {
      const mustRequirementsCovered = data?.mustRequirementsCovered as boolean | undefined;
      if (mustRequirementsCovered === undefined) return true; // No data, pass
      return mustRequirementsCovered === true;
    },
  },
  {
    id: 'TEST-006',
    level: 'MUST',
    message: 'Must include test summary in manifest',
    fix: 'Add key_findings array with test results',
    validate: (entry) => {
      return hasField(entry, 'key_findings');
    },
  },
  {
    id: 'TEST-007',
    level: 'MUST',
    message: 'Must set agent_type: testing',
    fix: 'Set agent_type to testing',
    validate: (entry) => {
      return hasEnumValue(entry, 'agent_type', ['testing']);
    },
  },
];

/**
 * Protocol rule registry
 */
export const PROTOCOL_RULES: Record<string, ProtocolRule[]> = {
  research: RESEARCH_RULES,
  consensus: CONSENSUS_RULES,
  specification: SPECIFICATION_RULES,
  decomposition: DECOMPOSITION_RULES,
  implementation: IMPLEMENTATION_RULES,
  contribution: CONTRIBUTION_RULES,
  release: RELEASE_RULES,
  validation: VALIDATION_RULES,
  testing: TESTING_RULES,
};
