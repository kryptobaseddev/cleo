/**
 * `cleo goal close` — record the evidence a goal run produced against the
 * CLEO acceptance criteria its criteria `prove`.
 *
 * Honesty rules (epic T13791, agreed with OpenCode-Goal):
 * 1. The outcome must match the contract bytes (sha256 lock), and its head
 *    (and base) commit must exist, or nothing is recorded.
 * 2. The outcome's `pass`, exit codes and verdicts are claims. Everything CLEO
 *    can check it re-checks before recording:
 *    - `file` / `contains` / `absent` re-run against the head commit's tree
 *      → `implemented`: `commit:<head>;files:<files>`;
 *    - a test report must hash to `reportSha256` → `testsPassed`: `test-run:`;
 *    - the project's typecheck / lint command → `qaPassed`: `tool:typecheck` /
 *      `tool:lint`, run by CLEO's own tool runner, never from the exit code;
 *    - a drafted `cleo verify <id> --run --req <R>` check and a human sign-off
 *      write nothing: the AC counts only when CLEO's own typed-gate or manual
 *      record maps it (`cleo done --plan`);
 *    - a verifier verdict (quotes re-read at head) and a diff guard never
 *      satisfy a gate.
 * 3. Evidence goes through `validateGateVerify` (the `cleo verify` / `cleo
 *    done` write), with `satisfies:<task>#<the contract's own reference>`, and
 *    never replaces a gate already recorded.
 * 4. A task is `ready` only when `cleo done --plan` maps every one of its
 *    criteria; the caller then completes it through the `cleo done` path.
 *
 * Re-running with the same outcome writes nothing new.
 *
 * @epic T13791
 * @task T13794
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import type { GoalOutcome, VerificationGate } from '@cleocode/contracts';
import {
  AC_ALIAS_REGEX,
  AC_UUID_REGEX,
  SATISFIES_TASK_ID_REGEX,
  SATISFIES_VERSION_PIN_REGEX,
} from '@cleocode/contracts/evidence-atom-schema.js';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { isWithin } from '../nexus/stored-roots.js';
import { getProjectRoot } from '../paths.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { type ChangeSetDeps, isLandedOnOriginDefault } from '../tasks/change-set.js';
import { joinCommandLine } from '../tasks/command-line.js';
import { resolveToolCommand } from '../tasks/tool-resolver.js';
import { GOAL_ID } from './draft.js';

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
  /**
   * The commit `cleo done --commit` completes it from (T13799): the outcome's
   * head commit, set only when that commit has landed on the default branch
   * and no PR, branch or document gives the task a change set of its own.
   */
  completionCommit?: string;
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
    reportSha256: z.string().optional(),
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
  baseCommit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .nullable(),
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

/** Whether `target` (after `T…#`) is one of the three `satisfies:` target forms. */
function isAcTarget(target: string): boolean {
  const [ac = '', pin, extra] = target.split('@');
  if (extra !== undefined) return false;
  if (pin !== undefined) return AC_ALIAS_REGEX.test(ac) && SATISFIES_VERSION_PIN_REGEX.test(pin);
  return AC_ALIAS_REGEX.test(ac) || AC_UUID_REGEX.test(ac);
}

const acRefSchema = z.string().refine((ref) => {
  const [task = '', target = '', extra] = ref.split('#');
  return extra === undefined && SATISFIES_TASK_ID_REGEX.test(task) && isAcTarget(target);
}, 'proves entries are T<id>#AC<n>, T<id>#<criterion uuid> or T<id>#AC<n>@<14-digit pin>');

/** The contract fields a close reads; everything else is the runtime's. */
const contractSchema = z.object({
  schema: z.literal('goal/v1'),
  id: z.string(),
  workspace: z.string().optional(),
  criteria: z.array(
    z.object({
      id: z.string(),
      check: z.object({
        kind: z.string(),
        run: z.string().optional(),
        path: z.string().optional(),
        exists: z.boolean().optional(),
        text: z.string().optional(),
        regex: z.string().optional(),
        pattern: z.string().optional(),
        paths: z.array(z.string()).optional(),
      }),
      proves: z.array(acRefSchema).optional(),
    }),
  ),
  cleo: z
    .object({ tasks: z.array(z.union([z.string(), z.object({ id: z.string() })])) })
    .optional(),
});

type ContractCheck = z.infer<typeof contractSchema>['criteria'][number]['check'];

/**
 * What one criterion contributes to one AC: a gate atom to record, a reason
 * it may still count through CLEO's own record (`deferred`), or a blocker.
 */
type Contribution =
  | { gate: VerificationGate; atoms: string[] }
  | { deferred: string }
  | { blocker: string };

/** Refuse the close with a validation error. */
function fail(message: string, fix?: string): never {
  throw new CleoError(ExitCode.VALIDATION_ERROR, message, fix ? { fix } : undefined);
}

/** `git` in `root`, or null when it fails. */
function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** Whether `ancestor` is `descendant` or an ancestor of it in `root`. */
function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  return git(root, ['merge-base', '--is-ancestor', ancestor, descendant]) !== null;
}

/** Whether `sha` names a commit in `root`. */
function commitExists(root: string, sha: string): boolean {
  return git(root, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
}

/** Facts read from one tree: a commit's, or the working tree's. */
interface HeadTree {
  /** Where the facts come from, for messages (`head <sha>` or `the working tree`). */
  label: string;
  /** File content, or null when it is not a file there. */
  read(path: string): string | null;
  /** Whether `pattern` matches nowhere under `paths` (null: search failed). */
  absent(pattern: string, paths: readonly string[]): boolean | null;
  /** Repo-relative path of a workspace-relative one. */
  repoPath(path: string): string;
}

/** The tree of commit `ref`, or the working tree (what `files:` hashes) when `ref` is null. */
function treeAt(root: string, ref: string | null, workspace: string | undefined): HeadTree {
  const repoPath = (p: string): string =>
    posix.normalize(posix.join(workspace ?? '.', p.replace(/^\.\//, '')));
  return {
    label: ref ? `head ${ref.slice(0, 12)}` : 'the working tree',
    repoPath,
    read: (p) => {
      if (ref) return git(root, ['show', `${ref}:${repoPath(p)}`]);
      const abs = join(root, repoPath(p));
      return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
    },
    absent: (pattern, paths) => {
      try {
        execFileSync(
          'git',
          [
            '-C',
            root,
            'grep',
            '-q',
            '-I',
            '-E',
            '-e',
            pattern,
            ...(ref ? [ref] : []),
            '--',
            ...(paths.length ? paths.map(repoPath) : [workspace ?? '.']),
            ':(exclude).opencode/goals',
          ],
          { stdio: 'ignore' },
        );
        return false; // exit 0: a match remains
      } catch (err) {
        return (err as { status?: number }).status === 1 ? true : null;
      }
    },
  };
}

/** Re-run a path check against one tree; the files it proves, or why it fails. */
function recheckPath(check: ContractCheck, tree: HeadTree): { files: string[] } | { why: string } {
  const path = check.path ?? '';
  switch (check.kind) {
    case 'file': {
      const exists = tree.read(path) !== null;
      if (exists !== (check.exists !== false))
        return { why: `${path} ${exists ? 'exists' : 'does not exist'} at ${tree.label}` };
      return { files: exists ? [tree.repoPath(path)] : [] };
    }
    case 'contains': {
      const content = tree.read(path);
      if (content === null) return { why: `${path} is not a file at ${tree.label}` };
      const ok =
        check.text !== undefined
          ? content.includes(check.text)
          : new RegExp(check.regex ?? '', 'm').test(content); // OCG's flags
      return ok
        ? { files: [tree.repoPath(path)] }
        : { why: `${path} does not contain it at ${tree.label}` };
    }
    case 'absent': {
      const absent = tree.absent(check.pattern ?? '', check.paths ?? []);
      if (absent === null) return { why: `the search at ${tree.label} failed` };
      if (!absent) return { why: `the pattern still matches at ${tree.label}` };
      return { files: (check.paths ?? []).filter((p) => tree.read(p) !== null).map(tree.repoPath) };
    }
    default:
      return { why: `${check.kind} is not a path check` };
  }
}

/** Context every contribution is judged in. */
interface JudgeContext {
  root: string;
  head: string;
  /** The head commit's tree, where the run's claims are judged. */
  tree: HeadTree;
  /** The working tree, which the recorded `files:` atom hashes. */
  live: HeadTree;
  /** The project's resolved lint / typecheck command lines. */
  qaCommands: Map<string, 'lint' | 'typecheck'>;
}

/** The evidence one criterion contributes, per the honesty rules. */
function contribution(
  criterionId: string,
  check: ContractCheck,
  result: GoalOutcome['results'][number] | undefined,
  ctx: JudgeContext,
): Contribution {
  if (check.kind === 'diff') {
    return {
      blocker: `${criterionId} is a diff guard: it proves the paths did not change, not that anything was built`,
    };
  }
  if (check.kind === 'human') {
    return {
      deferred: `${criterionId} is an owner sign-off, which counts only with CLEO's own record: record the manual gate verdict`,
    };
  }
  if (!result) return { blocker: `${criterionId} has no verdict in the outcome` };
  if (!result.pass)
    return { blocker: `${criterionId} did not pass: ${result.detail ?? 'no detail'}` };
  if (check.kind === 'verifier') {
    const quotes = result.evidence.kind === 'verifier' ? result.evidence.quotes : [];
    const found = quotes.filter((q) => ctx.tree.read(q.path)?.includes(q.quote) === true).length;
    return {
      blocker: `${criterionId} is proven only by a verifier verdict (a note; ${found}/${quotes.length} quotes found at head); a verifier verdict never satisfies a gate`,
    };
  }
  if (check.kind === 'command') {
    const run = (check.run ?? '').trim();
    const typed = /^cleo verify (T\d+) --run --req (\S+) --field \/data\/passed$/.exec(run);
    if (typed) {
      return {
        deferred: `${criterionId} runs typed gate ${typed[2]}, which counts only with its cached pass: cleo verify ${typed[1]} --run --req ${typed[2]}`,
      };
    }
    const qa = ctx.qaCommands.get(run);
    if (qa) return { gate: 'qaPassed', atoms: [`tool:${qa}`] };
    const ev = result.evidence;
    if (ev.kind !== 'command' || !ev.reportPath) {
      return {
        blocker: `${criterionId} passed a command with no test report, which is no gate evidence; attach its report, or make it a typed gate`,
      };
    }
    const report = resolve(ctx.root, ev.reportPath);
    if (!existsSync(report))
      return { blocker: `${criterionId}'s report ${ev.reportPath} is missing` };
    if (!isWithin(realpathSync(ctx.root), realpathSync(report)))
      return { blocker: `${criterionId}'s report ${ev.reportPath} is outside the project` };
    const sha = createHash('sha256').update(readFileSync(report)).digest('hex');
    if (!ev.reportSha256)
      return { blocker: `${criterionId}'s report has no reportSha256 to bind it` };
    if (sha !== ev.reportSha256)
      return {
        blocker: `${criterionId}'s report does not hash to its reportSha256 (it changed after the run)`,
      };
    return { gate: 'testsPassed', atoms: [`test-run:${report}`] };
  }
  // The claim must hold at the run's head AND in the tree whose bytes files: hashes.
  for (const tree of [ctx.tree, ctx.live]) {
    const rechecked = recheckPath(check, tree);
    if ('why' in rechecked) return { blocker: `${criterionId} does not hold: ${rechecked.why}` };
  }
  const rechecked = recheckPath(check, ctx.live);
  if (!('files' in rechecked) || rechecked.files.length === 0)
    return { blocker: `${criterionId} passed a ${check.kind} check on no file to record` };
  return {
    gate: 'implemented',
    atoms: [`commit:${ctx.head}`, `files:${rechecked.files.join(',')}`],
  };
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
    if (!GOAL_ID.test(slug))
      fail(`Goal slug "${slug}" is not a goal id (a-z, 0-9, hyphens, at most 64)`);
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
    for (const sha of [outcome.headCommit, outcome.baseCommit]) {
      if (sha !== null && !commitExists(root, sha))
        fail(`Commit ${sha} does not exist in ${root}`, 'git fetch, then close again');
    }
    // A stale head would judge claims on code HEAD no longer holds.
    if (!isAncestor(root, outcome.headCommit, 'HEAD'))
      fail(
        `Head commit ${outcome.headCommit.slice(0, 12)} is not HEAD or an ancestor of it in ${root}`,
        'Close from the checkout the run produced (or one that contains its head)',
      );
    if (outcome.baseCommit !== null && !isAncestor(root, outcome.baseCommit, outcome.headCommit))
      fail(`Base commit ${outcome.baseCommit.slice(0, 12)} is not an ancestor of the head commit`);
    const contractParsed = contractSchema.safeParse(parseYaml(bytes.toString('utf8')));
    if (!contractParsed.success)
      fail(`${contractPath} is not a goal/v1 contract: ${contractParsed.error.message}`);
    const contract = contractParsed.data;

    const qaCommands = new Map<string, 'lint' | 'typecheck'>();
    for (const tool of ['lint', 'typecheck'] as const) {
      const r = resolveToolCommand(tool, root);
      if (r.ok) qaCommands.set(joinCommandLine([r.command.cmd, ...r.command.args]), tool);
    }
    const ctx: JudgeContext = {
      root,
      head: outcome.headCommit,
      tree: treeAt(root, outcome.headCommit, contract.workspace),
      live: treeAt(root, null, contract.workspace),
      qaCommands,
    };

    // Per task, per AC target (as the contract spells it): every contribution.
    const byTask = new Map<string, Map<string, Contribution[]>>();
    for (const t of contract.cleo?.tasks ?? [])
      byTask.set(typeof t === 'string' ? t : t.id, new Map());
    for (const c of contract.criteria) {
      const result = outcome.results.find((r) => r.id === c.id);
      for (const ref of c.proves ?? []) {
        const [taskId = '', target = ''] = ref.split('#');
        const acs = byTask.get(taskId) ?? new Map<string, Contribution[]>();
        byTask.set(taskId, acs);
        acs.set(target, [...(acs.get(target) ?? []), contribution(c.id, c.check, result, ctx)]);
      }
    }

    const accessor = await getTaskAccessor(root);
    const { planTaskDone } = await import('../tasks/done-plan.js');
    const { validateGateVerify } = await import('../validation/engine-ops.js');
    const { resolveBoundSessionId } = await import('../store/session-store.js');
    const sessionId = (await resolveBoundSessionId(root).catch(() => null)) ?? undefined;
    // Resolve every task before any write, so a refusal never follows a partial write.
    const loaded = [];
    for (const [taskId, acs] of byTask) {
      const task = await accessor.loadSingleTask(taskId);
      if (!task) fail(`Task ${taskId} named by goal ${slug} not found`, `cleo find "${taskId}"`);
      loaded.push({ taskId, acs, task, rows: await accessor.getAcRows(taskId) });
    }
    const tasks: GoalCloseTask[] = [];
    for (const { taskId, acs, task, rows } of loaded) {
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
      // A target names its row by alias (optionally pinned) or by canonical uuid.
      const rowOf = (target: string) => {
        const ac = target.split('@')[0] ?? '';
        return rows.find((r) => r.id === ac || `AC${r.ordinal}` === ac);
      };
      const linked = new Set(
        Object.values(task.verification?.evidence ?? {}).flatMap(
          (e) => e?.scope?.criteria?.map((l) => l.criterionId) ?? [],
        ),
      );
      const blockers = new Map<string, string>();
      const perGate = new Map<
        VerificationGate,
        { atoms: Set<string>; targets: string[]; aliases: string[] }
      >();
      for (const [target, parts] of acs) {
        const row = rowOf(target);
        if (!row) {
          blockers.set(target, `${taskId} has no criterion ${target}`);
          continue;
        }
        const alias = `AC${row.ordinal}`;
        const blocked = parts.flatMap((p) => ('blocker' in p ? [p.blocker] : []));
        if (blocked.length) {
          blockers.set(alias, blocked.join('; '));
          continue;
        }
        const deferred = parts.flatMap((p) => ('deferred' in p ? [p.deferred] : []));
        if (deferred.length) blockers.set(alias, deferred.join('; '));
        for (const p of parts) {
          if (!('gate' in p)) continue;
          const entry = perGate.get(p.gate) ?? {
            atoms: new Set<string>(),
            targets: [],
            aliases: [],
          };
          for (const a of p.atoms) entry.atoms.add(a);
          if (!entry.targets.includes(target)) entry.targets.push(target);
          if (!entry.aliases.includes(alias)) entry.aliases.push(alias);
          perGate.set(p.gate, entry);
        }
      }
      const gateEvidence: Partial<Record<VerificationGate, string>> = {};
      for (const [gate, { atoms, targets, aliases }] of perGate) {
        // Idempotent re-run: nothing new to link on this gate.
        if (targets.every((t) => linked.has(rowOf(t)?.id ?? ''))) continue;
        const evidence = [...atoms, ...targets.map((t) => `satisfies:${taskId}#${t}`)].join(';');
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
      // Work that landed on main with no citing PR or branch completes from the run's head commit.
      const viaCommit =
        open.length === 0 &&
        plan.data.changeSet.source === 'none' &&
        isLandedOnOriginDefault(root, outcome.headCommit);
      tasks.push({
        taskId,
        alreadyDone: false,
        recordedGates,
        satisfied: plan.data.acMapping.filter((m) => m.mapped).map((m) => m.alias),
        open,
        ready: open.length === 0,
        ...(viaCommit ? { completionCommit: outcome.headCommit } : {}),
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
