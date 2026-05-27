/**
 * Entry Point Scoring
 *
 * Calculates entry point scores for process detection based on:
 * 1. Call ratio (callees / (callers + 1)) — high ratio = likely entry point
 * 2. Export status — exported functions get higher priority
 * 3. Name patterns — functions matching handle*, on*, *Controller, etc.
 *
 * Ported and simplified from GitNexus
 * `src/core/ingestion/entry-point-scoring.ts`.
 * Language-specific patterns are limited to TypeScript/JavaScript since
 * the current CLEO nexus pipeline only indexes those languages.
 *
 * @task T538
 * @module pipeline/entry-point-scoring
 */

// ============================================================================
// UNIVERSAL NAME PATTERNS
// ============================================================================

/**
 * Universal entry point name patterns that apply across all languages.
 * Higher matches lead to a score multiplier boost.
 */
const UNIVERSAL_ENTRY_POINT_PATTERNS: RegExp[] = [
  /^(main|init|bootstrap|start|run|setup|configure)$/i,
  /^handle[A-Z]/, // handleLogin, handleSubmit
  /^on[A-Z]/, // onClick, onSubmit
  /Handler$/, // RequestHandler
  /Controller$/, // UserController
  /^process[A-Z]/, // processPayment
  /^execute[A-Z]/, // executeQuery
  /^perform[A-Z]/, // performAction
  /^dispatch[A-Z]/, // dispatchEvent
  /^trigger[A-Z]/, // triggerAction
  /^fire[A-Z]/, // fireEvent
  /^emit[A-Z]/, // emitEvent
  /^use[A-Z]/, // React hooks (useEffect, useCallback)
];

// ============================================================================
// UTILITY PATTERNS — penalised in scoring
// ============================================================================

/**
 * Patterns that indicate utility/helper functions.
 * Matched functions are penalised so they rank lower as entry points.
 */
const UTILITY_PATTERNS: RegExp[] = [
  /^(get|set|is|has|can|should|will|did)[A-Z]/, // Accessors/predicates
  /^_/, // Private by convention
  /^(format|parse|validate|convert|transform)/i, // Transformation utilities
  /^(log|debug|error|warn|info)$/i, // Logging
  /^(to|from)[A-Z]/, // Conversions
  /^(encode|decode)/i, // Encoding utilities
  /^(serialize|deserialize)/i, // Serialisation
  /^(clone|copy|deep)/i, // Cloning utilities
  /^(merge|extend|assign)/i, // Object utilities
  /^(filter|map|reduce|sort|find)/i, // Collection utilities
  /Helper$/,
  /Util$/,
  /Utils$/,
  /^utils?$/i,
  /^helpers?$/i,
];

// ============================================================================
// TYPES
// ============================================================================

/** Result of an entry-point scoring evaluation. */
export interface EntryPointScoreResult {
  /** Final composite score. Higher = better entry point candidate. */
  score: number;
  /** Human-readable breakdown of factors contributing to the score. */
  reasons: string[];
}

// ============================================================================
// MAIN SCORING FUNCTION
// ============================================================================

/**
 * Calculate an entry point score for a function or method node.
 *
 * Score = baseScore × exportMultiplier × nameMultiplier
 *
 * Returns `{ score: 0 }` immediately when `calleeCount === 0` (no forward
 * calls = nothing to trace from this node).
 *
 * @param name - Function or method name as it appears in source
 * @param isExported - Whether the symbol is publicly exported
 * @param callerCount - Number of CALLS edges incoming to this node
 * @param calleeCount - Number of CALLS edges outgoing from this node
 * @returns Score and reasons array
 */
export function calculateEntryPointScore(
  name: string,
  isExported: boolean,
  callerCount: number,
  calleeCount: number,
): EntryPointScoreResult {
  const reasons: string[] = [];

  // Must have at least one outgoing call to trace forward
  if (calleeCount === 0) {
    return { score: 0, reasons: ['no-outgoing-calls'] };
  }

  // Base score: call ratio
  // High ratio (calls many, called by few) = likely an entry point
  const baseScore = calleeCount / (callerCount + 1);
  reasons.push(`base:${baseScore.toFixed(2)}`);

  // Export bonus: public symbols are higher-priority entry points
  const exportMultiplier = isExported ? 2.0 : 1.0;
  if (isExported) {
    reasons.push('exported');
  }

  // Name pattern scoring
  let nameMultiplier = 1.0;

  if (UTILITY_PATTERNS.some((p) => p.test(name))) {
    // Utilities get a significant penalty
    nameMultiplier = 0.3;
    reasons.push('utility-pattern');
  } else if (UNIVERSAL_ENTRY_POINT_PATTERNS.some((p) => p.test(name))) {
    // Entry point name patterns get a bonus
    nameMultiplier = 1.5;
    reasons.push('entry-pattern');
  }

  const finalScore = baseScore * exportMultiplier * nameMultiplier;

  return { score: finalScore, reasons };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Return `true` when `filePath` belongs to a test file.
 *
 * Covers common patterns across TypeScript, JavaScript, Go, Python, Rust,
 * Java, and C#. Test files are excluded from entry-point candidates entirely
 * so that test-only call graphs do not pollute the execution flow index.
 */
export function isTestFile(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, '/');

  return (
    p.includes('.test.') ||
    p.includes('.spec.') ||
    p.includes('__tests__/') ||
    p.includes('__mocks__/') ||
    p.includes('/test/') ||
    p.includes('/tests/') ||
    p.includes('/testing/') ||
    p.endsWith('_test.py') ||
    p.includes('/test_') ||
    p.endsWith('_test.go') ||
    p.includes('/src/test/') ||
    p.endsWith('tests.swift') ||
    p.endsWith('test.swift') ||
    p.endsWith('tests.cs') ||
    p.endsWith('test.cs') ||
    p.includes('.tests/') ||
    p.includes('.test/') ||
    p.endsWith('test.php') ||
    p.endsWith('spec.php') ||
    p.endsWith('_spec.rb') ||
    p.endsWith('_test.rb') ||
    p.includes('/spec/')
  );
}

/**
 * Return `true` when `filePath` is likely a utility or helper file.
 *
 * Utility files may still contain entry points but rank lower in priority.
 */
export function isUtilityFile(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, '/');

  return (
    p.includes('/utils/') ||
    p.includes('/util/') ||
    p.includes('/helpers/') ||
    p.includes('/helper/') ||
    p.includes('/common/') ||
    p.includes('/shared/') ||
    p.includes('/lib/') ||
    p.endsWith('/utils.ts') ||
    p.endsWith('/utils.js') ||
    p.endsWith('/helpers.ts') ||
    p.endsWith('/helpers.js')
  );
}
