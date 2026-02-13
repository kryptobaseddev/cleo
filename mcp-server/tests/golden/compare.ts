/**
 * Golden Fixture Comparison Utility
 *
 * Compares native engine output vs CLI fixture output for parity testing.
 * Ignores dynamic fields (timestamps, IDs, versions) and reports
 * structural + semantic differences.
 *
 * @task T4370
 */

/**
 * Fields that are expected to vary between native and CLI output.
 * These are ignored during structural comparison.
 */
const DYNAMIC_FIELDS = new Set([
  'timestamp',
  'created',
  'updated',
  'started',
  'ended',
  'id',
  'version',
  'schemaVersion',
  'score',
  'duration_ms',
  'duration',
]);

/**
 * Values that indicate a placeholder in fixture files.
 */
const PLACEHOLDER_VALUES = new Set(['__DYNAMIC__']);

/**
 * Difference found between two outputs
 */
export interface ComparisonDifference {
  /** JSON path to the difference (e.g., "task.status") */
  path: string;
  /** Type of difference */
  type: 'missing_key' | 'extra_key' | 'type_mismatch' | 'value_mismatch' | 'array_length';
  /** Value in the expected (fixture) output */
  expected: unknown;
  /** Value in the actual (native engine) output */
  actual: unknown;
  /** Whether this is a dynamic field (informational, not a failure) */
  isDynamic: boolean;
}

/**
 * Result of comparing two outputs
 */
export interface ComparisonResult {
  /** Whether the outputs are structurally equivalent (ignoring dynamic fields) */
  match: boolean;
  /** All differences found */
  differences: ComparisonDifference[];
  /** Only non-dynamic differences (actual mismatches) */
  failures: ComparisonDifference[];
  /** Dynamic field differences (informational) */
  dynamicDiffs: ComparisonDifference[];
}

/**
 * Compare native engine output against a CLI fixture.
 *
 * @param expected - The CLI fixture (reference output)
 * @param actual - The native engine output (to validate)
 * @param ignorePaths - Additional paths to ignore (e.g., "_meta.timestamp")
 * @returns Comparison result with differences
 */
export function compareOutputs(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  ignorePaths: string[] = []
): ComparisonResult {
  const ignoreSet = new Set(ignorePaths);
  const differences: ComparisonDifference[] = [];

  deepCompare(expected, actual, '', differences, ignoreSet);

  const failures = differences.filter((d) => !d.isDynamic);
  const dynamicDiffs = differences.filter((d) => d.isDynamic);

  return {
    match: failures.length === 0,
    differences,
    failures,
    dynamicDiffs,
  };
}

/**
 * Recursively compare two values, collecting differences.
 */
function deepCompare(
  expected: unknown,
  actual: unknown,
  path: string,
  differences: ComparisonDifference[],
  ignorePaths: Set<string>
): void {
  // Skip explicitly ignored paths
  if (ignorePaths.has(path)) {
    return;
  }

  // Check if the value is a placeholder
  if (typeof expected === 'string' && PLACEHOLDER_VALUES.has(expected)) {
    // Placeholder — treat as dynamic, just record for info
    differences.push({
      path,
      type: 'value_mismatch',
      expected,
      actual,
      isDynamic: true,
    });
    return;
  }

  // Check if this is a dynamic field by name
  const fieldName = path.split('.').pop() || '';
  const isDynamic = DYNAMIC_FIELDS.has(fieldName);

  // Null checks
  if (expected === null || expected === undefined) {
    if (actual !== null && actual !== undefined) {
      differences.push({
        path,
        type: 'value_mismatch',
        expected,
        actual,
        isDynamic,
      });
    }
    return;
  }

  if (actual === null || actual === undefined) {
    differences.push({
      path,
      type: 'missing_key',
      expected,
      actual,
      isDynamic,
    });
    return;
  }

  // Type check
  if (typeof expected !== typeof actual) {
    differences.push({
      path,
      type: 'type_mismatch',
      expected: typeof expected,
      actual: typeof actual,
      isDynamic,
    });
    return;
  }

  // Array comparison
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      differences.push({
        path,
        type: 'type_mismatch',
        expected: 'array',
        actual: typeof actual,
        isDynamic,
      });
      return;
    }

    if (expected.length !== actual.length) {
      differences.push({
        path,
        type: 'array_length',
        expected: expected.length,
        actual: actual.length,
        isDynamic,
      });
    }

    const minLen = Math.min(expected.length, actual.length);
    for (let i = 0; i < minLen; i++) {
      deepCompare(expected[i], actual[i], `${path}[${i}]`, differences, ignorePaths);
    }
    return;
  }

  // Object comparison
  if (typeof expected === 'object' && expected !== null) {
    const expectedObj = expected as Record<string, unknown>;
    const actualObj = actual as Record<string, unknown>;

    // Check for missing keys in actual
    for (const key of Object.keys(expectedObj)) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in actualObj)) {
        const childIsDynamic = DYNAMIC_FIELDS.has(key);
        differences.push({
          path: childPath,
          type: 'missing_key',
          expected: expectedObj[key],
          actual: undefined,
          isDynamic: childIsDynamic,
        });
      } else {
        deepCompare(expectedObj[key], actualObj[key], childPath, differences, ignorePaths);
      }
    }

    // Check for extra keys in actual
    for (const key of Object.keys(actualObj)) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in expectedObj)) {
        differences.push({
          path: childPath,
          type: 'extra_key',
          expected: undefined,
          actual: actualObj[key],
          isDynamic: false,
        });
      }
    }
    return;
  }

  // Primitive comparison
  if (expected !== actual && !isDynamic) {
    differences.push({
      path,
      type: 'value_mismatch',
      expected,
      actual,
      isDynamic: false,
    });
  } else if (expected !== actual && isDynamic) {
    differences.push({
      path,
      type: 'value_mismatch',
      expected,
      actual,
      isDynamic: true,
    });
  }
}

/**
 * Format comparison result as a human-readable report.
 */
export function formatReport(result: ComparisonResult): string {
  const lines: string[] = [];

  if (result.match) {
    lines.push('PASS: Outputs match (ignoring dynamic fields)');
  } else {
    lines.push(`FAIL: ${result.failures.length} difference(s) found`);
  }

  if (result.failures.length > 0) {
    lines.push('');
    lines.push('Failures:');
    for (const diff of result.failures) {
      lines.push(`  ${diff.path}: ${diff.type}`);
      lines.push(`    expected: ${JSON.stringify(diff.expected)}`);
      lines.push(`    actual:   ${JSON.stringify(diff.actual)}`);
    }
  }

  if (result.dynamicDiffs.length > 0) {
    lines.push('');
    lines.push(`Dynamic fields (${result.dynamicDiffs.length} skipped):`);
    for (const diff of result.dynamicDiffs) {
      lines.push(`  ${diff.path}: ${JSON.stringify(diff.expected)} -> ${JSON.stringify(diff.actual)}`);
    }
  }

  return lines.join('\n');
}
