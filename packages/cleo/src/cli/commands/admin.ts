/**
 * CLI command group for system administration and diagnostics.
 *
 * Provides CLI access to admin.version, admin.health, admin.stats,
 * admin.runtime, admin.smoke, admin.paths, admin.scaffold-hub,
 * admin.cleanup, admin.job, admin.job.cancel, admin.install.global,
 * and admin.context.inject via `cleo admin <subcommand>`.
 *
 * The `job` subgroup uses an explicit parent `run()` that delegates to
 * `job list` when no subcommand is given (citty has no `isDefault` concept).
 *
 * @task T132
 * @task T480 — add cleanup, job, job.cancel, install.global, context.inject subcommands.
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo admin version — show CLEO version */
const versionCommand = defineCommand({
  meta: { name: 'version', description: 'Show CLEO version' },
  async run() {
    await dispatchFromCli('query', 'admin', 'version', {}, { command: 'admin' });
  },
});

/** cleo admin health — run system health check */
const healthCommand = defineCommand({
  meta: { name: 'health', description: 'Run system health check' },
  args: {
    detailed: {
      type: 'boolean',
      description: 'Show detailed results',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'health',
      { detailed: args.detailed },
      { command: 'admin' },
    );
  },
});

/** cleo admin stats — show project statistics */
const statsCommand = defineCommand({
  meta: { name: 'stats', description: 'Show project statistics' },
  args: {
    period: {
      type: 'string',
      description: 'Time period in days',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'stats',
      { period: args.period ? Number(args.period) : undefined },
      { command: 'admin' },
    );
  },
});

/** cleo admin runtime — show runtime diagnostics */
const runtimeCommand = defineCommand({
  meta: { name: 'runtime', description: 'Show runtime diagnostics' },
  args: {
    detailed: {
      type: 'boolean',
      description: 'Show detailed runtime info',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'runtime',
      { detailed: args.detailed },
      { command: 'admin' },
    );
  },
});

/** cleo admin smoke — run operational smoke tests or probe ADR-049 invariants */
const smokeCommand = defineCommand({
  meta: {
    name: 'smoke',
    description:
      'Run operational smoke tests across all domains, or probe ADR-049 invariants for a named provider (--provider)',
  },
  args: {
    provider: {
      type: 'string',
      description: 'Probe harness sovereignty invariants for a specific provider adapter (ADR-049)',
    },
  },
  async run({ args }) {
    const provider = args.provider as string | undefined;
    if (provider) {
      await dispatchFromCli(
        'query',
        'admin',
        'smoke.provider',
        { provider },
        { command: 'admin smoke', operation: 'admin.smoke.provider' },
      );
    } else {
      await dispatchFromCli('query', 'admin', 'smoke', {}, { command: 'admin' });
    }
  },
});

/** cleo admin paths — report all CleoOS paths and scaffolding status */
const pathsCommand = defineCommand({
  meta: {
    name: 'paths',
    description: 'Report all CleoOS paths (project + global hub) and scaffolding status',
  },
  async run() {
    await dispatchFromCli('query', 'admin', 'paths', {}, { command: 'admin' });
  },
});

/** cleo admin scaffold-hub — create CleoOS Hub dirs and seed starter justfile */
const scaffoldHubCommand = defineCommand({
  meta: {
    name: 'scaffold-hub',
    description:
      'Create CleoOS Hub dirs (global-recipes, pi-extensions, cant-workflows, agents) and seed starter justfile',
  },
  async run() {
    await dispatchFromCli('mutate', 'admin', 'scaffold-hub', {}, { command: 'admin' });
  },
});

/** cleo admin cleanup — purge stale CLEO data */
const cleanupCommand = defineCommand({
  meta: { name: 'cleanup', description: 'Purge stale CLEO data (backups, logs, archive entries)' },
  args: {
    target: {
      type: 'string',
      description: 'What to clean: backups | logs | archive | sessions',
      required: true,
    },
    'older-than': {
      type: 'string',
      description: 'Remove entries older than this duration (e.g. 30d, 6m, 1y)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview what would be removed without making changes',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'admin',
      'cleanup',
      {
        target: args.target as string,
        olderThan: args['older-than'] as string | undefined,
        dryRun: args['dry-run'] === true,
      },
      { command: 'admin cleanup', operation: 'admin.cleanup' },
    );
  },
});

/** cleo admin job list — list all background jobs */
const jobListCommand = defineCommand({
  meta: { name: 'list', description: 'List all background jobs (default)' },
  args: {
    status: {
      type: 'string',
      description: 'Filter by job status (pending, running, done, failed, cancelled)',
    },
    limit: {
      type: 'string',
      description: 'Maximum jobs to return',
      default: '20',
    },
    offset: {
      type: 'string',
      description: 'Skip N jobs',
      default: '0',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'job',
      {
        action: 'list',
        status: args.status as string | undefined,
        limit: args.limit ? Number(args.limit) : 20,
        offset: args.offset ? Number(args.offset) : 0,
      },
      { command: 'admin job list', operation: 'admin.job' },
    );
  },
});

/** cleo admin job status — show status of a specific background job */
const jobStatusCommand = defineCommand({
  meta: { name: 'status', description: 'Show status of a specific background job' },
  args: {
    jobId: {
      type: 'positional',
      description: 'Job ID to inspect',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'job',
      { action: 'status', jobId: args.jobId },
      { command: 'admin job status', operation: 'admin.job' },
    );
  },
});

/** cleo admin job cancel — cancel a running background job */
const jobCancelCommand = defineCommand({
  meta: { name: 'cancel', description: 'Cancel a running background job' },
  args: {
    jobId: {
      type: 'positional',
      description: 'Job ID to cancel',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'admin',
      'job.cancel',
      { jobId: args.jobId },
      { command: 'admin job cancel', operation: 'admin.job.cancel' },
    );
  },
});

/**
 * cleo admin job — inspect background jobs.
 *
 * Defaults to `job list` when no subcommand is provided (citty has no
 * `isDefault` concept; the parent `run()` replicates that behaviour).
 */
const jobCommand = defineCommand({
  meta: { name: 'job', description: 'Inspect background jobs managed by the job manager' },
  subCommands: {
    list: jobListCommand,
    status: jobStatusCommand,
    cancel: jobCancelCommand,
  },
  async run({ rawArgs }) {
    // No subcommand given — delegate to job list (mirrors isDefault behaviour)
    const hasSubCmd = rawArgs.some((a) => ['list', 'status', 'cancel'].includes(a));
    if (!hasSubCmd) {
      await dispatchFromCli(
        'query',
        'admin',
        'job',
        { action: 'list', limit: 20, offset: 0 },
        { command: 'admin job list', operation: 'admin.job' },
      );
    }
  },
});

/** cleo admin install-global — refresh global CLEO setup */
const installGlobalCommand = defineCommand({
  meta: {
    name: 'install-global',
    description: 'Refresh global CLEO setup (provider files, configs, ~/.agents/AGENTS.md)',
  },
  async run() {
    await dispatchFromCli(
      'mutate',
      'admin',
      'install.global',
      {},
      { command: 'admin install-global', operation: 'admin.install.global' },
    );
  },
});

/** cleo admin context-inject — inject protocol content into session context */
const contextInjectCommand = defineCommand({
  meta: {
    name: 'context-inject',
    description:
      'Inject protocol content into session context (e.g. cleo-base, ct-orchestrator, ct-cleo)',
  },
  args: {
    protocolType: {
      type: 'positional',
      description: 'Protocol type to inject',
      required: true,
    },
    task: {
      type: 'string',
      description: 'Scope injection to a specific task ID',
    },
    variant: {
      type: 'string',
      description: 'Select a named protocol variant',
    },
  },
  async run({ args }) {
    const protocolType = args.protocolType as string;
    if (!protocolType || protocolType.trim() === '') {
      console.error('Error: missing required argument <protocolType>');
      console.error(
        'Usage: cleo admin context-inject <protocolType> [--task <id>] [--variant <variant>]',
      );
      process.exit(1);
    }
    await dispatchFromCli(
      'mutate',
      'admin',
      'context.inject',
      {
        protocolType,
        taskId: args.task as string | undefined,
        variant: args.variant as string | undefined,
      },
      { command: 'admin context-inject', operation: 'admin.context.inject' },
    );
  },
});

/**
 * Root admin command group — registers all admin subcommands.
 *
 * Dispatches to the `admin` domain registry operations.
 *
 * @task T132
 * @task T480
 */
export const adminCommand = defineCommand({
  meta: { name: 'admin', description: 'System administration and diagnostics' },
  subCommands: {
    version: versionCommand,
    health: healthCommand,
    stats: statsCommand,
    runtime: runtimeCommand,
    smoke: smokeCommand,
    paths: pathsCommand,
    'scaffold-hub': scaffoldHubCommand,
    cleanup: cleanupCommand,
    job: jobCommand,
    'install-global': installGlobalCommand,
    'context-inject': contextInjectCommand,
  },
});
