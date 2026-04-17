/**
 * CLI command group: cleo compliance — compliance metrics and enforcement.
 *
 * Monitors and reports compliance metrics for orchestrator and agent outputs.
 *
 * Subcommands:
 *   cleo compliance summary              — aggregate stats (default)
 *   cleo compliance violations           — list violations
 *   cleo compliance trend [days]         — show trend over N days
 *   cleo compliance audit <taskId>       — check compliance for a task
 *   cleo compliance sync                 — sync metrics to global aggregation
 *   cleo compliance skills               — per-skill/agent reliability stats
 *   cleo compliance value [days]         — VALUE PROOF: token savings and impact
 *   cleo compliance record <taskId> <result> — record a check result
 *
 * @task T4535
 * @task T476
 * @epic T4454
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo compliance summary — aggregate compliance stats */
const summaryCommand = defineCommand({
  meta: { name: 'summary', description: 'Aggregate compliance stats (default)' },
  args: {
    since: {
      type: 'string',
      description: 'Filter metrics from this date (ISO 8601)',
    },
    agent: {
      type: 'string',
      description: 'Filter by agent/skill ID',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'compliance.summary',
      {
        since: args.since as string | undefined,
        agent: args.agent as string | undefined,
      },
      { command: 'compliance' },
    );
  },
});

/** cleo compliance violations — list compliance violations */
const violationsCommand = defineCommand({
  meta: { name: 'violations', description: 'List compliance violations' },
  args: {
    severity: {
      type: 'string',
      description: 'Filter by severity (low|medium|high|critical)',
    },
    since: {
      type: 'string',
      description: 'Filter from date',
    },
    agent: {
      type: 'string',
      description: 'Filter by agent ID',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'compliance.summary',
      {
        detail: true,
        severity: args.severity as string | undefined,
        since: args.since as string | undefined,
        agent: args.agent as string | undefined,
      },
      { command: 'compliance' },
    );
  },
});

/** cleo compliance trend — show compliance trend over N days */
const trendCommand = defineCommand({
  meta: { name: 'trend', description: 'Show compliance trend over N days' },
  args: {
    days: {
      type: 'positional',
      description: 'Number of days to include (default: 7)',
      required: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'compliance.summary',
      {
        type: 'trend',
        days: args.days !== undefined ? Number.parseInt(args.days, 10) : 7,
      },
      { command: 'compliance' },
    );
  },
});

/** cleo compliance audit — check compliance for a specific task and its subtasks */
const auditCommand = defineCommand({
  meta: {
    name: 'audit',
    description: 'Check compliance for a specific task and its subtasks',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to audit',
      required: true,
    },
    since: {
      type: 'string',
      description: 'Filter from date',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'compliance.summary',
      {
        type: 'audit',
        taskId: args.taskId,
        since: args.since as string | undefined,
      },
      { command: 'compliance' },
    );
  },
});

/** cleo compliance sync — sync project metrics to global aggregation */
const syncCommand = defineCommand({
  meta: { name: 'sync', description: 'Sync project metrics to global aggregation' },
  args: {
    force: {
      type: 'boolean',
      description: 'Force full sync',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'check',
      'compliance.sync',
      {
        force: args.force,
      },
      { command: 'compliance' },
    );
  },
});

/** cleo compliance skills — per-skill/agent reliability stats */
const skillsCommand = defineCommand({
  meta: { name: 'skills', description: 'Per-skill/agent reliability stats' },
  args: {
    global: {
      type: 'boolean',
      description: 'Use global metrics file',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'compliance.summary',
      {
        type: 'skills',
        global: args.global,
      },
      { command: 'compliance' },
    );
  },
});

/** cleo compliance value — VALUE PROOF: token savings and validation impact */
const valueCommand = defineCommand({
  meta: { name: 'value', description: 'VALUE PROOF: Token savings & validation impact' },
  args: {
    days: {
      type: 'positional',
      description: 'Number of days to include (default: 7)',
      required: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'compliance.summary',
      {
        type: 'value',
        days: args.days !== undefined ? Number.parseInt(args.days, 10) : 7,
      },
      { command: 'compliance' },
    );
  },
});

/** cleo compliance record — record a compliance check result for a task */
const recordCommand = defineCommand({
  meta: {
    name: 'record',
    description: 'Record a compliance check result for a task (pass|fail|warning)',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to record result for',
      required: true,
    },
    result: {
      type: 'positional',
      description: 'Result value (pass|fail|warning)',
      required: true,
    },
    protocol: {
      type: 'string',
      description: 'Protocol name the check applies to (e.g. implementation)',
    },
    violation: {
      type: 'string',
      description: 'Add a violation as "code:severity:message"',
    },
  },
  async run({ args }) {
    const rawViolation = args.violation as string | undefined;
    const rawViolations: string[] = rawViolation !== undefined ? [rawViolation] : [];
    const violations = rawViolations
      .map((v) => {
        const [code, severity, ...rest] = v.split(':');
        return {
          code: code ?? '',
          severity: (severity === 'error' || severity === 'warning' ? severity : 'error') as
            | 'error'
            | 'warning',
          message: rest.join(':'),
        };
      })
      .filter((v) => v.code);
    await dispatchFromCli(
      'mutate',
      'check',
      'compliance.record',
      {
        taskId: args.taskId,
        result: args.result,
        protocol: args.protocol as string | undefined,
        violations: violations.length > 0 ? violations : undefined,
      },
      { command: 'compliance', operation: 'check.compliance.record' },
    );
  },
});

/**
 * Root compliance command group.
 *
 * Monitors and reports compliance metrics for orchestrator and agent outputs.
 * Dispatches to `check.compliance.*` registry operations.
 */
export const complianceCommand = defineCommand({
  meta: {
    name: 'compliance',
    description: 'Monitor and report compliance metrics for orchestrator and agent outputs',
  },
  subCommands: {
    summary: summaryCommand,
    violations: violationsCommand,
    trend: trendCommand,
    audit: auditCommand,
    sync: syncCommand,
    skills: skillsCommand,
    value: valueCommand,
    record: recordCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
