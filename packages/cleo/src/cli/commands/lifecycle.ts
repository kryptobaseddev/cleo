/**
 * CLI command group for the RCASD-IVTR+C lifecycle pipeline.
 *
 * Exposes 10 subcommands:
 *   cleo lifecycle show <epicId>           — show lifecycle state
 *   cleo lifecycle start <epicId> <stage>  — start a stage
 *   cleo lifecycle complete <epicId> <stage> — complete a stage
 *   cleo lifecycle skip <epicId> <stage>   — skip a stage (--reason required)
 *   cleo lifecycle gate <epicId> <stage>   — check lifecycle gate
 *   cleo lifecycle guidance [stage]        — get stage-aware LLM prompt guidance
 *   cleo lifecycle history <taskId>        — show full stage history
 *   cleo lifecycle reset <epicId> <stage>  — reset a stage (--reason required)
 *   cleo lifecycle gate-record pass ...    — record a gate as passed
 *   cleo lifecycle gate-record fail ...    — record a gate as failed
 *
 * @task T4467
 * @epic T4454
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';

const VALID_STAGES =
  'research|consensus|architecture_decision|specification|decomposition|implementation|validation|testing|release|contribution';

/** cleo lifecycle show <epicId> — show lifecycle state for an epic */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show lifecycle state for an epic' },
  args: {
    epicId: { type: 'positional', description: 'Epic ID', required: true },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'stage.status',
      { epicId: args.epicId },
      { command: 'lifecycle' },
    );
  },
});

/** cleo lifecycle start <epicId> <stage> — start a lifecycle stage */
const startCommand = defineCommand({
  meta: {
    name: 'start',
    description: `Start a lifecycle stage. Valid stages: ${VALID_STAGES}`,
  },
  args: {
    epicId: { type: 'positional', description: 'Epic ID', required: true },
    stage: { type: 'positional', description: 'Stage name', required: true },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'stage.record',
      { taskId: args.epicId, stage: args.stage, status: 'in_progress' },
      { command: 'lifecycle' },
    );
  },
});

/** cleo lifecycle complete <epicId> <stage> — complete a lifecycle stage */
const completeCommand = defineCommand({
  meta: {
    name: 'complete',
    description: `Complete a lifecycle stage. Valid stages: ${VALID_STAGES}`,
  },
  args: {
    epicId: { type: 'positional', description: 'Epic ID', required: true },
    stage: { type: 'positional', description: 'Stage name', required: true },
    artifacts: { type: 'string', description: 'Comma-separated artifact paths' },
    notes: { type: 'string', description: 'Completion notes' },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'stage.record',
      {
        taskId: args.epicId,
        stage: args.stage,
        status: 'completed',
        notes: args.notes,
      },
      { command: 'lifecycle' },
    );
  },
});

/** cleo lifecycle skip <epicId> <stage> — skip a lifecycle stage */
const skipCommand = defineCommand({
  meta: {
    name: 'skip',
    description: `Skip a lifecycle stage. Valid stages: ${VALID_STAGES}`,
  },
  args: {
    epicId: { type: 'positional', description: 'Epic ID', required: true },
    stage: { type: 'positional', description: 'Stage name', required: true },
    reason: { type: 'string', description: 'Reason for skipping', required: true },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'stage.skip',
      { taskId: args.epicId, stage: args.stage, reason: args.reason },
      { command: 'lifecycle' },
    );
  },
});

/** cleo lifecycle gate <epicId> <stage> — check lifecycle gate for a stage */
const gateCommand = defineCommand({
  meta: { name: 'gate', description: 'Check lifecycle gate for a stage' },
  args: {
    epicId: { type: 'positional', description: 'Epic ID', required: true },
    stage: { type: 'positional', description: 'Stage name', required: true },
  },
  async run({ args }) {
    const result = await dispatchRaw('query', 'pipeline', 'stage.validate', {
      epicId: args.epicId,
      targetStage: args.stage,
    });
    if (result.success) {
      const { cliOutput } = await import('../renderers/index.js');
      cliOutput(result.data, { command: 'lifecycle' });
      const data = result.data as Record<string, unknown> | undefined;
      if (data && !data['canProgress']) {
        process.exit(80);
      }
    } else {
      handleRawError(result, { command: 'lifecycle', operation: 'pipeline.stage.validate' });
    }
  },
});

/** cleo lifecycle guidance [stage] — get stage-aware LLM prompt guidance */
const guidanceCommand = defineCommand({
  meta: {
    name: 'guidance',
    description:
      'Get stage-aware LLM prompt guidance (Phase 2). Pi extensions shell out to this on before_agent_start.',
  },
  args: {
    stage: { type: 'positional', description: 'Stage name (optional)', required: false },
    epicId: {
      type: 'string',
      description: 'Resolve stage from current epic pipeline status if no stage arg',
    },
    format: { type: 'string', description: 'Output format: markdown | json', default: 'markdown' },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'stage.guidance',
      {
        stage: args.stage,
        epicId: args.epicId,
        format: args.format,
      },
      { command: 'lifecycle' },
    );
  },
});

/** cleo lifecycle history <taskId> — show full lifecycle stage history */
const historyCommand = defineCommand({
  meta: { name: 'history', description: 'Show full lifecycle stage history for a task or epic' },
  args: {
    taskId: { type: 'positional', description: 'Task or epic ID', required: true },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'stage.history',
      { taskId: args.taskId },
      { command: 'lifecycle' },
    );
  },
});

/** cleo lifecycle reset <epicId> <stage> — reset a lifecycle stage back to pending */
const resetCommand = defineCommand({
  meta: {
    name: 'reset',
    description: `Reset a lifecycle stage back to pending. Valid stages: ${VALID_STAGES}`,
  },
  args: {
    epicId: { type: 'positional', description: 'Epic ID', required: true },
    stage: { type: 'positional', description: 'Stage name', required: true },
    reason: { type: 'string', description: 'Reason for resetting the stage', required: true },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'stage.reset',
      { taskId: args.epicId, stage: args.stage, reason: args.reason },
      { command: 'lifecycle' },
    );
  },
});

/** cleo lifecycle gate-record pass <epicId> <gateName> — record a gate as passed */
const gateRecordPassCommand = defineCommand({
  meta: { name: 'pass', description: 'Record a gate as passed for a lifecycle stage' },
  args: {
    epicId: { type: 'positional', description: 'Epic ID', required: true },
    gateName: { type: 'positional', description: 'Gate name', required: true },
    agent: { type: 'string', description: 'Agent that performed the gate check' },
    notes: { type: 'string', description: 'Notes on gate outcome' },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'stage.gate.pass',
      {
        taskId: args.epicId,
        gateName: args.gateName,
        agent: args.agent,
        notes: args.notes,
      },
      { command: 'lifecycle' },
    );
  },
});

/** cleo lifecycle gate-record fail <epicId> <gateName> — record a gate as failed */
const gateRecordFailCommand = defineCommand({
  meta: { name: 'fail', description: 'Record a gate as failed for a lifecycle stage' },
  args: {
    epicId: { type: 'positional', description: 'Epic ID', required: true },
    gateName: { type: 'positional', description: 'Gate name', required: true },
    reason: { type: 'string', description: 'Reason the gate failed' },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'stage.gate.fail',
      {
        taskId: args.epicId,
        gateName: args.gateName,
        reason: args.reason,
      },
      { command: 'lifecycle' },
    );
  },
});

/** cleo lifecycle gate-record — record a gate pass or fail for a lifecycle stage */
const gateRecordCommand = defineCommand({
  meta: { name: 'gate-record', description: 'Record a gate pass or fail for a lifecycle stage' },
  subCommands: {
    pass: gateRecordPassCommand,
    fail: gateRecordFailCommand,
  },
});

/**
 * Root lifecycle command group — RCASD-IVTR+C lifecycle pipeline management.
 *
 * Dispatches all stage operations to the `pipeline` dispatch domain.
 */
export const lifecycleCommand = defineCommand({
  meta: { name: 'lifecycle', description: 'RCASD-IVTR+C lifecycle pipeline management' },
  subCommands: {
    show: showCommand,
    start: startCommand,
    complete: completeCommand,
    skip: skipCommand,
    gate: gateCommand,
    guidance: guidanceCommand,
    history: historyCommand,
    reset: resetCommand,
    'gate-record': gateRecordCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
