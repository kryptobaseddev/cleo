/**
 * `cleo goal close` — record the evidence a goal run produced against the
 * CLEO acceptance criteria its criteria `prove`.
 *
 * Honesty rules (epic T13791):
 * 1. The outcome must match the contract bytes (sha256 lock) and its head
 *    commit must exist, or nothing is recorded.
 * 2. A passing criterion's evidence goes to the gate it demonstrates, with
 *    `satisfies:<task>#AC<n>`: a test report becomes `test-run:` on
 *    `testsPassed`; a file, contains or absent check `commit:`+`files:` on
 *    `implemented`. A diff guard proves nothing was built and maps to no gate.
 * 3. A verifier verdict is a note only: it NEVER satisfies `implemented` or
 *    `testsPassed`, so an AC it alone proves stays open. A human sign-off,
 *    a failed criterion and an AC no criterion proves stay open too.
 * 4. Evidence is written through `validateGateVerify` (the `cleo verify` /
 *    `cleo done` write) and never replaces a gate already recorded.
 * 5. A task is `ready` only when `cleo done --plan` maps every one of its
 *    criteria; the caller then completes it through the `cleo done` path.
 *
 * Re-running with the same outcome writes nothing new: criteria already
 * linked are skipped.
 *
 * @epic T13791
 * @task T13794
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { GoalOutcome, VerificationGate } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { getProjectRoot } from '../paths.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import type { ChangeSetDeps } from '../tasks/change-set.js';

/** One acceptance criterion a close left open, and why. */
export interface GoalCloseOpenAc {
  /** Criterion alias (`AC<n>`). */
  alias: string;
  /** What blocks it. */
  blocker: string;
}

/** What a close did for one task. */
export interface GoalCloseTask {
  /** Task id. */
  taskId: string;
  /** The task was already done; nothing was recorded. */
  alreadyDone: boolean;
  /** Gates this close recorded (empty on a re-run). */
  recordedGates: VerificationGate[];
  /** Criteria `cleo done --plan` maps after the close. */
  satisfied: string[];
  /** Criteria still open, each with its blocker. */
  open: GoalCloseOpenAc[];
  /** Every criterion is mapped: the caller completes it through `cleo done`. */
  ready: boolean;
}

/** Result of {@link closeGoal}. */
export interface GoalCloseResult {
  /** Goal slug. */
  goal: string;
  /** Verified contract lock (sha256 of goal.yaml). */
  lock: string;
  /** Verified head commit. */
  headCommit: string;
  /** Per-task result, in contract order. */
  tasks: GoalCloseTask[];
}

/** Options for {@link closeGoal}. */
export interface CloseGoalOptions {
  /** Project root (default: resolved). */
  projectRoot?: string;
  /** Path of the GoalOutcome JSON file. */
  outcomePath: string;
  /** Change-set lookups for the readiness plan (tests inject these). */
  deps?: ChangeSetDeps;
}

const evidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string(),
    exitCode: z.number(),
    reportPath: z.string().optional(),
    testFiles: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.enum(['file', 'contains', 'absent', 'diff']), paths: z.array(z.string()) }),
  z.object({
    kind: z.literal('verifier'),
    verdict: z.enum(['proven', 'not_proven', 'contradicted']),
    quotes: z.array(z.object({ path: z.string(), quote: z.string() })),
    reason: z.string().optional(),
  }),
  z.object({ kind: z.literal('human'), by: z.string().optional(), note: z.string().optional() }),
]);

const outcomeSchema = z.object({
  schema: z.literal('goal-outcome/v1'),
  goal: z.string(),
  runId: z.string().optional(),
  lock: z.string().regex(/^[0-9a-f]{64}$/),
  baseCommit: z.string().nullable(),
  headCommit: z.string().regex(/^[0-9a-f]{7,64}$/),
  results: z.array(
    z.object({
      id: z.string(),
      pass: z.boolean(),
      by: z.enum(['host', 'verifier', 'verifier-fallback', 'human']),
      detail: z.string().optional(),
      evidence: evidenceSchema,
    }),
  ),
}) satisfies z.ZodType<GoalOutcome>;

/** The contract fields a close reads; everything else is the runtime's. */
const contractSchema = z.object({
  schema: z.literal('goal/v1'),
  id: z.string(),
  criteria: z.array(
    z.object({ id: z.string(), proves: z.array(z.string().regex(/^T\d+#AC\d+$/)).optional() }),
  ),
  cleo: z
    .object({ tasks: z.array(z.union([z.string(), z.object({ id: z.string() })])) })
    .optional(),
});

/** What one passing criterion contributes to one AC: a gate atom, or a blocker. */
type Contribution = { gate: VerificationGate; atoms: string[] } | { blocker: string };

/** Refuse the close with a validation error. */
function fail(message: string, fix?: string): never {
  throw new CleoError(ExitCode.VALIDATION_ERROR, message, fix ? { fix } : undefined);
}

/** The evidence a criterion's outcome contributes, per the honesty rules. */
function contribution(
  criterionId: string,
  result: GoalOutcome['results'][number] | undefined,
  root: string,
  headCommit: string,
): Contribution {
  if (!result) return { blocker: `${criterionId} has no verdict in the outcome` };
  if (!result.pass)
    return { blocker: `${criterionId} did not pass: ${result.detail ?? 'no detail'}` };
  const ev = result.evidence;
  switch (ev.kind) {
    case 'command':
      return ev.reportPath
        ? { gate: 'testsPassed', atoms: [`test-run:${resolve(root, ev.reportPath)}`] }
        : {
            blocker: `${criterionId} passed a command with no test report, which is no gate evidence; attach its report or run the typed gate with cleo verify --run`,
          };
    case 'verifier':
      return {
        blocker: `${criterionId} is proven only by a verifier verdict (a note); a verifier verdict never satisfies implemented or testsPassed`,
      };
    case 'diff':
      return {
        blocker: `${criterionId} is a diff guard: it proves the paths did not change, not that anything was built`,
      };
    case 'human':
      return {
        blocker: `${criterionId} is an owner sign-off${ev.by ? ` by ${ev.by}` : ''}; record the manual gate verdict in CLEO`,
      };
    default: {
      // Only real files can be hashed into a files: atom; globs and directories cannot.
      const files = ev.paths.filter(
        (p) =>
          !/[*?[\]{}]/.test(p) && existsSync(join(root, p)) && statSync(join(root, p)).isFile(),
      );
      return files.length
        ? { gate: 'implemented', atoms: [`commit:${headCommit}`, `files:${files.join(',')}`] }
        : { blocker: `${criterionId} passed a ${ev.kind} check on no existing file to record` };
    }
  }
}

/**
 * Close a goal: verify the outcome, record per-AC evidence, report each task.
 *
 * @param slug - Goal slug; the contract is `.opencode/goals/<slug>/goal.yaml`.
 * @param opts - Project root, outcome path and test seams.
 * @returns Per-task results, or a refusal when the outcome does not match.
 * @example
 * ```ts
 * const r = await closeGoal('t123', { outcomePath: 'outcome.json' });
 * if (r.success) r.data.tasks.filter((t) => t.ready); // complete via cleo done
 * ```
 */
export async function closeGoal(
  slug: string,
  opts: CloseGoalOptions,
): Promise<EngineResult<GoalCloseResult>> {
  try {
    const root = opts.projectRoot ?? getProjectRoot();
    const contractPath = join(root, '.opencode', 'goals', slug, 'goal.yaml');
    if (!existsSync(contractPath))
      fail(`No goal contract at ${contractPath}`, `cleo goal draft <taskId>`);
    const bytes = readFileSync(contractPath);
    const lock = createHash('sha256').update(bytes).digest('hex');
    const outcomeParsed = outcomeSchema.safeParse(
      JSON.parse(readFileSync(resolve(opts.outcomePath), 'utf8')),
    );
    if (!outcomeParsed.success) fail(`Not a goal-outcome/v1 file: ${outcomeParsed.error.message}`);
    const outcome: GoalOutcome = outcomeParsed.data;
    if (outcome.goal !== slug) fail(`The outcome is for goal ${outcome.goal}, not ${slug}`);
    if (outcome.lock !== lock) {
      fail(
        `The outcome's contract lock ${outcome.lock.slice(0, 12)} does not match ${contractPath} (${lock.slice(0, 12)}); the contract changed after the run`,
        'Close with the outcome of a run of the current contract',
      );
    }
    try {
      execFileSync('git', ['-C', root, 'cat-file', '-e', `${outcome.headCommit}^{commit}`], {
        stdio: 'ignore',
      });
    } catch {
      fail(
        `Head commit ${outcome.headCommit} does not exist in ${root}`,
        'git fetch, then close again',
      );
    }
    const contractParsed = contractSchema.safeParse(parseYaml(bytes.toString('utf8')));
    if (!contractParsed.success)
      fail(`${contractPath} is not a goal/v1 contract: ${contractParsed.error.message}`);
    const contract = contractParsed.data;

    // Per task, per AC alias: every contribution of every criterion proving it.
    const byTask = new Map<string, Map<string, Contribution[]>>();
    for (const t of contract.cleo?.tasks ?? [])
      byTask.set(typeof t === 'string' ? t : t.id, new Map());
    for (const c of contract.criteria) {
      const result = outcome.results.find((r) => r.id === c.id);
      for (const ref of c.proves ?? []) {
        const [taskId = '', alias = ''] = ref.split('#');
        const acs = byTask.get(taskId) ?? new Map<string, Contribution[]>();
        byTask.set(taskId, acs);
        acs.set(alias, [
          ...(acs.get(alias) ?? []),
          contribution(c.id, result, root, outcome.headCommit),
        ]);
      }
    }

    const accessor = await getTaskAccessor(root);
    const { planTaskDone } = await import('../tasks/done-plan.js');
    const { validateGateVerify } = await import('../validation/engine-ops.js');
    const { resolveBoundSessionId } = await import('../store/session-store.js');
    const sessionId = (await resolveBoundSessionId(root).catch(() => null)) ?? undefined;
    const tasks: GoalCloseTask[] = [];
    for (const [taskId, acs] of byTask) {
      const task = await accessor.loadSingleTask(taskId);
      if (!task) fail(`Task ${taskId} named by goal ${slug} not found`, `cleo find "${taskId}"`);
      if (task.status === 'done') {
        tasks.push({
          taskId,
          alreadyDone: true,
          recordedGates: [],
          satisfied: [],
          open: [],
          ready: false,
        });
        continue;
      }
      const rows = await accessor.getAcRows(taskId);
      const rowId = new Map(rows.map((r) => [`AC${r.ordinal}`, r.id]));
      const linked = new Set(
        Object.values(task.verification?.evidence ?? {}).flatMap(
          (e) => e?.scope?.criteria?.map((l) => l.criterionId) ?? [],
        ),
      );
      const blockers = new Map<string, string>();
      const perGate = new Map<VerificationGate, { atoms: Set<string>; aliases: string[] }>();
      for (const [alias, parts] of acs) {
        if (!rowId.has(alias)) {
          blockers.set(alias, `${taskId} has no ${alias}`);
          continue;
        }
        const blocked = parts.flatMap((p) => ('blocker' in p ? [p.blocker] : []));
        if (blocked.length) {
          blockers.set(alias, blocked.join('; '));
          continue;
        }
        for (const p of parts) {
          if ('blocker' in p) continue;
          const entry = perGate.get(p.gate) ?? { atoms: new Set<string>(), aliases: [] };
          for (const a of p.atoms) entry.atoms.add(a);
          if (!entry.aliases.includes(alias)) entry.aliases.push(alias);
          perGate.set(p.gate, entry);
        }
      }
      const gateEvidence: Partial<Record<VerificationGate, string>> = {};
      for (const [gate, { atoms, aliases }] of perGate) {
        // Idempotent re-run: nothing new to link on this gate.
        if (aliases.every((a) => linked.has(rowId.get(a) ?? ''))) continue;
        const evidence = [...atoms, ...aliases.map((a) => `satisfies:${taskId}#${a}`)].join(';');
        if (task.verification?.gates?.[gate] === true) {
          for (const a of aliases)
            blockers.set(
              a,
              `${gate} is already recorded for ${taskId}; recording the goal's evidence would replace it. Re-record both: cleo verify ${taskId} --gate ${gate} --evidence "<existing atoms>;${evidence}"`,
            );
          continue;
        }
        gateEvidence[gate] = evidence;
      }
      const recordedGates = Object.keys(gateEvidence) as VerificationGate[];
      if (recordedGates.length > 0) {
        const written = await validateGateVerify(root, {
          taskId,
          gateEvidence,
          agent: 'cleo-goal-close',
          ...(sessionId ? { sessionId } : {}),
        });
        if (!written.success) {
          recordedGates.length = 0;
          for (const { aliases } of perGate.values())
            for (const a of aliases)
              blockers.set(
                a,
                `cleo verify refused (${written.error.code}): ${written.error.message}`,
              );
        }
      }
      const plan = await planTaskDone(taskId, {
        projectRoot: root,
        cwd: root,
        ...(opts.deps ? { deps: opts.deps } : {}),
      });
      if (!plan.success) {
        tasks.push({
          taskId,
          alreadyDone: false,
          recordedGates,
          satisfied: [],
          open: [
            {
              alias: '*',
              blocker: `cleo done --plan failed (${plan.error.code}): ${plan.error.message}`,
            },
          ],
          ready: false,
        });
        continue;
      }
      const open = plan.data.acMapping
        .filter((m) => !m.mapped)
        .map((m) => ({
          alias: m.alias,
          blocker: blockers.get(m.alias) ?? 'no passing goal criterion proves it',
        }));
      tasks.push({
        taskId,
        alreadyDone: false,
        recordedGates,
        satisfied: plan.data.acMapping.filter((m) => m.mapped).map((m) => m.alias),
        open,
        ready: open.length === 0,
      });
    }
    return engineSuccess({ goal: slug, lock, headCommit: outcome.headCommit, tasks });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return cleoErrorToEngineResult<GoalCloseResult>(
        new CleoError(ExitCode.VALIDATION_ERROR, `Outcome is not JSON: ${err.message}`),
      );
    }
    return cleoErrorToEngineResult<GoalCloseResult>(
      err,
      'E_GOAL_CLOSE_FAILED',
      'cleo goal close failed',
    );
  }
}
