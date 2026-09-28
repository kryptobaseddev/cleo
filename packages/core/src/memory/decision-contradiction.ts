/**
 * System One contradiction check for ADR decision writes (T12493).
 *
 * `validateDecisionConflicts` used to find contradictions by asking a
 * generative model for free-form "insights", then scraping decision ids out of
 * the prose with `/\bD\d{3,}\b/` and keeping any insight whose key mentioned
 * "contradict". That call had no timeout, so it could hold a decision write
 * open indefinitely.
 *
 * This module replaces it with ONE `decide()` request:
 *
 * - Candidates are the top {@link MAX_CONTRADICTION_CANDIDATES} prior
 *   decisions by the validator's own word-Jaccard score (score > 0).
 * - Each candidate gets one `choice` question with the options in
 *   {@link CONTRADICTION_RELATIONS}. A contradiction is a typed answer naming a
 *   known candidate id — never an id found in prose.
 * - The whole step, module load included, is bounded by
 *   {@link DECISION_CONTRADICTION_BUDGET_MS}.
 * - Every text field is redacted, then clipped, before it leaves the machine.
 * - A `choice` outside the offered options is rejected here (the client only
 *   checks the answer type), and the heuristic acts.
 *
 * Mode comes from `decide.sites.decisionContradiction` (`off | shadow | on`):
 * `shadow` (the default once a provider is configured) audits the decision
 * next to the heuristic and acts on the heuristic; `on` acts on the decision
 * when every answer has confidence ≥ {@link DECISION_CONTRADICTION_MIN_CONFIDENCE}.
 * No provider configured → `off`, no network call.
 *
 * @task T12493
 * @epic T12486
 */

import type { DecisionAnswer, DecisionQuestion, DecisionRequest } from '@cleocode/contracts';
import type { DecisionAuditAnswer, DecisionAuditEntry } from '../decide/audit.js';
import type { DecideOptions } from '../decide/client.js';
import { type DecisionSiteMode, redactThenClip } from '../decide/site.js';

/**
 * End-to-end budget for the contradiction decision, in milliseconds: module
 * load, redaction, the shared request budget and the HTTP round trip.
 */
export const DECISION_CONTRADICTION_BUDGET_MS = 300;

/** Minimum confidence EVERY answer needs before `on` mode acts on the decision. */
export const DECISION_CONTRADICTION_MIN_CONFIDENCE = 0.6;

/** Maximum prior decisions offered to the decision. */
export const MAX_CONTRADICTION_CANDIDATES = 3;

/** Call-site id for the contradiction decision; keys the audit line. */
export const DECISION_CONTRADICTION_SITE = 'memory.decision-contradiction';

/** Config key selecting the System One mode for the contradiction check. */
export const DECISION_CONTRADICTION_MODE_KEY = 'decide.sites.decisionContradiction';

/**
 * Config key for the older generative-LLM contradiction check (T1828).
 * Absent → on while System One is unconfigured (today's behaviour), off once
 * it is configured.
 */
export const DECISION_CONTRADICTION_LLM_KEY = 'decide.generativeFallback.decisionContradiction';

/** The relations a candidate can have to the new decision; the `choice` options. */
export const CONTRADICTION_RELATIONS = [
  'contradicts',
  'supersedes',
  'refines',
  'unrelated',
] as const;

/** One of {@link CONTRADICTION_RELATIONS}. */
export type ContradictionRelation = (typeof CONTRADICTION_RELATIONS)[number];

/** Per-field character caps; four decisions stay near 2.5 KB of text. */
const DECISION_TEXT_MAX_CHARS = 160;
const DECISION_RATIONALE_MAX_CHARS = 440;

/** Criteria for each option, phrased about question `name`. */
function relationCriteria(name: string): Record<ContradictionRelation, string> {
  return {
    contradicts: `The "new" decision conflicts with decision "${name}": both cannot hold at once, and "new" does not declare that it replaces "${name}".`,
    supersedes: `The "new" decision deliberately replaces or retires decision "${name}" (a change of course).`,
    refines: `The "new" decision narrows, extends or adds detail to decision "${name}" and is consistent with it.`,
    unrelated: `The "new" decision and decision "${name}" concern different subjects, or both can hold independently.`,
  };
}

/** The candidate decision being written. */
export interface ContradictionSubject {
  /** Decision type (e.g. `architecture`). */
  readonly type: string;
  /** Decision text. */
  readonly decision: string;
  /** Rationale text. */
  readonly rationale: string;
  /** Id of the decision this one declares it supersedes, if any. */
  readonly supersedes?: string;
}

/** A prior decision offered to the decision, with its lexical score. */
export interface ContradictionCandidate {
  /** Decision id (e.g. `D042`). */
  readonly id: string;
  /** Decision text. */
  readonly decision: string;
  /** Rationale text. */
  readonly rationale: string;
  /** Word-Jaccard score against the new decision (the heuristic's signal). */
  readonly score: number;
}

/** Options for {@link askContradictionDecision}. */
export interface ContradictionDecisionOptions {
  /** Effective mode (`off` never reaches this function). */
  readonly mode: Exclude<DecisionSiteMode, 'off'>;
  /** The heuristic's overall verdict, in the site's vocabulary (`clear` or `collision`). */
  readonly heuristicVerdict: string;
  /** Collision threshold the heuristic uses per candidate. */
  readonly collisionThreshold: number;
  /** Provider, connection, budget, cache and audit wiring forwarded to `decide()`. */
  readonly decide?: DecideOptions;
  /** Project root for the default audit sink. */
  readonly projectRoot?: string;
}

/** The decision's verdict, when a provider (or its cache) answered with valid options. */
export interface ContradictionVerdict {
  /** Candidate id → decided relation. */
  readonly relations: Readonly<Record<string, ContradictionRelation>>;
  /**
   * Candidate ids the decision judged contradicted. A `contradicts` answer
   * about the decision the new one declares it supersedes is not counted.
   */
  readonly contradictions: readonly string[];
  /** Candidate id → probability of `contradicts`, for every counted contradiction. */
  readonly contradictionProbabilities: Readonly<Record<string, number>>;
  /** Whether every answer met {@link DECISION_CONTRADICTION_MIN_CONFIDENCE}; only then may `on` act. */
  readonly confident: boolean;
}

/** Whether `value` is one of the offered options. */
function isRelation(value: unknown): value is ContradictionRelation {
  return (CONTRADICTION_RELATIONS as readonly unknown[]).includes(value);
}

/** Every question answered with a `choice` whose value is an offered option. */
function answersAreValid(
  answers: Readonly<Record<string, Pick<DecisionAuditAnswer, 'type' | 'value'>>>,
  names: readonly string[],
): boolean {
  return names.every((n) => answers[n]?.type === 'choice' && isRelation(answers[n]?.value));
}

function isConfident(answers: Readonly<Record<string, { readonly confidence: number }>>): boolean {
  return Object.values(answers).every((a) => a.confidence >= DECISION_CONTRADICTION_MIN_CONFIDENCE);
}

/** Question name for the candidate at `index` (0-based). */
function questionName(index: number): string {
  return `c${index + 1}`;
}

/**
 * Build ONE decision request: the new decision plus up to
 * {@link MAX_CONTRADICTION_CANDIDATES} prior decisions as structured state,
 * and one `choice` question per prior decision.
 *
 * @param subject - The decision being written.
 * @param candidates - Prior decisions, highest score first.
 * @param redact - Redaction applied to every text field BEFORE clipping.
 * @returns The request.
 */
export function buildContradictionRequest(
  subject: ContradictionSubject,
  candidates: readonly ContradictionCandidate[],
  redact: (s: string) => string,
): DecisionRequest {
  const clip = (text: string, max: number): string => redactThenClip(text, max, redact);
  const state: Record<string, { id?: string; type?: string; decision: string; rationale: string }> =
    {
      new: {
        type: subject.type,
        decision: clip(subject.decision, DECISION_TEXT_MAX_CHARS),
        rationale: clip(subject.rationale, DECISION_RATIONALE_MAX_CHARS),
      },
    };
  const questions: Record<string, DecisionQuestion> = {};
  candidates.forEach((c, i) => {
    const name = questionName(i);
    state[name] = {
      id: c.id,
      decision: clip(c.decision, DECISION_TEXT_MAX_CHARS),
      rationale: clip(c.rationale, DECISION_RATIONALE_MAX_CHARS),
    };
    questions[name] = { type: 'choice', criteria: relationCriteria(name) };
  });
  return { state, questions };
}

/**
 * The heuristic's answer for one candidate. The lexical heuristic cannot see
 * contradiction, so it always answers `unrelated`; its per-candidate verdict
 * (`collision` / `none`) and raw score go in the shadow record beside it.
 */
function heuristicAnswer(): DecisionAnswer {
  return {
    type: 'choice',
    value: 'unrelated',
    probabilities: { contradicts: 0, supersedes: 0, refines: 0, unrelated: 1 },
    confidence: 0.5,
  };
}

/**
 * Ask System One how each candidate relates to the new decision.
 *
 * Never throws and never waits longer than {@link DECISION_CONTRADICTION_BUDGET_MS}
 * from its own start. The audit line carries the heuristic answers next to the
 * decision answers.
 *
 * @param subject - The decision being written.
 * @param candidates - Prior decisions, highest score first (at most {@link MAX_CONTRADICTION_CANDIDATES}).
 * @param opts - Mode, heuristic verdict and `decide()` wiring.
 * @returns The verdict, or `null` when the heuristic answered (fallback or an out-of-range choice).
 */
export async function askContradictionDecision(
  subject: ContradictionSubject,
  candidates: readonly ContradictionCandidate[],
  opts: ContradictionDecisionOptions,
): Promise<ContradictionVerdict | null> {
  const started = performance.now();
  const deadline = AbortSignal.timeout(DECISION_CONTRADICTION_BUDGET_MS);
  try {
    const { decide } = await import('../decide/client.js');
    const { auditAnswers, createJsonlDecisionAudit } = await import('../decide/audit.js');
    const { redactContent } = await import('./redaction.js');

    const req = buildContradictionRequest(
      subject,
      candidates,
      (text) => redactContent(text).content,
    );
    const names = candidates.map((_, i) => questionName(i));
    const heuristicAnswers: Record<string, DecisionAnswer> = {};
    const subjects: Record<string, string> = {};
    const heuristicVerdicts: Record<string, string> = {};
    const heuristicScores: Record<string, number> = {};
    candidates.forEach((c, i) => {
      const name = questionName(i);
      heuristicAnswers[name] = heuristicAnswer();
      heuristicVerdicts[name] = c.score >= opts.collisionThreshold ? 'collision' : 'none';
      heuristicScores[name] = c.score;
      subjects[name] = c.id;
    });
    const heuristicAudit = auditAnswers({
      answers: heuristicAnswers,
      source: 'fallback',
      latencyMs: 0,
    });

    const wiring = opts.decide ?? {};
    let sink = wiring.audit;
    if (sink === undefined) {
      try {
        const { getProjectRoot } = await import('../paths.js');
        sink = createJsonlDecisionAudit(wiring.projectRoot ?? opts.projectRoot ?? getProjectRoot());
      } catch {
        sink = null;
      }
    }
    const base = sink;
    const audit = base
      ? {
          write: (entry: DecisionAuditEntry): void => {
            const answered = entry.source !== 'fallback';
            const valid = answered && answersAreValid(entry.answers, names);
            base.write({
              ...entry,
              shadow: {
                mode: opts.mode,
                acted:
                  opts.mode === 'on' && valid && isConfident(entry.answers)
                    ? 'decision'
                    : 'heuristic',
                heuristicVerdict: opts.heuristicVerdict,
                heuristicAnswers: heuristicAudit,
                agree: valid
                  ? names.every((n) => entry.answers[n]?.value === heuristicAnswers[n]?.value)
                  : null,
                heuristicVerdicts,
                heuristicScores,
                subjects,
                ...(answered && !valid ? { rejected: 'invalid_choice' as const } : {}),
              },
            });
          },
        }
      : null;

    // The abort signal pins the budget to THIS function's start, so the
    // client's own setup (connection, redaction, validation) is inside it.
    const remaining = Math.max(0, DECISION_CONTRADICTION_BUDGET_MS - (performance.now() - started));
    const outcome = await decide(DECISION_CONTRADICTION_SITE, req, () => heuristicAnswers, {
      ...wiring,
      audit,
      timeoutMs: Math.min(wiring.timeoutMs ?? remaining, remaining),
      signal: wiring.signal ? AbortSignal.any([wiring.signal, deadline]) : deadline,
    });
    if (outcome.source === 'fallback') return null;
    if (!answersAreValid(outcome.answers, names)) return null;

    const relations: Record<string, ContradictionRelation> = {};
    const contradictions: string[] = [];
    const contradictionProbabilities: Record<string, number> = {};
    candidates.forEach((c, i) => {
      const answer = outcome.answers[questionName(i)];
      if (answer?.type !== 'choice' || !isRelation(answer.value)) return;
      relations[c.id] = answer.value;
      if (answer.value === 'contradicts' && c.id !== subject.supersedes) {
        contradictions.push(c.id);
        contradictionProbabilities[c.id] = answer.probabilities['contradicts'] ?? 1;
      }
    });
    return {
      relations,
      contradictions,
      contradictionProbabilities,
      confident: isConfident(outcome.answers),
    };
  } catch {
    return null;
  }
}
