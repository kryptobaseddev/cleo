/**
 * System One judgments for `cleo docs modernize` (T14113).
 *
 * Two registered sites, asked only when a rule is unsure:
 *
 * - `docs.modernize.classify` — which kind is a doc whose folder, name and
 *   headings did not settle it (rule confidence below the floor).
 * - `docs.modernize.merge` — are two docs that share a slug one doc, when
 *   their similarity sits in the middle band.
 *
 * Every ask goes through {@link askSiteDecision}: budgeted, audited to
 * `decisions.jsonl` beside the rule answer, and never throwing. With no
 * provider configured the site resolves to `off` and the rule answers with
 * zero network; in `shadow` (the default) the provider is asked and recorded
 * but the rule acts; only `on` with a confident, valid answer acts on it.
 * Each call returns a {@link DocsModernizeJudgment} the plan row carries.
 *
 * @task T14113
 * @epic T14106
 */

import type {
  DecisionAnswer,
  DecisionRequest,
  DocsModernizeJudgment,
  DocsModernizeJudgmentQuestion,
} from '@cleocode/contracts';
import type { DecideOptions } from '../../decide/client.js';
import type { AskSiteDecisionInput, DecisionSiteMode, SiteDecision } from '../../decide/site.js';
import {
  DOC_MODERNIZE_CLASSIFY_SITE,
  DOC_MODERNIZE_MERGE_SITE,
} from '../../decide/sites/registry.js';

/** Wait budget per question, in ms. Modernize is a batch job, not a hot path. */
export const MODERNIZE_DECISION_BUDGET_MS = 5_000;

/** Minimum confidence before `on` mode acts on a decided answer. */
export const MODERNIZE_MIN_CONFIDENCE = 0.6;

/** Characters of body sent per doc. */
const EXCERPT_MAX_CHARS = 1_500;

/** Characters of a path or title sent. */
const LABEL_MAX_CHARS = 200;

/** The merge question's options. */
const MERGE_OPTIONS = ['merge', 'separate'] as const;

/** Effective modes for both sites, resolved once per run. */
export interface ModernizeJudgeSettings {
  /** Mode of `docs.modernize.classify`. */
  readonly classifyMode: DecisionSiteMode;
  /** Mode of `docs.modernize.merge`. */
  readonly mergeMode: DecisionSiteMode;
  /** Provider wiring forwarded to `decide()` (tests inject a provider here). */
  readonly wiring?: DecideOptions;
  /** Project root for config and the audit sink. */
  readonly projectRoot: string;
}

/**
 * Resolve both sites' modes. Unconfigured System One resolves to `off`.
 *
 * @param projectRoot - Project root for config lookup.
 * @param wiring - Optional provider wiring.
 * @param mode - Optional explicit mode for both sites.
 * @returns The settings for one run.
 */
export async function resolveModernizeJudgeSettings(
  projectRoot: string,
  wiring?: DecideOptions,
  mode?: DecisionSiteMode,
): Promise<ModernizeJudgeSettings> {
  const { resolveDecisionSiteSettings } = await import('../../decide/site.js');
  const [classify, merge] = await Promise.all([
    resolveDecisionSiteSettings({
      modeKey: DOC_MODERNIZE_CLASSIFY_SITE.modeKey,
      mode,
      wiring,
      projectRoot,
    }),
    resolveDecisionSiteSettings({
      modeKey: DOC_MODERNIZE_MERGE_SITE.modeKey,
      mode,
      wiring,
      projectRoot,
    }),
  ]);
  return { classifyMode: classify.mode, mergeMode: merge.mode, wiring, projectRoot };
}

/** A one-hot choice answer standing for the rule. */
function ruleAnswer(options: readonly string[], value: string, confidence: number): DecisionAnswer {
  return {
    type: 'choice',
    value,
    probabilities: Object.fromEntries(options.map((o) => [o, o === value ? 1 : 0])),
    confidence,
  };
}

/** The site-independent part of an `askSiteDecision` input. */
type ChoiceAsk = Omit<AskSiteDecisionInput, 'siteId'>;

/**
 * Ask one choice question and fold the outcome into a judgment. `ask` calls
 * `askSiteDecision` with the registered site id (gate 35 reads it there).
 */
async function judgeChoice(input: {
  readonly question: DocsModernizeJudgmentQuestion;
  readonly siteId: string;
  readonly mode: DecisionSiteMode;
  readonly options: readonly string[];
  readonly rule: string;
  readonly ruleConfidence: number;
  readonly buildRequest: (redact: (s: string) => string) => DecisionRequest;
  readonly settings: ModernizeJudgeSettings;
  readonly ask: (common: ChoiceAsk) => Promise<SiteDecision | null>;
}): Promise<DocsModernizeJudgment> {
  const base = {
    question: input.question,
    site: input.siteId,
    mode: input.mode,
    ruleAnswer: input.rule,
  } as const;
  const fallback: DocsModernizeJudgment = {
    ...base,
    decidedAnswer: null,
    decidedConfidence: null,
    source: 'fallback',
    acted: input.rule,
  };
  if (input.mode === 'off') return fallback;
  const name = input.question;
  const decision = await input.ask({
    budgetMs: MODERNIZE_DECISION_BUDGET_MS,
    minConfidence: MODERNIZE_MIN_CONFIDENCE,
    mode: input.mode,
    heuristicVerdict: input.rule,
    buildRequest: input.buildRequest,
    heuristicAnswers: { [name]: ruleAnswer(input.options, input.rule, input.ruleConfidence) },
    isValid: (answers) => {
      const a = answers[name];
      return a?.type === 'choice' && typeof a.value === 'string' && input.options.includes(a.value);
    },
    agree: (answers) => answers[name]?.value === input.rule,
    wiring: input.settings.wiring,
    projectRoot: input.settings.projectRoot,
  });
  const answer = decision?.answers[name];
  if (!decision || answer?.type !== 'choice') return fallback;
  const acts = input.mode === 'on' && decision.confident;
  return {
    ...base,
    decidedAnswer: answer.value,
    decidedConfidence: answer.confidence,
    source: decision.source,
    acted: acts ? answer.value : input.rule,
  };
}

/**
 * Judge the kind of a doc the rules were unsure about.
 *
 * @param input - The doc, the rule's kind and confidence, and the offered kinds.
 * @param settings - Run settings.
 * @returns The judgment; `acted` is the kind the plan uses.
 */
export async function judgeDocKind(
  input: {
    readonly path: string;
    readonly title: string;
    readonly content: string;
    readonly ruleKind: string;
    readonly ruleConfidence: number;
    readonly kinds: ReadonlyArray<{ readonly kind: string; readonly description: string }>;
  },
  settings: ModernizeJudgeSettings,
): Promise<DocsModernizeJudgment> {
  const { askSiteDecision, redactThenClip } = await import('../../decide/site.js');
  return judgeChoice({
    ask: (common) => askSiteDecision({ siteId: DOC_MODERNIZE_CLASSIFY_SITE.id, ...common }),
    question: 'classify',
    siteId: DOC_MODERNIZE_CLASSIFY_SITE.id,
    mode: settings.classifyMode,
    options: input.kinds.map((k) => k.kind),
    rule: input.ruleKind,
    ruleConfidence: input.ruleConfidence,
    settings,
    buildRequest: (redact) => ({
      state: {
        path: redactThenClip(input.path, LABEL_MAX_CHARS, redact),
        title: redactThenClip(input.title, LABEL_MAX_CHARS, redact),
        excerpt: redactThenClip(input.content, EXCERPT_MAX_CHARS, redact),
      },
      questions: {
        classify: {
          type: 'choice',
          criteria: Object.fromEntries(input.kinds.map((k) => [k.kind, k.description])),
        },
      },
    }),
  });
}

/**
 * Judge whether two docs that share a slug are one doc.
 *
 * @param input - Both docs and their line similarity.
 * @param settings - Run settings.
 * @returns The judgment; `acted` is `merge` or `separate`.
 */
export async function judgeDocMerge(
  input: {
    readonly left: { readonly path: string; readonly content: string };
    readonly right: { readonly path: string; readonly content: string };
    readonly similarity: number;
    readonly rule: 'merge' | 'separate';
  },
  settings: ModernizeJudgeSettings,
): Promise<DocsModernizeJudgment> {
  const { askSiteDecision, redactThenClip } = await import('../../decide/site.js');
  return judgeChoice({
    ask: (common) => askSiteDecision({ siteId: DOC_MODERNIZE_MERGE_SITE.id, ...common }),
    question: 'merge',
    siteId: DOC_MODERNIZE_MERGE_SITE.id,
    mode: settings.mergeMode,
    options: MERGE_OPTIONS,
    rule: input.rule,
    ruleConfidence: 0.5,
    settings,
    buildRequest: (redact) => ({
      state: {
        firstPath: redactThenClip(input.left.path, LABEL_MAX_CHARS, redact),
        firstExcerpt: redactThenClip(input.left.content, EXCERPT_MAX_CHARS, redact),
        secondPath: redactThenClip(input.right.path, LABEL_MAX_CHARS, redact),
        secondExcerpt: redactThenClip(input.right.content, EXCERPT_MAX_CHARS, redact),
        lineSimilarity: Math.round(input.similarity * 100) / 100,
      },
      questions: {
        merge: {
          type: 'choice',
          criteria: {
            merge:
              'Both documents cover the same subject; one is an older, partial or alternate version of the other and they should become one document.',
            separate:
              'The documents cover different subjects that happen to share a name; both should stay as separate documents.',
          },
        },
      },
    }),
  });
}
