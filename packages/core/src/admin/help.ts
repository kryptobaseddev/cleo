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

/** Help topic content and related commands (system-level static help). */
export interface HelpData {
  /** Topic identifier. */
  topic?: string;
  /** Human-readable help content. */
  content: string;
  /** Related CLI commands for cross-reference. */
  relatedCommands?: string[];
}

/** Static help topic dictionary for the system domain. */
export const SYSTEM_HELP_TOPICS: Record<string, HelpData> = {
  session: {
    topic: 'session',
    content: [
      'Session Management',
      '',
      '  cleo session list                        - List all sessions',
      '  cleo session start --scope epic:T001     - Start session',
      '  cleo session end --note "Progress"       - End session',
      '  cleo session resume <id>                 - Resume session',
    ].join('\n'),
    relatedCommands: ['cleo session list', 'cleo session start', 'cleo session end'],
  },
  tasks: {
    topic: 'tasks',
    content: [
      'Task Operations',
      '',
      '  cleo add "Title" --desc "Description"    - Create task',
      '  cleo update T1234 --status active        - Update task',
      '  cleo complete T1234                      - Complete task',
      '  cleo find "query"                        - Search tasks',
      '  cleo show T1234                          - Show task details',
    ].join('\n'),
    relatedCommands: ['cleo add', 'cleo update', 'cleo complete', 'cleo find', 'cleo show'],
  },
  focus: {
    topic: 'focus',
    content: [
      'Task Work Management',
      '',
      '  cleo start T1234    - Start working on task',
      '  cleo current        - Show current task',
      '  cleo stop           - Stop working on current task',
    ].join('\n'),
    relatedCommands: ['cleo start', 'cleo current', 'cleo stop'],
  },
  labels: {
    topic: 'labels',
    content: [
      'Label Operations',
      '',
      '  cleo labels              - List all labels',
      '  cleo labels show <name>  - Show tasks with label',
    ].join('\n'),
    relatedCommands: ['cleo labels'],
  },
  compliance: {
    topic: 'compliance',
    content: [
      'Compliance Monitoring',
      '',
      '  cleo compliance summary     - Compliance overview',
      '  cleo compliance violations  - List violations',
      '  cleo compliance trend       - Compliance trend',
    ].join('\n'),
    relatedCommands: ['cleo compliance summary', 'cleo compliance violations'],
  },
};

/**
 * Get static system help content for a given topic or general overview.
 *
 * Replaces `systemHelp` from system-engine.ts, moving the static HELP_TOPICS
 * dictionary and lookup logic into core/admin/help.ts.
 *
 * @param topic - Optional topic name to look up; returns overview if omitted
 * @returns Help content for the requested topic or general overview
 *
 * @task T1571
 */
export function getSystemHelp(topic?: string): HelpData {
  if (topic) {
    const topicHelp = SYSTEM_HELP_TOPICS[topic];
    if (topicHelp) return topicHelp;
    return {
      content: `Unknown help topic: ${topic}. Available topics: ${Object.keys(SYSTEM_HELP_TOPICS).join(', ')}`,
    };
  }

  return {
    content: [
      'CLEO Task Management System',
      '',
      'Essential Commands:',
      '  cleo find "query"    - Fuzzy search tasks',
      '  cleo show T1234      - Full task details',
      '  cleo add "Task"      - Create task',
      '  cleo done <id>       - Complete task',
      '  cleo start <id>      - Start working on task',
      '  cleo dash            - Project overview',
      '  cleo session list    - List sessions',
      '',
      'Help Topics: session, tasks, focus, labels, compliance',
    ].join('\n'),
    relatedCommands: ['cleo find', 'cleo show', 'cleo add', 'cleo done', 'cleo dash'],
  };
}
