/**
 * System One needs-human-decision check for the readiness grill gate (T12494).
 *
 * `classifyReadiness` flags `OWNER_DECISION_REQUIRED` when `blockedBy`
 * contains "owner" or "decision" as a substring, so "blocked on T12 (decision
 * store refactor)" grills and "waiting on legal to choose a vendor" does not.
 * This module asks ONE `noul` question — "does this block need a human
 * owner's decision, approval or choice?" — and hands the answer to the pure
 * predicate as {@link ReadinessSignals.ownerDecision}.
 *
 * Escalate-only: the answer can ADD the flag the substring rule missed, never
 * clear one the rule or the label raised (a false positive stays a grill).
 * Silently removing a flag would route around the owner. A flagged task
 * grills, and the grill is routed to the owner through the orchestrator's ask
 * tool (the HITL rule); System One never answers the owner's question itself.
 *
 * - Asked only when the task has a non-blank `blockedBy` and no
 *   `owner-decision` label (the label is authoritative). In `on` mode it is
 *   also skipped when the substring rule already flags: an answer could not
 *   change the verdict. `shadow` still asks, so the audit measures agreement.
 * - Title, `blockedBy` and description are redacted, then clipped, before they
 *   leave the machine.
 * - Bounded by {@link OWNER_DECISION_BUDGET_MS}, module load included.
 *
 * Mode comes from `decide.sites.ownerDecision` (`off | shadow | on`): `shadow`
 * (the default once a provider is configured) audits the answer next to the
 * substring rule and returns no signal, so the verdict is unchanged; `on`
 * returns the signal, which the predicate uses to add a flag when its
 * confidence is at least {@link OWNER_DECISION_MIN_CONFIDENCE}. No provider configured → `off`, no
 * network call.
 *
 * @task T12494
 * @epic T12486
 */

import type { DecisionAnswer, DecisionRequest, Task } from '@cleocode/contracts';
import type { DecideOptions } from '../decide/client.js';
import { type DecisionSiteMode, redactThenClip } from '../decide/site.js';
import {
  blockedByMentionsOwnerDecision,
  classifyReadiness,
  OWNER_DECISION_MIN_CONFIDENCE,
  type OwnerDecisionSignal,
  type ReadinessResult,
  type ReadinessSignals,
} from './classify-readiness.js';

/** End-to-end budget for the owner-decision question, in milliseconds. */
export const OWNER_DECISION_BUDGET_MS = 300;

/** Call-site id for the owner-decision question; keys the audit line. */
export const OWNER_DECISION_SITE = 'orchestration.owner-decision';

/** Config key selecting the System One mode for the owner-decision check. */
export const OWNER_DECISION_MODE_KEY = 'decide.sites.ownerDecision';

/** Label that already marks an owner decision; mirrors `classify-readiness.ts`. */
const OWNER_DECISION_LABEL = 'owner-decision';

/** The single question's name. */
const QUESTION = 'owner';

/** Per-field character caps. */
const TITLE_MAX_CHARS = 160;
const BLOCKED_BY_MAX_CHARS = 300;
const DESCRIPTION_MAX_CHARS = 440;

const CRITERIA =
  'Work on this task cannot start until a human owner makes a decision, approval or choice ' +
  '(as described by "blockedBy"). It is NOT enough to be waiting on another task, a tool, ' +
  'a build, an external service or another agent.';

/**
 * Build the decision request: title, `blockedBy` and description as state and
 * one `noul` question.
 *
 * @param task - The task being classified.
 * @param redact - Redaction applied to every field BEFORE clipping.
 * @returns The request.
 */
export function buildOwnerDecisionRequest(
  task: Pick<Task, 'title' | 'blockedBy' | 'description'>,
  redact: (s: string) => string,
): DecisionRequest {
  return {
    state: {
      title: redactThenClip(task.title, TITLE_MAX_CHARS, redact),
      blockedBy: redactThenClip(task.blockedBy ?? '', BLOCKED_BY_MAX_CHARS, redact),
      description: redactThenClip(task.description ?? '', DESCRIPTION_MAX_CHARS, redact),
    },
    questions: { [QUESTION]: { type: 'noul', criteria: CRITERIA } },
  };
}

/** Options for {@link resolveOwnerDecisionSignal}. */
export interface OwnerDecisionOptions {
  /** Explicit mode; wins over config when a provider is configured. */
  readonly mode?: DecisionSiteMode;
  /** Provider, connection, budget, cache and audit wiring forwarded to `decide()`. */
  readonly decide?: DecideOptions;
  /** Project root for config lookup and the default audit sink. */
  readonly projectRoot?: string;
}

/**
 * Ask System One whether the task's `blockedBy` needs an owner decision.
 *
 * Never throws and never waits longer than {@link OWNER_DECISION_BUDGET_MS}
 * once a decision is asked.
 *
 * @param task - The task being classified.
 * @param opts - Mode, wiring and project root.
 * @returns The signal in `on` mode when a valid answer arrived; otherwise `null`
 *   (not asked, `shadow`, or fallback) — and the substring rule decides.
 */
export async function resolveOwnerDecisionSignal(
  task: Task,
  opts: OwnerDecisionOptions = {},
): Promise<OwnerDecisionSignal | null> {
  if ((task.blockedBy ?? '').trim() === '') return null;
  if ((task.labels ?? []).some((l) => l.toLowerCase() === OWNER_DECISION_LABEL)) return null;
  try {
    const { askSiteDecision, resolveDecisionSiteSettings } = await import('../decide/site.js');
    const { mode } = await resolveDecisionSiteSettings({
      modeKey: OWNER_DECISION_MODE_KEY,
      mode: opts.mode,
      wiring: opts.decide,
      projectRoot: opts.projectRoot,
    });
    if (mode === 'off') return null;

    const substring = blockedByMentionsOwnerDecision(task);
    // Escalate-only: once the rule flags, no answer can change the verdict.
    if (mode === 'on' && substring) return null;
    const heuristicAnswer: DecisionAnswer = {
      type: 'noul',
      value: substring,
      probability: substring ? 1 : 0,
      confidence: 0.5,
    };
    const decision = await askSiteDecision({
      siteId: OWNER_DECISION_SITE,
      budgetMs: OWNER_DECISION_BUDGET_MS,
      minConfidence: OWNER_DECISION_MIN_CONFIDENCE,
      mode,
      heuristicVerdict: substring ? 'owner-decision' : 'none',
      buildRequest: (redact) => buildOwnerDecisionRequest(task, redact),
      heuristicAnswers: { [QUESTION]: heuristicAnswer },
      agree: (answers) => answers[QUESTION]?.value === substring,
      shadowExtras: { subjects: { [QUESTION]: task.id } },
      wiring: opts.decide,
      projectRoot: opts.projectRoot,
    });
    const answer = decision?.answers[QUESTION];
    if (mode !== 'on' || answer?.type !== 'noul') return null;
    return {
      required: answer.value,
      probability: answer.probability,
      confidence: answer.confidence,
    };
  } catch {
    return null;
  }
}

/**
 * {@link classifyReadiness} with the owner-decision signal resolved first.
 *
 * Equivalent to `classifyReadiness(task, signals)` whenever System One is
 * unconfigured, `off`, `shadow`, or does not answer in budget.
 *
 * @param task - Task record to classify.
 * @param signals - Pre-fetched supporting state; an explicit `ownerDecision` is kept.
 * @param opts - Mode, wiring and project root for the owner-decision question.
 * @returns The readiness verdict.
 */
export async function classifyReadinessWithDecision(
  task: Task,
  signals: ReadinessSignals = {},
  opts: OwnerDecisionOptions = {},
): Promise<ReadinessResult> {
  const ownerDecision =
    signals.ownerDecision !== undefined
      ? signals.ownerDecision
      : await resolveOwnerDecisionSignal(task, opts);
  return classifyReadiness(task, { ...signals, ownerDecision });
}
