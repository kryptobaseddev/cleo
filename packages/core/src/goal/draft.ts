/**
 * `cleo goal draft` — write a goal/v1 contract draft from tasks' acceptance
 * criteria, for a goal runtime (OpenCode-Goal) to execute.
 *
 * Each criterion maps to one goal criterion that `proves` it:
 * - typed `test` / `command` / `lint` gates → host `command` checks;
 * - typed `file` gates → host `file` / `contains` checks (one per assertion);
 * - `manual` gates → `human` checks;
 * - free text (and gates the host cannot express) → `verifier` checks.
 *
 * Invariants are the project's resolved lint and typecheck commands; the
 * budget follows the task size; `.cleo/` is protected. Drafting never starts
 * a run: it writes the one file and refuses to overwrite an existing one.
 *
 * @epic T13791
 * @task T13793
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  AcceptanceGate,
  AcRow,
  GoalAcRef,
  GoalCheck,
  GoalContract,
  GoalCriterion,
  Task,
  TaskSize,
} from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { GOAL_CONTRACT_SCHEMA } from '@cleocode/contracts/goal-contract.js';
import { stringify } from 'yaml';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { getProjectRoot } from '../paths.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { joinCommandLine } from '../tasks/command-line.js';
import { resolveToolCommand } from '../tasks/tool-resolver.js';

/** One task and its stored criterion rows, the input of {@link buildGoalDraft}. */
export interface GoalDraftTask {
  /** The task. */
  task: Pick<Task, 'id' | 'title' | 'description' | 'size' | 'acceptance'>;
  /** Its criterion rows (any order). */
  rows: readonly Pick<AcRow, 'ordinal' | 'text'>[];
}

/** Result of {@link draftGoal}. */
export interface GoalDraftResult {
  /** Goal slug (the contract id and directory name). */
  slug: string;
  /** Absolute path of the written `goal.yaml`. */
  path: string;
  /** The drafted contract. */
  contract: GoalContract;
}

/** Turn and wall-clock budget per task size; the largest task wins. */
const SIZE_BUDGET: Record<TaskSize, { turns: number; wallMs: number }> = {
  small: { turns: 20, wallMs: 3_600_000 },
  medium: { turns: 40, wallMs: 10_800_000 },
  large: { turns: 80, wallMs: 28_800_000 },
};

/** Lint tool default arguments, as the typed lint gate runner applies them. */
const LINT_DEFAULT_ARGS: Record<string, string[]> = {
  biome: ['check', '.'],
  eslint: ['.'],
  tsc: ['--noEmit'],
};

/** A gate's command line, run from its `cwd` when it names one. */
function commandLine(command: string, args: readonly string[] | undefined, cwd?: string): string {
  const line = args?.length ? `${command} ${joinCommandLine(args)}` : command;
  return cwd && cwd !== '.' ? `cd ${joinCommandLine([cwd])} && ${line}` : line;
}

/** The checks a typed gate becomes; an empty list means a verifier asks instead. */
function gateChecks(gate: AcceptanceGate): GoalCheck[] {
  switch (gate.kind) {
    case 'test':
      return [
        {
          kind: 'command',
          run: commandLine(gate.command, gate.args, gate.cwd),
          expect: { exit: 0 },
        },
      ];
    case 'command':
      return [
        {
          kind: 'command',
          run: commandLine(gate.cmd, gate.args, gate.cwd),
          expect: {
            exit: gate.exitCode ?? 0,
            ...(gate.stdoutMatches ? { stdout_regex: gate.stdoutMatches } : {}),
          },
        },
      ];
    case 'lint':
      return [
        {
          kind: 'command',
          run: commandLine(gate.tool, gate.args ?? LINT_DEFAULT_ARGS[gate.tool], gate.cwd),
          expect: { exit: 0 },
        },
      ];
    case 'file': {
      const path = gate.path;
      if (!path) return [];
      const checks: GoalCheck[] = [];
      for (const a of gate.assertions) {
        if (a.type === 'exists') checks.push({ kind: 'file', path, exists: true });
        else if (a.type === 'absent') checks.push({ kind: 'file', path, exists: false });
        else if (a.type === 'contains') checks.push({ kind: 'contains', path, text: a.value });
        else if (a.type === 'matches') checks.push({ kind: 'contains', path, regex: a.regex });
        else if (a.type === 'nonEmpty')
          checks.push({
            kind: 'command',
            run: `test -s ${joinCommandLine([path])}`,
            expect: { exit: 0 },
          });
        // Byte-size and sha256 assertions have no host check kind.
        else return [];
      }
      return checks;
    }
    case 'manual':
      return [{ kind: 'human', ask: gate.prompt }];
    default:
      return [];
  }
}

/** Kebab-case goal slug from the task ids (OCG: `[a-z0-9][a-z0-9-]{0,63}`). */
function goalSlug(ids: readonly string[]): string {
  return ids.join('-').toLowerCase().slice(0, 64).replace(/-+$/, '');
}

/**
 * Build a goal/v1 contract from tasks' acceptance criteria. Pure.
 *
 * @param tasks - The tasks the goal serves, first is the primary.
 * @param invariantCommands - Resolved lint/typecheck command lines.
 * @returns The contract; every criterion `proves` the AC it came from.
 * @example
 * ```ts
 * const contract = buildGoalDraft([{ task, rows }], ['pnpm biome check .']);
 * ```
 */
export function buildGoalDraft(
  tasks: readonly GoalDraftTask[],
  invariantCommands: readonly string[],
): GoalContract {
  const ids = tasks.map((t) => t.task.id);
  const criteria: GoalCriterion[] = [];
  for (const { task, rows } of tasks) {
    const ordered = [...rows].sort((a, b) => a.ordinal - b.ordinal);
    (task.acceptance ?? []).forEach((item, index) => {
      // Criterion rows align with the acceptance list by position, as `cleo done --plan` reads them.
      const row = ordered[index];
      // Task ids keep their spelling (`T002`), as `satisfies:` atoms do.
      const proves = [`${task.id}#AC${row?.ordinal ?? index + 1}` as GoalAcRef];
      const statement = row?.text ?? (typeof item === 'string' ? item : item.description);
      const checks = typeof item === 'string' ? [] : gateChecks(item);
      const ask =
        typeof item === 'string'
          ? `Does the change satisfy this acceptance criterion of ${task.id}: "${statement}"? Quote the files that show it.`
          : `Does the change satisfy this ${item.kind} gate of ${task.id}: "${statement}"? Quote the files that show it.`;
      for (const check of checks.length ? checks : [{ kind: 'verifier', ask } as const]) {
        criteria.push({ id: `C${criteria.length + 1}`, statement, essential: true, check, proves });
      }
    });
  }
  const budget = tasks
    .map((t) => SIZE_BUDGET[t.task.size ?? 'medium'])
    .reduce((a, b) => (b.turns > a.turns ? b : a), SIZE_BUDGET.small);
  const primary = tasks[0]?.task;
  const title = (
    tasks.length === 1 && primary ? `${primary.id}: ${primary.title}` : `Tasks ${ids.join(', ')}`
  ).slice(0, 80);
  return {
    schema: GOAL_CONTRACT_SCHEMA,
    id: goalSlug(ids),
    title,
    intent: {
      verbatim: tasks
        .map(({ task }) =>
          [`${task.id}: ${task.title}`, task.description].filter(Boolean).join('\n'),
        )
        .join('\n\n'),
    },
    outcome: `Every acceptance criterion of ${ids.join(', ')} holds and its check proves it`,
    scope: { in: [], out: [] },
    non_goals: [`Changes outside the acceptance criteria of ${ids.join(', ')}`],
    constraints: [],
    criteria,
    invariants: invariantCommands.map((run, i) => ({
      id: `I${i + 1}`,
      statement: `${run} SHALL CONTINUE TO pass`,
      essential: true,
      check: { kind: 'command', run, expect: { exit: 0 } },
    })),
    cleo: { tasks: ids.map((id) => ({ id })) },
    protect: ['.cleo/**'],
    assumptions: [],
    plan: [],
    budget,
    stop: { escalate_when: [] },
    autonomy: {
      questions: 'defer',
      on_user_message: 'steer',
      on_interrupt: 'pause',
      amend: [],
      on_stall: 'pause',
    },
    verification: { mode: 'host+verifier', max_rejections: 3, read: [] },
    execution: {},
    meta: {},
  };
}

/**
 * Render a contract as `goal.yaml` text in OCG's YAML spelling (budget
 * `wall` as minutes, e.g. `"180m"`). Lines never fold, so a command stays one line.
 *
 * @param contract - The contract.
 * @returns YAML text.
 */
export function renderGoalYaml(contract: GoalContract): string {
  const { wallMs, ...budget } = contract.budget;
  const yamlBudget = wallMs ? { ...budget, wall: `${Math.round(wallMs / 60_000)}m` } : budget;
  return stringify({ ...contract, budget: yamlBudget }, { lineWidth: 0 });
}

/**
 * Draft a goal for tasks and write it, refusing to overwrite an existing file.
 *
 * @param taskIds - Task ids; the first names the goal.
 * @param opts - Project root and an explicit output path.
 * @returns The written path and contract, or the refusal.
 * @example
 * ```ts
 * const r = await draftGoal(['T123'], {});
 * if (r.success) console.log(r.data.path); // .opencode/goals/t123/goal.yaml
 * ```
 */
export async function draftGoal(
  taskIds: readonly string[],
  opts: { projectRoot?: string; out?: string } = {},
): Promise<EngineResult<GoalDraftResult>> {
  try {
    const root = opts.projectRoot ?? getProjectRoot();
    const accessor = await getTaskAccessor(root);
    const tasks: GoalDraftTask[] = [];
    for (const id of taskIds) {
      const task = await accessor.loadSingleTask(id);
      if (!task) {
        throw new CleoError(ExitCode.NOT_FOUND, `Task ${id} not found`, {
          fix: `cleo find "${id}"`,
        });
      }
      tasks.push({ task, rows: await accessor.getAcRows(id) });
    }
    const invariants = (['lint', 'typecheck'] as const).flatMap((tool) => {
      const r = resolveToolCommand(tool, root);
      return r.ok ? [joinCommandLine([r.command.cmd, ...r.command.args])] : [];
    });
    const contract = buildGoalDraft(tasks, invariants);
    const path = resolve(root, opts.out ?? join('.opencode', 'goals', contract.id, 'goal.yaml'));
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, renderGoalYaml(contract), { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `${path} already exists; a draft never overwrites a goal`,
        {
          fix: `Edit ${path}, or pass --out <path> to write the draft elsewhere`,
        },
      );
    }
    return engineSuccess({ slug: contract.id, path, contract });
  } catch (err) {
    return cleoErrorToEngineResult<GoalDraftResult>(
      err,
      'E_GOAL_DRAFT_FAILED',
      'cleo goal draft failed',
    );
  }
}
