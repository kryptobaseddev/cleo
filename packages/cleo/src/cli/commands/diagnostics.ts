/**
 * CLI diagnostics command group — dispatches to the diagnostics domain.
 *
 * Provides CLI access to:
 *   cleo diagnostics enable   — opt-in to anonymous telemetry
 *   cleo diagnostics disable  — opt-out
 *   cleo diagnostics status   — show current config
 *   cleo diagnostics analyze  — surface failing/slow commands, push to BRAIN
 *   cleo diagnostics export   — JSON dump for external analysis
 *
 * @task T624
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo diagnostics enable — opt in to anonymous command telemetry */
const enableCommand = defineCommand({
  meta: {
    name: 'enable',
    description: 'Opt in to anonymous command telemetry for self-improvement analysis',
  },
  async run() {
    await dispatchFromCli('mutate', 'diagnostics', 'enable', {}, { command: 'diagnostics' });
  },
});

/** cleo diagnostics disable — opt out of telemetry collection */
const disableCommand = defineCommand({
  meta: {
    name: 'disable',
    description: 'Opt out of telemetry collection (existing data is preserved)',
  },
  async run() {
    await dispatchFromCli('mutate', 'diagnostics', 'disable', {}, { command: 'diagnostics' });
  },
});

/** cleo diagnostics status — show telemetry opt-in state and database path */
const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show telemetry opt-in state and database path' },
  async run() {
    await dispatchFromCli('query', 'diagnostics', 'status', {}, { command: 'diagnostics' });
  },
});

/** cleo diagnostics analyze — aggregate telemetry patterns and push to BRAIN */
const analyzeCommand = defineCommand({
  meta: {
    name: 'analyze',
    description:
      'Aggregate telemetry patterns: top failing commands, slowest commands, BRAIN observations',
  },
  args: {
    days: {
      type: 'string',
      description: 'Analysis window in days (default: 30)',
      alias: 'd',
    },
    'no-brain': {
      type: 'boolean',
      description: 'Skip pushing high-signal patterns to BRAIN',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'diagnostics',
      'analyze',
      {
        days: args.days !== undefined ? Number.parseInt(args.days, 10) : 30,
        noBrain: args['no-brain'],
      },
      { command: 'diagnostics' },
    );
  },
});

/** cleo diagnostics export — export all telemetry events as JSON array */
const exportCommand = defineCommand({
  meta: {
    name: 'export',
    description: 'Export all telemetry events as a JSON array for external analysis',
  },
  args: {
    days: {
      type: 'string',
      description: 'Limit to last N days (default: all)',
      alias: 'd',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'diagnostics',
      'export',
      {
        days: args.days !== undefined ? Number.parseInt(args.days, 10) : undefined,
      },
      { command: 'diagnostics' },
    );
  },
});

/**
 * Root diagnostics command group — autonomous self-improvement telemetry.
 *
 * Opt-in command analytics that feed BRAIN observations.
 */
export const diagnosticsCommand = defineCommand({
  meta: {
    name: 'diagnostics',
    description:
      'Autonomous self-improvement telemetry — opt-in command analytics that feed BRAIN observations',
  },
  subCommands: {
    enable: enableCommand,
    disable: disableCommand,
    status: statusCommand,
    analyze: analyzeCommand,
    export: exportCommand,
  },
  async run({ cmd }) {
    await showUsage(cmd);
  },
});
