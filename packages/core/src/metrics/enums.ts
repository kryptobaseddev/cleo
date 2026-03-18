/**
 * Metrics enum definitions - type-safe enums for the CLEO metrics system.
 * All values match schema definitions in schemas/metrics.schema.json.
 *
 * @task T4454
 * @epic T4454
 */

/** Violation severity levels. */
export enum Severity {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Critical = 'critical',
}

/** Manifest integrity states. */
export enum ManifestIntegrity {
  Valid = 'valid',
  Partial = 'partial',
  Invalid = 'invalid',
  Missing = 'missing',
}

/** Instruction stability levels. */
export enum InstructionStability {
  Stable = 'stable',
  Clarified = 'clarified',
  Revised = 'revised',
  Unstable = 'unstable',
}

/** Session degradation levels. */
export enum SessionDegradation {
  None = 'none',
  Mild = 'mild',
  Moderate = 'moderate',
  Severe = 'severe',
}

/** Agent reliability levels. */
export enum AgentReliability {
  High = 'high',
  Medium = 'medium',
  Low = 'low',
  Unreliable = 'unreliable',
}

/** Metric categories. */
export enum MetricCategory {
  Compliance = 'compliance',
  Efficiency = 'efficiency',
  Session = 'session',
  Improvement = 'improvement',
}

/** Metric sources. */
export enum MetricSource {
  Task = 'task',
  Session = 'session',
  Agent = 'agent',
  System = 'system',
  Orchestrator = 'orchestrator',
}

/** Aggregation periods. */
export enum AggregationPeriod {
  Instant = 'instant',
  Hourly = 'hourly',
  Daily = 'daily',
  Weekly = 'weekly',
  Monthly = 'monthly',
}

/** Validate that a value is a member of a given enum. */
export function isValidEnumValue<T extends Record<string, string>>(
  enumObj: T,
  value: string,
): value is T[keyof T] {
  return Object.values(enumObj).includes(value as T[keyof T]);
}
