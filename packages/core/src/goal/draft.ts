/**
 * `cleo goal draft` — write a goal/v1 contract draft from tasks' acceptance
 * criteria, for a goal runtime (OpenCode-Goal) to execute.
 *
 * Each criterion maps to goal criteria that `prove` it (by its canonical
 * uuid), never weaker than the gate:
 * - a typed gate goal/v1 expresses exactly → host checks (`command` with the
 *   gate's own executable, cwd, env and deadline; `file` / `contains`);
 * - any other typed gate → the gate itself, `cleo verify <id> --run --req`;
 * - `manual` gates → `human` checks;
 * - free text, and a gate with neither form → `verifier` checks;
 * - `advisory: true` → `essential: false`.
 *
 * Invariants are the project's resolved lint and typecheck commands; the
 * budget follows the task size; `.cleo/` is protected. Drafting never starts
 * a run: it writes the one file and refuses to overwrite an existing one.
 *
 * @epic T13791
 * @task T13793
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
import { SATISFIES_TASK_ID_REGEX } from '@cleocode/contracts/evidence-atom-schema.js';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { GOAL_CONTRACT_SCHEMA } from '@cleocode/contracts/goal-contract.js';
import { stringify } from 'yaml';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { isWithin } from '../nexus/stored-roots.js';
import { getProjectRoot } from '../paths.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { joinCommandLine } from '../tasks/command-line.js';
import {
  executableInvocation,
  LINT_TOOL_DEFAULTS,
  resolveGateTimeoutMs,
} from '../tasks/gate-runner.js';
import { resolveToolCommand } from '../tasks/tool-resolver.js';

/** One task and its stored criterion rows, the input of {@link buildGoalDraft}. */
export interface GoalDraftTask {
  /** The task. */
  task: Pick<Task, 'id' | 'title' | 'description' | 'size' | 'acceptance'>;
  /** Its criterion rows (any order). */
  rows: readonly Pick<AcRow, 'id' | 'ordinal' | 'text'>[];
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

/** OCG goal ids: a kebab-case slug that equals the goal directory name. */
const GOAL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A process command as a shell line: `cd <cwd> && env K=V <words>`. */
function shellLine(words: readonly string[], cwd?: string, env?: Record<string, string>): string {
  const vars = Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`);
  const line = joinCommandLine(vars.length ? ['env', ...vars, ...words] : words);
  return cwd && cwd !== '.' ? `cd ${joinCommandLine([cwd])} && ${line}` : line;
}

/** The gate's own deadline in whole seconds (OCG `timeout`). */
function timeoutSeconds(gate: AcceptanceGate): number {
  return Math.ceil(resolveGateTimeoutMs(gate, {}) / 1000);
}

/**
 * Whether goal/v1 can express the gate exactly. Output scanning (`test`
 * `expect: 'pass'`, a lint `errorPattern` under `expect: 'clean'`), `minCount`,
 * `stderrMatches`, regex flags, byte sizes, sha256, attachments and http have
 * no host check, so such a gate runs as itself through `cleo verify --run`.
 */
function nativelyExpressible(gate: AcceptanceGate): boolean {
  switch (gate.kind) {
    case 'test':
      return gate.expect === 'exit0' && !gate.minCount;
    case 'command':
      return !gate.stderrMatches;
    case 'lint':
      return gate.expect === 'noErrors' || !LINT_TOOL_DEFAULTS[gate.tool].errorPattern;
    case 'file':
      return (
        gate.path !== undefined &&
        gate.assertions.every(
          (a) =>
            a.type === 'exists' ||
            a.type === 'absent' ||
            a.type === 'contains' ||
            a.type === 'nonEmpty' ||
            (a.type === 'matches' && !a.flags),
        )
      );
    default:
      return false;
  }
}

/** The native host checks of an expressible gate (see {@link nativelyExpressible}). */
function nativeChecks(gate: AcceptanceGate, root: string): GoalCheck[] {
  if (gate.kind === 'file') {
    const path = gate.path ?? '';
    return gate.assertions.map((a): GoalCheck => {
      if (a.type === 'exists') return { kind: 'file', path, exists: true };
      if (a.type === 'absent') return { kind: 'file', path, exists: false };
      if (a.type === 'contains') return { kind: 'contains', path, text: a.value };
      if (a.type === 'matches') return { kind: 'contains', path, regex: a.regex };
      return { kind: 'command', run: `test -s ${joinCommandLine([path])}`, expect: { exit: 0 } };
    });
  }
  const inv = executableInvocation(gate, root, {});
  if (!inv || (gate.kind !== 'test' && gate.kind !== 'command' && gate.kind !== 'lint')) return [];
  const env = gate.kind === 'lint' ? undefined : gate.env;
  return [
    {
      kind: 'command',
      run: shellLine([inv.command, ...inv.args], gate.cwd, env),
      expect: {
        exit: gate.kind === 'command' ? (gate.exitCode ?? 0) : 0,
        ...(gate.kind === 'command' && gate.stdoutMatches
          ? { stdout_regex: gate.stdoutMatches }
          : {}),
      },
      timeout: timeoutSeconds(gate),
    },
  ];
}

/**
 * The checks a typed gate becomes, never weaker than the gate: native host
 * checks when goal/v1 expresses it exactly, else the gate itself run by
 * `cleo verify --run --req` (selectable only by REQ-ID). A gate with neither
 * gets an empty list and the caller asks a verifier, which never satisfies a
 * gate at close.
 */
function gateChecks(taskId: string, gate: AcceptanceGate, root: string): GoalCheck[] {
  if (gate.kind === 'manual') return [{ kind: 'human', ask: gate.prompt }];
  if (nativelyExpressible(gate)) return nativeChecks(gate, root);
  if (!gate.req) return [];
  return [
    {
      kind: 'command',
      run: `cleo verify ${taskId} --run --req ${joinCommandLine([gate.req])} --field /data/passed`,
      expect: { exit: 0, stdout_regex: '^true\\s*$' },
      // The gate's deadline plus room for cleo's own bookkeeping.
      timeout: timeoutSeconds(gate) + 60,
    },
  ];
}

/** A readable statement for a gate: its description, else a summary. */
function gateStatement(gate: AcceptanceGate): string {
  if (gate.description.trim()) return gate.description.trim();
  switch (gate.kind) {
    case 'test':
      return `${gate.command} passes`;
    case 'command':
      return `${gate.cmd} exits ${gate.exitCode ?? 0}`;
    case 'lint':
      return `${gate.tool} reports no errors`;
    case 'file':
      return `${gate.path ?? 'the attachment'} satisfies ${gate.assertions.map((a) => a.type).join(', ')}`;
    case 'http':
      return `${gate.method ?? 'GET'} ${gate.url} returns ${gate.status}`;
    case 'manual':
      return gate.prompt;
  }
}

/** Goal slug from the task ids: whole ids only, at most 64 characters. */
function goalSlug(ids: readonly string[]): string {
  let slug = '';
  for (const id of ids.map((i) => i.toLowerCase())) {
    const next = slug ? `${slug}-${id}` : id;
    if (next.length > 64) break;
    slug = next;
  }
  return slug;
}

/**
 * Build a goal/v1 contract from tasks' acceptance criteria. Pure.
 *
 * @param tasks - The tasks the goal serves, first is the primary.
 * @param invariantCommands - Resolved lint/typecheck command lines.
 * @param opts - Project root (gate cwd and commands resolve against it) and an explicit goal id.
 * @returns The contract; every criterion `proves` the AC it came from.
 * @example
 * ```ts
 * const contract = buildGoalDraft([{ task, rows }], ['pnpm biome check .'], { root });
 * ```
 */
export function buildGoalDraft(
  tasks: readonly GoalDraftTask[],
  invariantCommands: readonly string[],
  opts: { root: string; id?: string },
): GoalContract {
  const ids = tasks.map((t) => t.task.id);
  const criteria: GoalCriterion[] = [];
  for (const { task, rows } of tasks) {
    const ordered = [...rows].sort((a, b) => a.ordinal - b.ordinal);
    (task.acceptance ?? []).forEach((item, index) => {
      // Criterion rows align with the acceptance list by position, as `cleo done --plan` reads them.
      const row = ordered[index];
      // The canonical criterion uuid survives renumbering; task ids keep their spelling (`T002`).
      const proves = [(row ? `${task.id}#${row.id}` : `${task.id}#AC${index + 1}`) as GoalAcRef];
      const gate = typeof item === 'string' ? null : item;
      const statement = gate ? gateStatement(gate) : (row?.text ?? String(item));
      const checks = gate ? gateChecks(task.id, gate, opts.root) : [];
      const ask = gate
        ? `This ${gate.kind} gate of ${task.id} cannot run as a host check (no REQ-ID to run it alone with cleo verify --run --req): ${JSON.stringify(gate)}. Does the change satisfy it? Quote the files that show it.`
        : `Does the change satisfy this acceptance criterion of ${task.id}: "${statement}"? Quote the files that show it.`;
      const essential = gate?.advisory !== true;
      for (const check of checks.length ? checks : [{ kind: 'verifier', ask } as const]) {
        criteria.push({ id: `C${criteria.length + 1}`, statement, essential, check, proves });
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
    id: opts.id ?? goalSlug(ids),
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
    const root = realpathSync(opts.projectRoot ?? getProjectRoot());
    const invalid = taskIds.filter((id) => !SATISFIES_TASK_ID_REGEX.test(id));
    if (taskIds.length === 0 || invalid.length > 0) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `goal draft needs task ids (T<1-7 digits>)${invalid.length ? `; got ${invalid.join(', ')}` : ''}`,
      );
    }
    // --out names the goal file; OCG requires the id to equal its directory name.
    const path = resolve(
      root,
      opts.out ?? join('.opencode', 'goals', goalSlug(taskIds), 'goal.yaml'),
    );
    const id = basename(dirname(path));
    if (basename(path) !== 'goal.yaml' || !GOAL_ID.test(id)) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `--out must name <dir>/goal.yaml where <dir> is the goal id (a-z, 0-9, hyphens); got ${path}`,
        { fix: 'cleo goal draft <taskId> --out .opencode/goals/<id>/goal.yaml' },
      );
    }
    // Writes stay inside the project, including through a symlinked parent.
    const refuseOutside = (): never => {
      throw new CleoError(ExitCode.VALIDATION_ERROR, `${path} is outside the project ${root}`);
    };
    if (!isWithin(root, path)) refuseOutside();
    const accessor = await getTaskAccessor(root);
    const tasks: GoalDraftTask[] = [];
    for (const taskId of taskIds) {
      const task = await accessor.loadSingleTask(taskId);
      if (!task) {
        throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`, {
          fix: `cleo find "${taskId}"`,
        });
      }
      tasks.push({ task, rows: await accessor.getAcRows(taskId) });
    }
    const invariants = (['lint', 'typecheck'] as const).flatMap((tool) => {
      const r = resolveToolCommand(tool, root);
      return r.ok ? [joinCommandLine([r.command.cmd, ...r.command.args])] : [];
    });
    const contract = buildGoalDraft(tasks, invariants, { root, id });
    let ancestor = dirname(path);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (!isWithin(root, realpathSync(ancestor))) refuseOutside();
    mkdirSync(dirname(path), { recursive: true });
    if (!isWithin(root, realpathSync(dirname(path)))) refuseOutside();
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
