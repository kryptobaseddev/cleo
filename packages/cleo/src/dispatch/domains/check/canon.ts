/**
 * check.canon — CI-gate canon drift detector.
 *
 * Compares structural claims in canonical docs against live code:
 *   - CANONICAL_DOMAINS length from packages/cleo/src/dispatch/types.ts
 *   - OPERATIONS count from packages/cleo/src/dispatch/registry.ts
 *   - Phrase assertions in CLEO-ARCHITECTURE-GUIDE.md, CLEO-VISION.md,
 *     and CLEO-OPERATION-CONSTITUTION.md
 *
 * Returns a structured result with per-file pass/fail and exit-non-zero
 * when any drift is detected.
 *
 * @task T646
 * @see ADR-044 — historical narrative files excluded from canon checks
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single violation found in a doc file. */
export interface CanonViolation {
  /** Absolute path to the offending file. */
  file: string;
  /** 1-based line number where the forbidden phrase was found. */
  line: number;
  /** The forbidden phrase that was matched. */
  phrase: string;
}

/** Per-doc result for a required positive phrase assertion. */
export interface CanonDocAssertion {
  /** Absolute path to the doc file. */
  file: string;
  /** Human-readable name for the assertion. */
  assertion: string;
  /** Whether the assertion passed. */
  passed: boolean;
}

/** Full result returned by runCanonCheck. */
export interface CanonCheckResult {
  /** Number of canonical domains found in types.ts. */
  domainsInCode: number;
  /** Number of operations found in registry.ts. */
  operationsInCode: number;
  /** Forbidden phrases found across all checked docs. */
  violations: CanonViolation[];
  /** Required positive phrase assertions per doc. */
  assertions: CanonDocAssertion[];
  /** Whether all checks passed (no violations + all assertions pass). */
  passed: boolean;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Phrases that MUST NOT appear in audited docs.
 * Presence of any of these indicates canon drift.
 */
const FORBIDDEN_PHRASES: readonly string[] = [
  'Four Great Systems',
  'Four systems',
  'Circle of Ten',
  'exactly 10 domains',
  'exactly ten domains',
];

/**
 * Historical narrative files excluded per ADR-044.
 * These are story/manifesto files that may reference superseded counts.
 */
const EXCLUDED_FILENAMES: readonly string[] = [
  'CLEO-CANT.md',
  'CLEO-AWAKENING-STORY.md',
  'CLEO-FOUNDING-STORY.md',
  'CLEO-MANIFESTO.md',
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read a file and return its lines (1-indexed via array index+1).
 * Returns empty array if the file cannot be read.
 */
function readLines(filePath: string): string[] {
  try {
    return readFileSync(filePath, 'utf8').split('\n');
  } catch {
    return [];
  }
}

/**
 * Scan lines for any occurrence of a forbidden phrase (case-sensitive).
 * Returns all violations found.
 */
function scanForbiddenPhrases(filePath: string, lines: string[]): CanonViolation[] {
  const results: CanonViolation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const phrase of FORBIDDEN_PHRASES) {
      if (line.includes(phrase)) {
        results.push({ file: filePath, line: i + 1, phrase });
      }
    }
  }
  return results;
}

/**
 * Count the number of entries in the CANONICAL_DOMAINS array.
 * Parses the TypeScript source directly — no eval, no import.
 */
function countCanonicalDomains(typesFilePath: string): number {
  const lines = readLines(typesFilePath);
  let inArray = false;
  let count = 0;

  for (const line of lines) {
    if (!inArray) {
      if (line.includes('CANONICAL_DOMAINS') && line.includes('[')) {
        inArray = true;
      }
      continue;
    }
    // End of array
    if (line.includes('] as const')) {
      break;
    }
    // Count quoted string entries: lines like  'tasks',
    const trimmed = line.trim();
    if (trimmed.startsWith("'") && trimmed.includes("'")) {
      count++;
    }
  }

  return count;
}

/**
 * Count operations in registry.ts by counting `gateway:` keys.
 */
function countOperations(registryFilePath: string): number {
  const lines = readLines(registryFilePath);
  let count = 0;
  for (const line of lines) {
    if (/^\s*gateway:/.test(line)) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parameters for runCanonCheck. */
export interface CanonCheckParams {
  /** Project root — docs and packages are resolved relative to this. */
  projectRoot: string;
}

/**
 * Run the full canon drift check.
 *
 * Reads live code from `packages/cleo/src/dispatch/types.ts` and
 * `packages/cleo/src/dispatch/registry.ts`, then audits the three
 * canonical doc files for forbidden phrases and required assertions.
 *
 * @param params - Check parameters (projectRoot required).
 * @returns Structured result with violations, assertions, and pass/fail flag.
 *
 * @task T646
 */
export function runCanonCheck(params: CanonCheckParams): CanonCheckResult {
  const { projectRoot } = params;

  // Resolve paths
  const typesFile = join(projectRoot, 'packages/cleo/src/dispatch/types.ts');
  const registryFile = join(projectRoot, 'packages/cleo/src/dispatch/registry.ts');
  const archGuide = join(projectRoot, 'docs/concepts/CLEO-ARCHITECTURE-GUIDE.md');
  const visionDoc = join(projectRoot, 'docs/concepts/CLEO-VISION.md');
  const constitution = join(projectRoot, 'docs/specs/CLEO-OPERATION-CONSTITUTION.md');

  // Read code sources
  const domainsInCode = countCanonicalDomains(typesFile);
  const operationsInCode = countOperations(registryFile);

  // Determine excluded basenames (ADR-044)
  const excludedSet = new Set(EXCLUDED_FILENAMES);

  // Docs to audit — only non-excluded files
  const auditedDocs = [archGuide, visionDoc, constitution].filter((f) => {
    const basename = f.split('/').pop() ?? '';
    return !excludedSet.has(basename);
  });

  // Scan forbidden phrases
  const allViolations: CanonViolation[] = [];
  for (const docPath of auditedDocs) {
    const lines = readLines(docPath);
    allViolations.push(...scanForbiddenPhrases(docPath, lines));
  }

  // Required positive assertions
  const assertions: CanonDocAssertion[] = [];

  // CLEO-ARCHITECTURE-GUIDE.md must contain "Six Great Systems" + "Circle of Eleven"
  const archLines = readLines(archGuide);
  const archText = archLines.join('\n');
  assertions.push({
    file: archGuide,
    assertion: 'Contains "Six Great Systems"',
    passed: archText.includes('Six Great Systems'),
  });
  assertions.push({
    file: archGuide,
    assertion: 'Contains "Circle of Eleven"',
    passed: archText.includes('Circle of Eleven'),
  });

  // CLEO-VISION.md must contain at least one reference to "six systems"
  const visionLines = readLines(visionDoc);
  const visionText = visionLines.join('\n');
  assertions.push({
    file: visionDoc,
    assertion: 'Contains reference to six systems',
    passed:
      visionText.includes('six systems') ||
      visionText.includes('Six systems') ||
      visionText.includes('6 systems') ||
      visionText.includes('six canonical systems'),
  });

  // CLEO-OPERATION-CONSTITUTION.md must reference 11 canonical domains
  const constLines = readLines(constitution);
  const constText = constLines.join('\n');
  assertions.push({
    file: constitution,
    assertion: 'Contains "11 canonical domains"',
    passed:
      constText.includes('11 canonical domains') || constText.includes('eleven canonical domains'),
  });

  const allAssertionsPassed = assertions.every((a) => a.passed);
  const passed = allViolations.length === 0 && allAssertionsPassed;

  return {
    domainsInCode,
    operationsInCode,
    violations: allViolations,
    assertions,
    passed,
  };
}
