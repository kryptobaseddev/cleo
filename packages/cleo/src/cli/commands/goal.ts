/**
 * CLI `cleo goal` — the agent-facing surface for CLEO's DB-persisted, per-agent,
 * evidence-gate-aware goal loop (Layer 4 of SG-COGNITIVE-SUBSTRATE).
 *
 * Every handler is a THIN dispatch into the core `goal.*` ops
 * (`@cleocode/core/goal`) — no business logic lives here, satisfying the CLI
 * package-boundary gate. Each subcommand returns a single LAFS envelope to
 * stdout (ADR-086) via `cliOutput`; diagnostics go to stderr via `cliError`.
 *
 * Subcommands:
 *   - `cleo goal set <intent> [--task T###] [--turns N]` — create the agent's
 *     goal. `--task` makes it an evidence-judged task-completion goal; without
 *     it the goal is fuzzy (LLM-judge fallback).
 *   - `cleo goal status` — the CURRENT agent's active goal (resolved per-agent
 *     via the env identity, so concurrent agents see their own goal).
 *   - `cleo goal subgoal <intent> [--task T###] [--turns N]` — create a child
 *     goal linked to the active goal via `parentGoalId`.
 *   - `cleo goal append <criterion>` — append an acceptance criterion to the
 *     active goal.
 *
 * @epic T11290 EP-CLEO-GOAL-SYSTEM
 * @task T11381
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import { ExitCode, type GoalKind, isValidGoalTargetTaskId } from '@cleocode/contracts';
import { getProjectRoot, goal } from '@cleocode/core';
import { defineCommand, showUsage } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/** Default turn budget when `--turns` is omitted. */
const DEFAULT_TURN_BUDGET = 10;

/**
 * Resolve a goal-kind from the optional `--task` flag. A valid `T###` id yields
 * an evidence-judged task-completion goal; absence yields a fuzzy goal.
 *
 * @internal
 */
function resolveGoalKind(task: unknown): { kind: GoalKind } | { error: string } {
  if (typeof task === 'string' && task.length > 0) {
    if (!isValidGoalTargetTaskId(task)) {
      return { error: `--task must be a valid task id (T + 1-7 digits) — got '${task}'` };
    }
    return { kind: { kind: 'task-completion', targetTaskId: task } };
  }
  return { kind: { kind: 'fuzzy' } };
}

/**
 * Parse the optional `--turns` flag into a positive integer budget.
 *
 * @internal
 */
function resolveTurnBudget(turns: unknown): number {
  const n = typeof turns === 'string' ? Number.parseInt(turns, 10) : Number(turns);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_TURN_BUDGET;
}

const setCommand = defineCommand({
  meta: {
    name: 'set',
    description: "Set the current agent's goal (evidence-judged when --task given).",
  },
  args: {
    intent: { type: 'positional', description: 'What the agent is trying to achieve' },
    task: { type: 'string', description: 'Target task id (T###) — makes it evidence-judged' },
    turns: { type: 'string', description: 'Turn budget (default 10)' },
  },
  async run({ args }) {
    const intent = String(args.intent ?? '').trim();
    if (intent.length === 0) {
      cliError('goal set requires an <intent>', ExitCode.VALIDATION_ERROR, {
        name: 'E_VALIDATION',
      });
      return;
    }
    const kindResult = resolveGoalKind(args.task);
    if ('error' in kindResult) {
      cliError(kindResult.error, ExitCode.VALIDATION_ERROR, { name: 'E_VALIDATION' });
      return;
    }
    const record = await goal.createGoal(
      { goalKind: kindResult.kind, intent, turnBudget: resolveTurnBudget(args.turns) },
      getProjectRoot(),
    );
    cliOutput(record, { command: 'goal set', operation: 'goal.set' });
  },
});

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: "Show the current agent's active goal (per-agent scoped).",
  },
  async run() {
    const record = await goal.getActiveGoal(getProjectRoot());
    cliOutput(record ?? { active: null }, { command: 'goal status', operation: 'goal.status' });
  },
});

const subgoalCommand = defineCommand({
  meta: {
    name: 'subgoal',
    description: 'Create a sub-goal linked to the active goal via parentGoalId.',
  },
  args: {
    intent: { type: 'positional', description: 'The sub-goal intent' },
    task: { type: 'string', description: 'Target task id (T###) — makes it evidence-judged' },
    turns: { type: 'string', description: 'Turn budget (default 10)' },
  },
  async run({ args }) {
    const intent = String(args.intent ?? '').trim();
    if (intent.length === 0) {
      cliError('goal subgoal requires an <intent>', ExitCode.VALIDATION_ERROR, {
        name: 'E_VALIDATION',
      });
      return;
    }
    const cwd = getProjectRoot();
    const parent = await goal.getActiveGoal(cwd);
    if (!parent) {
      cliError(
        'No active goal to attach a sub-goal to. Run `cleo goal set` first.',
        ExitCode.NOT_FOUND,
        {
          name: 'E_NOT_FOUND',
        },
      );
      return;
    }
    const kindResult = resolveGoalKind(args.task);
    if ('error' in kindResult) {
      cliError(kindResult.error, ExitCode.VALIDATION_ERROR, { name: 'E_VALIDATION' });
      return;
    }
    const record = await goal.createGoal(
      {
        goalKind: kindResult.kind,
        intent,
        turnBudget: resolveTurnBudget(args.turns),
        parentGoalId: parent.id,
      },
      cwd,
    );
    cliOutput(record, { command: 'goal subgoal', operation: 'goal.subgoal' });
  },
});

const appendCommand = defineCommand({
  meta: {
    name: 'append',
    description: 'Append an acceptance criterion to the active goal.',
  },
  args: {
    criterion: { type: 'positional', description: 'The criterion text to append' },
  },
  async run({ args }) {
    const criterion = String(args.criterion ?? '').trim();
    if (criterion.length === 0) {
      cliError('goal append requires a <criterion>', ExitCode.VALIDATION_ERROR, {
        name: 'E_VALIDATION',
      });
      return;
    }
    const cwd = getProjectRoot();
    const active = await goal.getActiveGoal(cwd);
    if (!active) {
      cliError(
        'No active goal to append a criterion to. Run `cleo goal set` first.',
        ExitCode.NOT_FOUND,
        {
          name: 'E_NOT_FOUND',
        },
      );
      return;
    }
    const record = await goal.appendCriteria(active.id, criterion, cwd);
    cliOutput(record ?? { active: null }, { command: 'goal append', operation: 'goal.append' });
  },
});

/**
 * Parent `cleo goal` command — routes to the set/status/subgoal/append
 * subcommands; prints usage when invoked bare.
 *
 * @task T11381
 */
export const goalCommand = defineCommand({
  meta: {
    name: 'goal',
    description:
      'DB-persisted, per-agent, evidence-gate-aware goal loop (set/status/subgoal/append).',
  },
  subCommands: {
    set: setCommand,
    status: statusCommand,
    subgoal: subgoalCommand,
    append: appendCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
