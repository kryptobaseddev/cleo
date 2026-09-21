/**
 * Containment-aware scope reconciliation across a saga or epic.
 *
 * ## Why this exists
 *
 * `duplicate-detector.ts` runs at INSERT time over a FLAT candidate set — it
 * queries `{status: [pending, active, blocked], limit}` with no parent or saga
 * scoping — and its verdict is binary: reject, or insert. Two consequences,
 * both reported from the field on large projects:
 *
 *   1. **Partial overlap is invisible.** Two tasks that share part of their
 *      scope are neither duplicates nor unrelated, and the insert-time check
 *      has no vocabulary for that. They both get created and quietly compete.
 *   2. **Nothing is ever re-examined.** Overlap mostly emerges AFTER filing, as
 *      scope drifts during execution and several agents extend adjacent tasks
 *      toward the same middle. The insert-time check has long since run.
 *
 * `cleo reconcile` already existed but only covers release tags. The `relates`
 * vocabulary (`duplicates`, `absorbs`, `supersedes`) already existed too, and
 * nothing produced or consumed it — it was declarable by hand and never by a
 * workflow.
 *
 * This module supplies the missing sweep: retro-active, scoped to a container,
 * and classifying each overlapping pair into a concrete ACTION rather than a
 * duplicate yes/no.
 *
 * ## Deliberately deterministic
 *
 * Detection reuses `computeLexicalSimilarity` and `computeJaccardWordSimilarity`
 * from the duplicate detector. No LLM call, no embedding provider. A sweep an
 * agent is expected to run repeatedly must be cheap, offline, and give the same
 * answer twice — an LLM-scored sweep that reshuffles its own findings between
 * runs cannot be acted on incrementally.
 *
 * @task T12299
 */

import type { Task } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { computeJaccardWordSimilarity, computeLexicalSimilarity } from './duplicate-detector.js';

/** Statuses that represent live work. Terminal rows are history, not competition. */
const LIVE_STATUSES = new Set(['pending', 'active', 'blocked']);

/**
 * Pairs are O(n²). Above this many live nodes the sweep reports a bounded scan
 * rather than silently comparing a subset — a truncated sweep that reads as
 * complete is worse than one that says what it skipped.
 */
export const MAX_SWEEP_NODES = 400;

/** At or above this combined score two tasks describe the same deliverable. */
export const MERGE_THRESHOLD = 0.9;

/**
 * At or above this two tasks share enough scope to need a decision.
 *
 * Calibrated against real data, not chosen: swept saga T9977 in this repo (144
 * live tasks, 10,160 pairs) and counted findings by threshold —
 *
 * ```
 *   >= 0.55: 427   >= 0.70:  7
 *   >= 0.60: 128   >= 0.75:  5
 *   >= 0.65:  32   >= 0.85:  2
 * ```
 *
 * 0.55 returns 427 findings, which is not a report anyone acts on. 0.65 returns
 * 32 from 144 tasks, which is reviewable.
 *
 * The residual false positives are instructive and worth knowing before
 * lowering this again: on a codebase with naming conventions, titles share
 * vocabulary without sharing scope. `Route createAgentWorktree through core SDK`
 * vs `Route destroyAgentWorktree through core SDK` scores 0.852 and is two
 * genuinely different pieces of work. That is why high-confidence actions
 * (`merge`/`absorb`) sit at {@link MERGE_THRESHOLD} and additionally require a
 * tier/parent match — on that same real sweep they fired ZERO times, while
 * firing correctly on a synthetic control with true duplicates.
 */
export const OVERLAP_THRESHOLD = 0.65;

/** What to do about an overlapping pair. */
export type ReconcileAction = 'merge' | 'absorb' | 'split' | 'link';

/** One overlapping pair and the action proposed for it. */
export interface ScopeOverlap {
  /** The earlier-created task of the pair; the survivor for `merge`/`absorb`. */
  readonly keepId: string;
  readonly keepTitle: string;
  /** The later-created task; the one absorbed or superseded. */
  readonly otherId: string;
  readonly otherTitle: string;
  /** Proposed action. */
  readonly action: ReconcileAction;
  /** Combined similarity in [0,1], max of the lexical and word-level scores. */
  readonly score: number;
  /** `relates` edge `--apply` would write for this pair. */
  readonly relation: 'duplicates' | 'absorbs' | 'related';
  /** Why this action, in one sentence, for a human or an agent to act on. */
  readonly rationale: string;
  /** True when the two sit under the same immediate parent. */
  readonly sameParent: boolean;
}

/** Result of a scope reconciliation sweep. */
export interface ReconcileScopeResult {
  /** Container the sweep was scoped to. */
  readonly rootId: string;
  /** Live tasks compared. */
  readonly scanned: number;
  /** Pairs compared. */
  readonly pairs: number;
  /** Overlapping pairs, worst first. */
  readonly overlaps: ScopeOverlap[];
  /** Relation edges written. Zero unless `apply` was set. */
  readonly applied: number;
  /** Set when the node count exceeded {@link MAX_SWEEP_NODES}. */
  readonly truncated?: { limit: number; liveNodes: number };
}

/** Options for {@link reconcileScope}. */
export interface ReconcileScopeOptions {
  /** Saga, epic or any container to sweep. Its whole subtree is considered. */
  rootId: string;
  /** Write the proposed `relates` edges. Read-only when false or omitted. */
  apply?: boolean;
  /** Report pairs at or above this score. Defaults to {@link OVERLAP_THRESHOLD}. */
  threshold?: number;
}

/**
 * Classify one overlapping pair into an action.
 *
 * The tier and parent relationship decide the action, not the score alone. Two
 * near-identical siblings are a merge; a near-identical pair in DIFFERENT
 * containers is an absorb, because merging across containers silently moves
 * work between epics; and moderate overlap is a split when the two sit apart
 * (extract the shared part) or a link when they are already siblings under one
 * parent, where the overlap is usually intended sequencing.
 */
function classify(
  a: Task,
  b: Task,
  score: number,
): { action: ReconcileAction; relation: ScopeOverlap['relation']; rationale: string } {
  const sameParent = (a.parentId ?? null) === (b.parentId ?? null);
  const sameTier = (a.type ?? 'task') === (b.type ?? 'task');

  if (score >= MERGE_THRESHOLD && sameParent && sameTier) {
    return {
      action: 'merge',
      relation: 'duplicates',
      rationale: `Same tier, same parent, ${(score * 100).toFixed(0)}% scope match — these describe one deliverable.`,
    };
  }
  if (score >= MERGE_THRESHOLD) {
    return {
      action: 'absorb',
      relation: 'absorbs',
      rationale: `${(score * 100).toFixed(0)}% scope match across different containers — fold the later into the earlier rather than merging across parents.`,
    };
  }
  if (!sameParent) {
    return {
      action: 'split',
      relation: 'related',
      rationale: `${(score * 100).toFixed(0)}% shared scope in different containers — extract the shared part so neither owns it by accident.`,
    };
  }
  return {
    action: 'link',
    relation: 'related',
    rationale: `${(score * 100).toFixed(0)}% shared scope between siblings — usually intended sequencing; record the link rather than restructuring.`,
  };
}

/**
 * Sweep a container for tasks whose scope overlaps, and propose what to do.
 *
 * Read-only unless `apply` is set. Even with `apply`, the ONLY mutation is
 * writing `relates` edges — nothing is merged, retitled, reparented or deleted.
 * A sweep that restructured the graph on its own reading of a similarity score
 * would be acting on exactly the judgement it is least qualified to make; the
 * edges make the overlap visible and leave the decision with the caller.
 *
 * Idempotent: `addRelation` upserts, so a second run over an unchanged graph
 * writes the same edges and changes nothing.
 *
 * @param options - Sweep inputs; see {@link ReconcileScopeOptions}.
 * @param cwd - Project root. Defaults to the resolved CLEO project.
 * @param accessor - Optional pre-bound data accessor.
 * @returns The overlaps found, worst first, and how many edges were written.
 * @throws {@link CleoError} `E_NOT_FOUND` when the root does not exist.
 *
 * @example
 * ```ts
 * const r = await reconcileScope({ rootId: 'T12243' });
 * for (const o of r.overlaps) console.log(o.action, o.keepId, o.otherId, o.rationale);
 * ```
 */
export async function reconcileScope(
  options: ReconcileScopeOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<ReconcileScopeResult> {
  const acc = accessor ?? (await getTaskAccessor(cwd));
  const threshold = options.threshold ?? OVERLAP_THRESHOLD;

  // Reject rather than clamp. A threshold that quietly became something else
  // would make two runs of the same command disagree with no way to tell why,
  // and this sweep is meant to be run repeatedly and compared.
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `threshold must be a number between 0 and 1 (got ${JSON.stringify(options.threshold)})`,
      {
        fix: 'Pass --threshold with a value in [0,1], e.g. --threshold 0.6',
        details: { field: 'threshold', expected: '0 <= threshold <= 1', actual: options.threshold },
      },
    );
  }

  const root = await acc.loadSingleTask(options.rootId);
  if (!root) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${options.rootId}`, {
      fix: `cleo find "${options.rootId}"`,
      details: { field: 'rootId', actual: options.rootId },
    });
  }

  const subtree = await acc.getSubtree(options.rootId);
  // The root itself is not a candidate — a container never competes with the
  // work it contains, however closely its title matches.
  const live = subtree
    .filter((t) => t.id !== options.rootId && LIVE_STATUSES.has(t.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const truncated =
    live.length > MAX_SWEEP_NODES ? { limit: MAX_SWEEP_NODES, liveNodes: live.length } : undefined;
  const nodes = truncated ? live.slice(0, MAX_SWEEP_NODES) : live;

  const overlaps: ScopeOverlap[] = [];
  let pairs = 0;

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (!a || !b) continue;
      // Containment is not competition: a subtask legitimately restates its
      // parent's scope, which is what a decomposition IS.
      if (a.parentId === b.id || b.parentId === a.id) continue;
      pairs++;

      // Both scorers weight the title internally; description and labels add
      // signal without letting a long shared boilerplate description swamp two
      // genuinely different deliverables.
      const score = Math.max(
        computeLexicalSimilarity(a.title, a.description ?? '', b.title, b.description ?? ''),
        computeJaccardWordSimilarity(
          a.title,
          a.description ?? '',
          a.labels ?? [],
          b.title,
          b.description ?? '',
          b.labels ?? [],
        ),
      );
      if (score < threshold) continue;

      // `nodes` is createdAt-ascending, so `a` is always the earlier task and
      // therefore the survivor — a stable rule beats "whichever looks better",
      // and it makes the sweep's output reproducible.
      const { action, relation, rationale } = classify(a, b, score);
      overlaps.push({
        keepId: a.id,
        keepTitle: a.title,
        otherId: b.id,
        otherTitle: b.title,
        action,
        score: Number(score.toFixed(4)),
        relation,
        rationale,
        sameParent: (a.parentId ?? null) === (b.parentId ?? null),
      });
    }
  }

  overlaps.sort((x, y) => y.score - x.score);

  let applied = 0;
  if (options.apply) {
    for (const o of overlaps) {
      await acc.addRelation(o.otherId, o.keepId, o.relation, o.rationale);
      applied++;
    }
  }

  return {
    rootId: options.rootId,
    scanned: nodes.length,
    pairs,
    overlaps,
    applied,
    ...(truncated && { truncated }),
  };
}

/**
 * Dispatch-layer wrapper for {@link reconcileScope}.
 *
 * Mirrors `taskDecompose`: converts thrown {@link CleoError}s into an
 * {@link EngineResult} so the gateway renders a LAFS envelope, preserving the
 * original LAFS code rather than blanket-labelling every failure.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param options - Sweep inputs; see {@link ReconcileScopeOptions}.
 * @returns Engine result carrying the overlaps and applied-edge count.
 */
export async function taskReconcileScope(
  projectRoot: string,
  options: ReconcileScopeOptions,
): Promise<EngineResult<ReconcileScopeResult>> {
  try {
    const accessor = await getTaskAccessor(projectRoot);
    return engineSuccess(await reconcileScope(options, projectRoot, accessor));
  } catch (err: unknown) {
    return cleoErrorToEngineResult(err, 'E_INTERNAL', 'Failed to reconcile scope');
  }
}
