/**
 * Decision-site registry contracts — the "decision ladder as code" (spec
 * `system-one-integration` §3, owner decisions D11158 and D11159).
 *
 * Every place CLEO makes a judgement is a decision site: it has one primary
 * rung, an ordered ladder of rungs it may escalate to, a fallback, an
 * owner-escalation rule, a mode and (to act on a System One answer) go-live
 * evidence. The registry rows live in `packages/core/src/decide/sites/`;
 * these are their types.
 *
 * Types and const data only (arch gate 10).
 *
 * @task T12662
 * @epic T12486
 */

/**
 * The decision rungs, cheapest first. Escalation only moves up this list.
 *
 * - `rule` — the answer follows from data (ids, statuses, thresholds).
 * - `system-one` — a typed judgement over text with a small fixed answer set.
 * - `generative` — the output must be free text or code.
 * - `agent` — multi-step work.
 * - `owner` — authority only the owner can take (the ask tool).
 */
export const DECISION_RUNGS = ['rule', 'system-one', 'generative', 'agent', 'owner'] as const;

/** One rung of the decision ladder. */
export type DecisionRung = (typeof DECISION_RUNGS)[number];

/** Site modes: `off` never asks, `shadow` asks and audits, `on` acts. */
export const DECISION_SITE_MODES = ['off', 'shadow', 'on'] as const;

/** How a site uses its System One rung. */
export type DecisionSiteModeValue = (typeof DECISION_SITE_MODES)[number];

/** The shape of the question a site answers. */
export type DecisionSiteQuestionType =
  | 'noul'
  | 'choice'
  | 'score'
  | 'text'
  | 'multi-step'
  | 'owner-choice';

/**
 * When a site may put a question to the owner.
 *
 * - `never` — the site never asks the owner.
 * - `escalate-only` — it may add an owner question, never clear one.
 * - `below-floor` — it asks the owner when every lower rung is below its floor.
 * - `always` — the owner always decides.
 */
export type DecisionSiteOwnerEscalation = 'never' | 'escalate-only' | 'below-floor' | 'always';

/** Classes of text a site may send off the machine (spec §8). */
export type DecisionSiteTextClass =
  | 'task-text'
  | 'memory-text'
  | 'diff'
  | 'skill-text'
  | 'external-text';

/** Measured evidence that lets a site act on its System One answer (`mode: on`). */
export interface DecisionSiteGoLive {
  /** Canonical doc slug holding the measurement. */
  readonly evidenceDoc: string;
  /** ISO date of the measurement. */
  readonly measuredAt: string;
  /** Number of labelled decisions measured. */
  readonly n: number;
  /** Metric name, e.g. `precision@acting-class`. */
  readonly metric: string;
  /** Measured value. */
  readonly value: number;
  /** Floor the value had to clear. */
  readonly floor: number;
}

/** One registry row: everything CLEO knows about a decision site. */
export interface DecisionSiteDefinition {
  /** Site id; the string `decide()` and the audit log use, e.g. `tasks.duplicate-detection`. */
  readonly id: string;
  /** Human title. */
  readonly title: string;
  /** Repo-relative files where the site lives. */
  readonly files: readonly string[];
  /** The shape of the question. */
  readonly questionType: DecisionSiteQuestionType;
  /** The rung that answers first. */
  readonly primaryRung: DecisionRung;
  /** Rungs it may escalate to, in order, all above the primary. */
  readonly ladder: readonly DecisionRung[];
  /** What acts when the primary is unavailable. */
  readonly fallback: DecisionRung | 'none';
  /**
   * Minimum confidence per question before `on` may act on a System One
   * answer. The key `*` applies to every question of the site.
   */
  readonly floors?: Readonly<Record<string, number>>;
  /** When the site may ask the owner. */
  readonly ownerEscalation: DecisionSiteOwnerEscalation;
  /** Config key holding the mode (the existing `decide.sites.*` keys, D11159). */
  readonly modeKey?: string;
  /** Config key opting the site into its generative rung (`decide.generativeFallback.*`). */
  readonly generativeKey?: string;
  /** Mode when the config key is unset. */
  readonly defaultMode: DecisionSiteModeValue;
  /** Generative rung: the role or system key it resolves its model with. */
  readonly llmSystemKey?: string;
  /** True for a site on a write path: 300 ms budget, never blocks the write. */
  readonly writePath: boolean;
  /** Text classes it sends to a provider. */
  readonly sends: readonly DecisionSiteTextClass[];
  /** Go-live evidence, required before a System One site runs `on`. */
  readonly goLive?: DecisionSiteGoLive;
  /** Owning task. */
  readonly task: string;
  /** Free-form note (constraints such as "interactive only"). */
  readonly note?: string;
}

/** Audit counts for one site over the last seven days. */
export interface DecisionSiteActivity {
  /** Audit lines written for the site. */
  readonly asked: number;
  /** Answered by the provider. */
  readonly provider: number;
  /** Answered from the decision cache. */
  readonly cache: number;
  /** Answered by the fallback. */
  readonly fallback: number;
  /** Escalated to a higher rung (0 until the ladder executor lands, T12665). */
  readonly escalated: number;
  /** Share of compared shadow lines where decision and heuristic agreed, when any were compared. */
  readonly agreement?: number;
}

/** One site as `cleo decide sites` reports it. */
export interface DecisionSiteSummary {
  /** Site id. */
  readonly id: string;
  /** Human title. */
  readonly title: string;
  /** Question shape. */
  readonly questionType: DecisionSiteQuestionType;
  /** Primary rung. */
  readonly primaryRung: DecisionRung;
  /** Escalation ladder. */
  readonly ladder: readonly DecisionRung[];
  /** Fallback. */
  readonly fallback: DecisionRung | 'none';
  /** Owner-escalation rule. */
  readonly ownerEscalation: DecisionSiteOwnerEscalation;
  /** Registry default mode. */
  readonly mode: DecisionSiteModeValue;
  /** Mode set in config, when the site has a mode key and it is set. */
  readonly configuredMode?: DecisionSiteModeValue;
  /** Mode in force: `off` for a System One site while no provider is configured. */
  readonly effectiveMode: DecisionSiteModeValue;
  /** Config key holding the mode, when the site has one. */
  readonly modeKey?: string;
  /** Go-live evidence, when recorded. */
  readonly goLive?: DecisionSiteGoLive;
  /** Owning task. */
  readonly task: string;
  /** Audit activity over the last seven days. */
  readonly last7d: DecisionSiteActivity;
}

/** Result of `cleo decide sites`. */
export interface DecisionSitesListResult {
  /** Whether a System One provider is configured (else System One sites are `off`). */
  readonly providerConfigured: boolean;
  /** Registered sites total, before filters. */
  readonly total: number;
  /** Matching sites. */
  readonly sites: readonly DecisionSiteSummary[];
}
