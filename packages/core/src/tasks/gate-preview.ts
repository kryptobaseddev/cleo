/**
 * Typed-gate PREVIEW — run a task's `AcceptanceGate[]` and report the results
 * without recording anything.
 *
 * ## Why this exists (gh#1468)
 *
 * Typed gates had exactly one way to execute: as a side effect of
 * `cleo verify <id> --gate <g> --evidence <atoms>`. Every typed gate on the
 * task ran, implicitly, during a call whose stated purpose was to ATTEST a
 * different gate — and the only way to discover whether they would pass was to
 * make that attestation.
 *
 * The explicit driver had been documented since T768 and is still emitted into
 * every validation-stage spawn prompt ("Run `cleo verify <id> --run` and
 * capture output"), but the flag was dropped from the command, so an agent
 * following CLEO's own instruction got `Unknown flag` and had no supported way
 * to ask the question. Restoring it as a read-only operation is what makes the
 * two surfaces agree: `--run` observes, `--evidence` attests.
 *
 * Nothing here persists. No verification record, no receipt, no gate state —
 * which is also why it does not need the criterion bindings `runTaskGates`
 * builds: a result that is never stored cannot be mistaken for evidence later.
 *
 * @task gh#1468
 */

import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type {
  AcceptanceGate,
  AcceptanceGateResult,
  Task,
  ValidateGateParams,
} from '@cleocode/contracts';
import { readProjectInfoAtDirectorySync } from '../project-scope.js';
import { createOperationExecutionContext } from '../store/background-ops.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { extractTypedGates, runGates } from './gate-runner.js';

/** Default per-gate ceiling, mirroring the gate runner's own default. */
const DEFAULT_GATE_TIMEOUT_MS = Number(process.env['CLEO_GATE_TIMEOUT_MS'] ?? 60_000);

/** Slack added to the summed per-gate budget for spawn and teardown overhead. */
const PREVIEW_OVERHEAD_MS = 5_000;

/** Outcome of a typed-gate preview run. */
export interface TaskGatePreview {
  /** Task whose gates were run. */
  taskId: string;
  /** Number of typed gates found on the task's acceptance array. */
  gateCount: number;
  /** One result per typed gate, in acceptance-array order. */
  results: AcceptanceGateResult[];
  /**
   * True when no gate returned `fail` or `error`.
   *
   * `warn` (a failed advisory gate) and `skipped` (a manual gate) do not
   * withhold it — they carry their own meaning in `results`.
   */
  passed: boolean;
  /**
   * Always `false`, and present on purpose.
   *
   * The caller is reading gate outcomes outside the attestation path, and the
   * response has to say so in its own data rather than relying on the reader
   * knowing which verb they used.
   */
  persisted: false;
  /** Present when the task carries no typed gates, explaining the empty result. */
  note?: string;
}

/**
 * Wall-clock budget for the whole preview: every gate's own ceiling, plus slack.
 *
 * The gate runner's default batch deadline is two seconds, which is right for
 * verification admitted inside a mutation but cannot host a real test suite.
 * Deriving the budget from the gates themselves keeps the bound honest without
 * inventing a number.
 *
 * @param gates - Gates that will run.
 */
function previewBudgetMs(gates: readonly AcceptanceGate[]): number {
  const total = gates.reduce(
    (sum, gate) => sum + (gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS),
    PREVIEW_OVERHEAD_MS,
  );
  return Math.min(total, Number.MAX_SAFE_INTEGER);
}

/**
 * Run every typed gate on a task and return the results, persisting nothing.
 *
 * Signature follows ADR-057: `(projectRoot, params)`, uniform with every other
 * core function behind a dispatch operation.
 *
 * @param projectRoot - Absolute CLEO store root.
 * @param params - Dispatch params; `taskId` selects the task, `agent` attributes the results.
 * @returns Per-gate results plus an aggregate verdict.
 * @throws When the task does not exist, or the project has no stable identity.
 *
 * @example
 * ```ts
 * const preview = await previewTaskGates(projectRoot, { taskId: 'T489' });
 * if (!preview.passed) console.error(preview.results);
 * ```
 *
 * @task gh#1468
 */
export async function previewTaskGates(
  projectRoot: string,
  params: ValidateGateParams,
): Promise<TaskGatePreview> {
  const { taskId } = params;
  const root = resolve(projectRoot);
  const accessor = await getTaskAccessor(root);
  const task: Task | null = await accessor.loadSingleTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const typed = extractTypedGates(task.acceptance ?? []);
  if (typed.length === 0) {
    return {
      taskId,
      gateCount: 0,
      results: [],
      passed: true,
      persisted: false,
      note:
        `${taskId} has no typed acceptance gates — its criteria are free text, which ` +
        `cannot be executed. Add one with \`cleo req add ${taskId} --gate '<json>'\`.`,
    };
  }

  const gates = typed.map((entry) => entry.gate);
  const identity = readProjectInfoAtDirectorySync(root, join(root, '.cleo'));
  if (!identity.projectId)
    throw new Error('Typed gate execution requires a stable project identity');

  const execution = createOperationExecutionContext(
    {
      projectId: identity.projectId,
      projectRoot: root,
      actor: params.agent ?? process.env['CLEO_AGENT_ID'] ?? 'cleo-verify',
      operation: 'check.gate.verify',
      idempotencyKey: `${taskId}:preview:${randomUUID()}`,
    },
    { budgetMs: previewBudgetMs(gates) },
  );
  try {
    const observed = await runGates(gates, { projectRoot: root, execution });
    // Restore the acceptance-array index the runner reports positionally, so a
    // result lines up with the criterion the reader sees in `cleo show`.
    const results = observed.map((result, i) => ({
      ...result,
      index: typed[i]?.originalIndex ?? result.index,
    }));
    return {
      taskId,
      gateCount: results.length,
      results,
      passed: !results.some((r) => r.result === 'fail' || r.result === 'error'),
      persisted: false,
    };
  } finally {
    execution.close();
  }
}
