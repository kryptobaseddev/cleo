/**
 * Decision audit trail — one JSONL line per decision in
 * `.cleo/audit/decisions.jsonl`.
 *
 * Each line records the site, provider request id, a hash of the questions,
 * every answer with its probabilities and confidence, the outcome source
 * (provider / cache / fallback, plus the fallback reason), latency and cost.
 *
 * It NEVER records the API key, the base URL's credentials, or the raw state —
 * only hashes of the request. Writes are synchronous single-line appends (a
 * few microseconds, so they do not eat into a sub-second decision budget) and
 * are swallowed on failure: auditing must never break a decision.
 *
 * @task T12490
 * @epic T12486
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DecisionAnswer, DecisionOutcome, DecisionOutcomeSource } from '@cleocode/contracts';

/** Project-relative path of the decision audit log. */
export const DECISION_AUDIT_FILE = '.cleo/audit/decisions.jsonl';

/** Why a fallback was used (absent for provider/cache outcomes). */
export type DecisionFallbackReason =
  | 'unconfigured'
  | 'invalid_request'
  | 'budget_exhausted'
  | 'budget_cooling_down'
  | 'budget_unavailable'
  | 'timeout'
  | 'unauthorized'
  | 'insufficient_credits'
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'invalid_response'
  | 'provider_error';

/** One audited answer: the decided value plus its distribution. */
export interface DecisionAuditAnswer {
  /** Question type. */
  readonly type: DecisionAnswer['type'];
  /** Decided value. */
  readonly value: DecisionAnswer['value'];
  /** Probability of "yes" (noul only). */
  readonly probability?: number;
  /** Per-option / per-level probabilities (choice and score). */
  readonly probabilities?: Readonly<Record<string, number>> | readonly number[];
  /** Model confidence. */
  readonly confidence: number;
}

/**
 * Shadow-mode comparison attached to an audit line by a call site that asks
 * the provider while still acting (or able to act) on its own heuristic.
 *
 * It puts the heuristic's answers next to the decision answers of the same
 * line, so agreement can be measured before a site switches to acting on the
 * decision.
 */
export interface DecisionShadowRecord {
  /** Site mode: `shadow` acts on the heuristic; `on` acts on the decision when one arrived. */
  readonly mode: 'shadow' | 'on';
  /** Which answer the site acted on. */
  readonly acted: 'heuristic' | 'decision';
  /** The heuristic's overall verdict, in the site's own vocabulary (e.g. `insert`, `warn`). */
  readonly heuristicVerdict: string;
  /** The heuristic's answer to every question, in audit form. */
  readonly heuristicAnswers: Readonly<Record<string, DecisionAuditAnswer>>;
  /**
   * Whether every decided value matches the heuristic's value. `null` when no
   * provider answer was available (fallback), so there was nothing to compare.
   */
  readonly agree: boolean | null;
  /** Question name → the heuristic's own verdict for it, in the site's vocabulary (e.g. `warn`, `pass`). */
  readonly heuristicVerdicts?: Readonly<Record<string, string>>;
  /** Question name → the raw score the heuristic's verdict came from (e.g. Tier-1 similarity). */
  readonly heuristicScores?: Readonly<Record<string, number>>;
  /** Question name → the subject it asks about (e.g. a task id). */
  readonly subjects?: Readonly<Record<string, string>>;
  /**
   * Set when the provider answered but the call site refused the answer, so
   * the heuristic acted. `invalid_choice`: a `choice` value outside the
   * offered options (T12493).
   */
  readonly rejected?: 'invalid_choice';
}

/** One line of `.cleo/audit/decisions.jsonl`. */
export interface DecisionAuditEntry {
  /** ISO-8601 timestamp. */
  readonly timestamp: string;
  /** Call-site identifier passed to `decide()`. */
  readonly site: string;
  /** Provider request id, when the outcome came from (or was cached from) a provider. */
  readonly requestId?: string;
  /** sha256 of the canonical question set. */
  readonly questionsHash: string;
  /** sha256 of the canonical (redacted) state — lets repeats be correlated without storing it. */
  readonly stateHash: string;
  /** Question name → audited answer. */
  readonly answers: Readonly<Record<string, DecisionAuditAnswer>>;
  /** Where the outcome came from. */
  readonly source: DecisionOutcomeSource;
  /** Why the fallback was used (fallback only). */
  readonly fallbackReason?: DecisionFallbackReason;
  /** Wall-clock latency of the whole `decide()` call, ms. */
  readonly latencyMs: number;
  /** Provider-reported cost in USD, when known. */
  readonly costUsd?: number;
  /** Model the request named, when it named one. */
  readonly model?: string;
  /** Shadow-mode comparison, when the call site recorded one. */
  readonly shadow?: DecisionShadowRecord;
}

/** Destination for audit entries. Implementations never throw. */
export interface DecisionAuditSink {
  /** Record one entry. */
  write(entry: DecisionAuditEntry): void;
}

/**
 * Project an outcome's answers into audit form.
 *
 * @param outcome - The outcome to audit.
 * @returns Question name → audited answer.
 */
export function auditAnswers(outcome: DecisionOutcome): Record<string, DecisionAuditAnswer> {
  const out: Record<string, DecisionAuditAnswer> = {};
  for (const [name, a] of Object.entries(outcome.answers)) {
    out[name] =
      a.type === 'noul'
        ? { type: a.type, value: a.value, probability: a.probability, confidence: a.confidence }
        : {
            type: a.type,
            value: a.value,
            probabilities: a.probabilities,
            confidence: a.confidence,
          };
  }
  return out;
}

/** Size at which `decisions.jsonl` is rotated, in bytes. */
export const DEFAULT_DECISION_AUDIT_MAX_BYTES = 5 * 1024 * 1024;

/** Rotated generations kept beside the live file (`decisions.jsonl.1` … `.N`). */
export const DEFAULT_DECISION_AUDIT_KEEP = 3;

/** Rotation bounds for {@link createJsonlDecisionAudit}. */
export interface DecisionAuditRotation {
  /** Rotate once the live file reaches this size. Default {@link DEFAULT_DECISION_AUDIT_MAX_BYTES}. */
  readonly maxBytes?: number;
  /** Older generations to keep. Default {@link DEFAULT_DECISION_AUDIT_KEEP}. */
  readonly keep?: number;
}

/** Shift `file` → `file.1` → … → `file.keep`, dropping the oldest. */
function rotate(file: string, keep: number): void {
  rmSync(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    try {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch {
      // Generation absent — nothing to shift.
    }
  }
  if (keep >= 1) renameSync(file, `${file}.1`);
  else rmSync(file, { force: true });
}

/**
 * A sink appending to `<projectRoot>/.cleo/audit/decisions.jsonl`, rotated by
 * size so the audit stays bounded (at most `(keep + 1) × maxBytes`, plus one
 * line). Rotation is a stat and at most a few renames — cheap enough for the
 * decision budget.
 *
 * @param projectRoot - Absolute project root.
 * @param rotation - Size cap and generations kept.
 * @returns A never-throwing {@link DecisionAuditSink}.
 */
export function createJsonlDecisionAudit(
  projectRoot: string,
  rotation: DecisionAuditRotation = {},
): DecisionAuditSink {
  const dir = join(projectRoot, '.cleo', 'audit');
  const file = join(dir, 'decisions.jsonl');
  const maxBytes = Math.max(1, rotation.maxBytes ?? DEFAULT_DECISION_AUDIT_MAX_BYTES);
  const keep = Math.max(0, Math.floor(rotation.keep ?? DEFAULT_DECISION_AUDIT_KEEP));
  return {
    write(entry) {
      try {
        mkdirSync(dir, { recursive: true });
        let size = 0;
        try {
          size = statSync(file).size;
        } catch {
          // No live file yet.
        }
        if (size >= maxBytes) rotate(file, keep);
        appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf-8');
      } catch {
        // Auditing must never break a decision.
      }
    },
  };
}
