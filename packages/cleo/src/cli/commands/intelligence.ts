/**
 * Intelligence CLI commands — Predictive Quality Analysis
 *
 * Commands:
 *   cleo intelligence predict --task <id> [--stage <stage>] [--json]
 *   cleo intelligence suggest --task <id> [--json]
 *   cleo intelligence learn-errors [--limit <n>] [--json]
 *   cleo intelligence confidence --task <id> [--json]
 *   cleo intelligence match --task <id> [--json]
 *
 * @task T549
 * @epic T5149
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo intelligence predict — calculate risk score or predict validation outcome */
const predictCommand = defineCommand({
  meta: {
    name: 'predict',
    description: 'Calculate risk score for a task, or predict validation outcome for a stage',
  },
  args: {
    task: {
      type: 'string',
      description: 'Task ID to assess',
      required: true,
    },
    stage: {
      type: 'string',
      description: 'Lifecycle stage for validation outcome prediction',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'intelligence',
      'predict',
      { taskId: args.task, stage: args.stage as string | undefined },
      { command: 'intelligence', operation: 'intelligence.predict' },
    );
  },
});

/** cleo intelligence suggest — suggest verification gate focus for a task */
const suggestCommand = defineCommand({
  meta: { name: 'suggest', description: 'Suggest verification gate focus for a task' },
  args: {
    task: {
      type: 'string',
      description: 'Task ID to analyze',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'intelligence',
      'suggest',
      { taskId: args.task },
      { command: 'intelligence', operation: 'intelligence.suggest' },
    );
  },
});

/** cleo intelligence learn-errors — extract recurring failure patterns */
const learnErrorsCommand = defineCommand({
  meta: {
    name: 'learn-errors',
    description: 'Extract recurring failure patterns from task and brain history',
  },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum number of patterns to return',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'intelligence',
      'learn-errors',
      { limit: args.limit !== undefined ? Number.parseInt(args.limit, 10) : undefined },
      { command: 'intelligence', operation: 'intelligence.learn-errors' },
    );
  },
});

/** cleo intelligence confidence — score verification confidence for a task */
const confidenceCommand = defineCommand({
  meta: {
    name: 'confidence',
    description: 'Score verification confidence for a task based on its current gate state',
  },
  args: {
    task: {
      type: 'string',
      description: 'Task ID to score',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'intelligence',
      'confidence',
      { taskId: args.task },
      { command: 'intelligence', operation: 'intelligence.confidence' },
    );
  },
});

/** cleo intelligence match — match known brain patterns against a task */
const matchCommand = defineCommand({
  meta: { name: 'match', description: 'Match known brain patterns against a task' },
  args: {
    task: {
      type: 'string',
      description: 'Task ID to match',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'intelligence',
      'match',
      { taskId: args.task },
      { command: 'intelligence', operation: 'intelligence.match' },
    );
  },
});

/**
 * Root intelligence command group — predictive intelligence and quality analysis.
 *
 * All sub-commands dispatch via the IntelligenceHandler (query gateway).
 * Output is in LAFS envelope format when --json is used.
 */
export const intelligenceCommand = defineCommand({
  meta: { name: 'intelligence', description: 'Predictive intelligence and quality analysis' },
  subCommands: {
    predict: predictCommand,
    suggest: suggestCommand,
    'learn-errors': learnErrorsCommand,
    confidence: confidenceCommand,
    match: matchCommand,
  },
});
