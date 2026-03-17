/**
 * Admin help operation — business logic for progressive-disclosure help.
 *
 * Generates tier-filtered operation listings, cost hints, quick-start
 * guidance, and domain-grouped operation summaries for the admin.help query.
 *
 * @task T5708
 */

/** Minimal operation definition consumed by help logic. */
export interface HelpOperationDef {
  gateway: 'query' | 'mutate';
  domain: string;
  operation: string;
  description: string;
  tier: number;
}

/** Cost hint classification for an operation. */
export type CostHint = 'minimal' | 'moderate' | 'heavy';

/** Domain-grouped operation format (compact). */
export interface GroupedOperations {
  [domain: string]: { query: string[]; mutate: string[] };
}

/** Verbose operation entry with cost hints. */
export interface VerboseOperation {
  gateway: string;
  domain: string;
  operation: string;
  description: string;
  costHint: CostHint;
}

/** Result of the help computation. */
export interface HelpResult {
  tier: number;
  operationCount: number;
  quickStart: string[] | undefined;
  operations: GroupedOperations | VerboseOperation[];
  guidance: string;
  escalation: string;
}

/** Tier guidance descriptions. */
const TIER_GUIDANCE: Record<number, string> = {
  0: 'Tier 0: Core task and session operations (tasks, session, admin). 80% of use cases.',
  1: 'Tier 1: + memory/research and check/validate operations. 15% of use cases.',
  2: 'Tier 2: Full access including pipeline, orchestrate, tools, nexus. 5% of use cases.',
};

/** Quick-start commands for tier 0. */
const TIER_0_QUICKSTART = [
  'query tasks.current \u2014 check active task (~100 tokens)',
  'query tasks.next \u2014 get suggestion (~300 tokens)',
  'query tasks.find {query} \u2014 search tasks (~200 tokens)',
  'mutate tasks.start {taskId} \u2014 begin work (~100 tokens)',
  'mutate tasks.complete {taskId} \u2014 finish task (~200 tokens)',
];

/** Operations known to be expensive. */
const HEAVY_OPS = new Set([
  'tasks.list',
  'tasks.tree',
  'admin.log',
  'admin.stats',
  'tasks.analyze',
]);

/** Operations known to be moderately expensive. */
const MODERATE_OPS = new Set([
  'tasks.show',
  'tasks.blockers',
  'tasks.depends',
  'admin.health',
  'admin.dash',
  'admin.help',
]);

/**
 * Determine cost hint for an operation based on domain and operation name.
 */
export function getCostHint(domain: string, operation: string): CostHint {
  const key = `${domain}.${operation}`;
  if (HEAVY_OPS.has(key)) return 'heavy';
  if (MODERATE_OPS.has(key)) return 'moderate';
  return 'minimal';
}

/**
 * Group operations by domain into a compact format.
 *
 * @param ops - Operations filtered to the requested tier
 * @returns Domain-grouped operations with query and mutate arrays
 */
export function groupOperationsByDomain(ops: HelpOperationDef[]): GroupedOperations {
  const grouped: GroupedOperations = {};
  for (const op of ops) {
    if (!grouped[op.domain]) grouped[op.domain] = { query: [], mutate: [] };
    grouped[op.domain][op.gateway].push(op.operation);
  }
  return grouped;
}

/**
 * Build verbose operation entries with cost hints.
 *
 * @param ops - Operations filtered to the requested tier
 * @returns Array of verbose operation objects
 */
export function buildVerboseOperations(ops: HelpOperationDef[]): VerboseOperation[] {
  return ops.map((op) => ({
    gateway: op.gateway,
    domain: op.domain,
    operation: op.operation,
    description: op.description,
    costHint: getCostHint(op.domain, op.operation),
  }));
}

/**
 * Compute the help result for the admin.help operation.
 *
 * Accepts the full OPERATIONS registry and filters/formats based on tier
 * and verbosity. This is pure business logic with no dispatch or engine
 * dependencies.
 *
 * @param allOperations - The full operation registry
 * @param tier - The tier level to filter to (0, 1, or 2)
 * @param verbose - Whether to return full operation objects or compact grouped format
 * @returns The computed help result
 */
export function computeHelp(
  allOperations: HelpOperationDef[],
  tier: number,
  verbose: boolean,
): HelpResult {
  const ops = allOperations.filter((op) => op.tier <= tier);

  return {
    tier,
    operationCount: ops.length,
    quickStart: tier === 0 ? TIER_0_QUICKSTART : undefined,
    operations: verbose ? buildVerboseOperations(ops) : groupOperationsByDomain(ops),
    guidance: TIER_GUIDANCE[tier] ?? TIER_GUIDANCE[0]!,
    escalation:
      tier < 2
        ? `For more operations: query({domain:"admin",operation:"help",params:{tier:${tier + 1}}})`
        : 'Full operation set displayed. Pass verbose:true for detailed object list.',
  };
}
