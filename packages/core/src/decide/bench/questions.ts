/**
 * Turn a benchmark row into the exact question its decision site asks, the
 * site's heuristic answer, and the mapping from an answer back to a label
 * (T12495).
 *
 * The request builders are the sites' own (`buildDuplicateDecisionRequest`,
 * `buildObservationTypeRequest`, `buildContradictionRequest`), so the
 * benchmark measures the production wording. The heuristic is the rule each
 * site falls back to: Tier-1 lexical similarity for duplicates, whole-word
 * keywords for observation types, the word-Jaccard collision check for
 * decisions.
 *
 * @task T12495
 * @epic T12486
 */

import type { DecisionAnswer, DecisionRequest } from '@cleocode/contracts';
import {
  buildContradictionRequest,
  CONTRADICTION_RELATIONS,
} from '../../memory/decision-contradiction.js';
import { DECISION_COLLISION_THRESHOLD, decisionWordJaccard } from '../../memory/decisions.js';
import {
  buildObservationTypeRequest,
  classifyObservationTypeByKeywords,
  OBSERVATION_TYPE_OPTIONS,
} from '../../memory/observation-type-decision.js';
import { redactContent } from '../../memory/redaction.js';
import {
  buildDuplicateDecisionRequest,
  computeLexicalSimilarity,
  DUPLICATE_WARN_THRESHOLD,
} from '../../tasks/duplicate-detector.js';
import type { BenchRow } from './types.js';

/** One row made ready to ask. */
export interface BenchQuestion {
  /** The site's request, with `cache: false` (no provider answer cache). */
  readonly req: DecisionRequest;
  /** The site heuristic's answers, in the request's shape (the fallback). */
  readonly heuristicAnswers: Readonly<Record<string, DecisionAnswer>>;
  /** The label the heuristic predicts. */
  readonly heuristicLabel: string;
  /**
   * Map answers back to a label.
   *
   * @returns The predicted label, or `null` when the answer is unusable.
   */
  readonly predict: (answers: Readonly<Record<string, DecisionAnswer>>) => string | null;
}

/** The redaction System One applies (idempotent on already-redacted text). */
const redact = (text: string): string => redactContent(text).content;

/** Numeric part of a task id, for "which task is newer". */
function taskNumber(id: string): number {
  const n = Number(/\d+/.exec(id)?.[0] ?? Number.NaN);
  return Number.isFinite(n) ? n : 0;
}

/** Question name the site builders give the first (only) candidate. */
const FIRST = 'c1';

/**
 * Build the question for `row`.
 *
 * @param row - A dataset row.
 * @returns Request, heuristic answer and label mapping.
 */
export function benchQuestionFor(row: BenchRow): BenchQuestion {
  if (row.site === 'duplicateDetection') {
    // The later-created task (higher id) plays the "new" task.
    const [candidate, fresh] =
      taskNumber(row.input.a.id) <= taskNumber(row.input.b.id)
        ? [row.input.a, row.input.b]
        : [row.input.b, row.input.a];
    const score = computeLexicalSimilarity(
      fresh.title,
      fresh.description,
      candidate.title,
      candidate.description,
    );
    const dup = score >= DUPLICATE_WARN_THRESHOLD;
    const req = buildDuplicateDecisionRequest(
      fresh.title,
      fresh.description,
      [{ task: candidate }],
      redact,
    );
    return {
      req: { ...req, cache: false },
      heuristicAnswers: {
        [FIRST]: {
          type: 'noul',
          value: dup,
          probability: Math.min(1, Math.max(0, score)),
          confidence: 0.5,
        },
      },
      heuristicLabel: dup ? 'duplicate' : 'distinct',
      predict: (answers) => {
        const a = answers[FIRST];
        if (a?.type !== 'noul') return null;
        return a.value ? 'duplicate' : 'distinct';
      },
    };
  }

  if (row.site === 'observationType') {
    const guess = classifyObservationTypeByKeywords(row.input.text);
    const req = buildObservationTypeRequest(row.input.text, row.input.title || undefined, redact);
    const probabilities: Record<string, number> = {};
    for (const o of OBSERVATION_TYPE_OPTIONS) probabilities[o] = o === guess ? 1 : 0;
    return {
      req: { ...req, cache: false },
      heuristicAnswers: { type: { type: 'choice', value: guess, probabilities, confidence: 0.5 } },
      heuristicLabel: guess,
      predict: (answers) => {
        const a = answers['type'];
        if (a?.type !== 'choice') return null;
        return OBSERVATION_TYPE_OPTIONS.some((o) => o === a.value) ? a.value : null;
      },
    };
  }

  const { newer, older } = row.input;
  const collision = decisionWordJaccard(newer, older) >= DECISION_COLLISION_THRESHOLD;
  const req = buildContradictionRequest(
    // The declared `supersedes` is deliberately NOT sent: it is the label.
    { type: newer.type ?? 'unknown', decision: newer.decision, rationale: newer.rationale },
    [{ id: older.id, decision: older.decision, rationale: older.rationale, score: 0 }],
    redact,
  );
  const guess = collision ? 'supersedes' : 'unrelated';
  const probabilities: Record<string, number> = {};
  for (const r of CONTRADICTION_RELATIONS) probabilities[r] = r === guess ? 1 : 0;
  return {
    req: { ...req, cache: false },
    heuristicAnswers: { [FIRST]: { type: 'choice', value: guess, probabilities, confidence: 0.5 } },
    heuristicLabel: collision ? 'conflict' : 'compatible',
    predict: (answers) => {
      const a = answers[FIRST];
      if (a?.type !== 'choice') return null;
      if (a.value === 'contradicts' || a.value === 'supersedes') return 'conflict';
      if (a.value === 'refines' || a.value === 'unrelated') return 'compatible';
      return null;
    },
  };
}
