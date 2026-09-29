/**
 * System One choice of observation type when the caller gave none (T12494).
 *
 * `observeBrain` without `type` used to pick one by substring keywords, so
 * "address" counted as `add` and filed as a `feature`. The keyword heuristic
 * now matches whole words (with common inflections), and when a System One
 * provider is configured the type can come from ONE `choice` question instead:
 *
 * - The options are {@link OBSERVATION_TYPE_OPTIONS} — the types the keyword
 *   heuristic can produce. A `choice` outside them is rejected and the
 *   heuristic acts.
 * - The title and text are redacted, then clipped, before they leave the
 *   machine.
 * - Provider wait is bounded by {@link OBSERVATION_TYPE_BUDGET_MS}; the budget
 *   starts once the decision modules are loaded.
 *
 * Mode comes from `decide.sites.observationType` (`off | shadow | on`):
 * `shadow` (the default once a provider is configured) audits the decision
 * next to the keyword answer and keeps the keyword type; `on` uses the decided
 * type when its confidence is ≥ {@link OBSERVATION_TYPE_MIN_CONFIDENCE}.
 * No provider configured → `off`, no network call.
 *
 * @task T12494
 * @epic T12486
 */

import type { BrainObservationType, DecisionAnswer, DecisionRequest } from '@cleocode/contracts';
import type { DecideOptions } from '../decide/client.js';
import { type DecisionSiteMode, redactThenClip } from '../decide/site.js';
import { OBSERVATION_TYPE_DECISION_SITE } from '../decide/sites/registry.js';

/** Wait budget for the type decision, in ms (module load excluded; see `askSiteDecision`). */
export const OBSERVATION_TYPE_BUDGET_MS = 300;

/** Minimum confidence the answer needs before `on` mode uses the decided type. */
export const OBSERVATION_TYPE_MIN_CONFIDENCE = 0.6;

/** Call-site id for the type decision; keys the audit line. */
export const OBSERVATION_TYPE_SITE = OBSERVATION_TYPE_DECISION_SITE.id;

/** Config key selecting the System One mode for the observation type. */
export const OBSERVATION_TYPE_MODE_KEY = OBSERVATION_TYPE_DECISION_SITE.modeKey;

/** The types offered to the decision: exactly the ones the keyword heuristic can produce. */
export const OBSERVATION_TYPE_OPTIONS = [
  'bugfix',
  'refactor',
  'feature',
  'decision',
  'change',
  'discovery',
] as const satisfies readonly BrainObservationType[];

/** One of {@link OBSERVATION_TYPE_OPTIONS}. */
export type ObservationTypeOption = (typeof OBSERVATION_TYPE_OPTIONS)[number];

/** Where a stored observation type came from. */
export type ObservationTypeSource = 'caller' | 'keyword' | 'system-one';

/** Per-field character caps. */
const TITLE_MAX_CHARS = 160;
const TEXT_MAX_CHARS = 600;

/** The single question's name. */
const QUESTION = 'type';

const TYPE_CRITERIA: Record<ObservationTypeOption, string> = {
  bugfix: 'The observation records a defect, error or crash, or a fix for one.',
  refactor:
    'The observation records restructuring existing code without changing behaviour (rename, extract, move).',
  feature: 'The observation records new capability being added, created or implemented.',
  decision: 'The observation records a choice made between alternatives, and why.',
  change:
    'The observation records a modification, update or upgrade to existing behaviour or configuration.',
  discovery:
    'The observation records something learned or found out about the system, with no change made.',
};

/** Keyword groups, checked in order; the first group with a matching word wins. */
const TYPE_KEYWORDS: ReadonlyArray<{
  readonly keywords: readonly string[];
  readonly type: ObservationTypeOption;
  /**
   * Word endings that also match as the tail of a compound (`bugfix`,
   * `hotfix`, `typeerror`), except the words in `notCompounds`.
   */
  readonly compounds?: readonly string[];
  /** Compounds that only look like one (`prefix`, `terror`). */
  readonly notCompounds?: ReadonlySet<string>;
}> = [
  {
    keywords: ['bug', 'bugfix', 'hotfix', 'debug', 'fix', 'error', 'crash'],
    type: 'bugfix',
    compounds: ['fix', 'error'],
    notCompounds: new Set([
      'prefix',
      'suffix',
      'affix',
      'infix',
      'postfix',
      'circumfix',
      'crucifix',
      'transfix',
      'terror',
    ]),
  },
  { keywords: ['refactor', 'rename', 'extract', 'move'], type: 'refactor' },
  { keywords: ['add', 'create', 'implement', 'new'], type: 'feature' },
  { keywords: ['decide', 'chose', 'pick', 'instead'], type: 'decision' },
  { keywords: ['update', 'change', 'modify', 'upgrade'], type: 'change' },
];

/** Inflections a keyword may carry and still match (`fix` → `fixes`, `fixed`, `fixing`). */
const INFLECTIONS = ['', 's', 'es', 'd', 'ed', 'ing', 'er', 'ers', 'ion', 'ions', 'ation'] as const;

/** Inflections after a doubled final consonant (`debug` → `debugging`, `bug` → `bugged`). */
const DOUBLED_INFLECTIONS = ['ing', 'ed', 'er', 'ers'] as const;

/** Whether `word` is `keyword` or an inflection of it (`rename` → `renaming`). */
function isInflectionOf(word: string, keyword: string): boolean {
  if (
    word.startsWith(keyword) &&
    (INFLECTIONS as readonly string[]).includes(word.slice(keyword.length))
  ) {
    return true;
  }
  const doubled = keyword + keyword.slice(-1);
  if (
    word.startsWith(doubled) &&
    (DOUBLED_INFLECTIONS as readonly string[]).includes(word.slice(doubled.length))
  ) {
    return true;
  }
  // A trailing `e` drops before -ing / -ion: rename → renaming, create → creation.
  if (!keyword.endsWith('e')) return false;
  const stem = keyword.slice(0, -1);
  const rest = word.startsWith(stem) ? word.slice(stem.length) : null;
  return rest === 'ing' || rest === 'ion' || rest === 'ions';
}

/**
 * Whether `word` is a compound ending in `tail`, or an inflection of one
 * (`hotfixes`, `typeerror`), and not one of `notCompounds` (`prefix`).
 */
function isCompoundOf(word: string, tail: string, notCompounds: ReadonlySet<string>): boolean {
  for (const inflection of INFLECTIONS) {
    if (inflection !== '' && !word.endsWith(inflection)) continue;
    const base = word.slice(0, word.length - inflection.length);
    if (base.length > tail.length && base.endsWith(tail) && !notCompounds.has(base)) return true;
  }
  return false;
}

/**
 * Classify an observation's type from whole-word keywords.
 *
 * A keyword matches a whole word or one of its inflections, never a substring
 * of another word (`add` does not match `address`, `fix` not `prefix` or
 * `fixture`). The bugfix group also matches compounds ending in `fix` or
 * `error` (`hotfix`, `TypeError`), minus look-alikes such as `prefix`.
 *
 * @param text - Observation text.
 * @returns The first matching group's type, else `discovery`.
 */
export function classifyObservationTypeByKeywords(text: string): ObservationTypeOption {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const {
    keywords,
    type,
    compounds = [],
    notCompounds = new Set<string>(),
  } of TYPE_KEYWORDS) {
    const hit = words.some(
      (w) =>
        keywords.some((kw) => isInflectionOf(w, kw)) ||
        compounds.some((tail) => isCompoundOf(w, tail, notCompounds)),
    );
    if (hit) return type;
  }
  return 'discovery';
}

/** Whether `value` is one of the offered options. */
function isTypeOption(value: unknown): value is ObservationTypeOption {
  return (OBSERVATION_TYPE_OPTIONS as readonly unknown[]).includes(value);
}

/**
 * Build the decision request: the title and text as state and one `choice`
 * question over {@link OBSERVATION_TYPE_OPTIONS}.
 *
 * @param text - Observation text.
 * @param title - Observation title, when given.
 * @param redact - Redaction applied to every field BEFORE clipping.
 * @returns The request.
 */
export function buildObservationTypeRequest(
  text: string,
  title: string | undefined,
  redact: (s: string) => string,
): DecisionRequest {
  return {
    state: {
      ...(title ? { title: redactThenClip(title, TITLE_MAX_CHARS, redact) } : {}),
      text: redactThenClip(text, TEXT_MAX_CHARS, redact),
    },
    questions: { [QUESTION]: { type: 'choice', criteria: TYPE_CRITERIA } },
  };
}

/** Options for {@link chooseObservationType}. */
export interface ChooseObservationTypeOptions {
  /** Explicit mode; wins over config when a provider is configured. */
  readonly mode?: DecisionSiteMode;
  /** Provider, connection, budget, cache and audit wiring forwarded to `decide()`. */
  readonly decide?: DecideOptions;
  /** Project root for config lookup and the default audit sink. */
  readonly projectRoot?: string;
}

/** The chosen type and where it came from. */
export interface ObservationTypeChoice {
  /** The type to store. */
  readonly type: ObservationTypeOption;
  /** `system-one` only when `on` mode acted on a confident, valid answer. */
  readonly source: Exclude<ObservationTypeSource, 'caller'>;
  /** The decided answer's confidence (`system-one`), or the heuristic's flat 0.5 (`keyword`). */
  readonly confidence: number;
}

/**
 * Choose the type for an observation stored without one.
 *
 * Never throws and never waits longer than {@link OBSERVATION_TYPE_BUDGET_MS}
 * once a decision is asked. In `off` and `shadow` the result is exactly the
 * keyword type; only `on` with a confident, valid answer changes it.
 *
 * @param text - Observation text.
 * @param title - Observation title, when given.
 * @param opts - Mode, wiring and project root.
 * @returns The chosen type with its source and confidence.
 */
export async function chooseObservationType(
  text: string,
  title: string | undefined,
  opts: ChooseObservationTypeOptions = {},
): Promise<ObservationTypeChoice> {
  const keywordType = classifyObservationTypeByKeywords(text);
  const heuristic: ObservationTypeChoice = {
    type: keywordType,
    source: 'keyword',
    confidence: 0.5,
  };
  try {
    const { askSiteDecision, resolveDecisionSiteSettings } = await import('../decide/site.js');
    const { mode } = await resolveDecisionSiteSettings({
      modeKey: OBSERVATION_TYPE_MODE_KEY,
      mode: opts.mode,
      wiring: opts.decide,
      projectRoot: opts.projectRoot,
    });
    if (mode === 'off') return heuristic;

    const heuristicAnswer: DecisionAnswer = {
      type: 'choice',
      value: keywordType,
      probabilities: Object.fromEntries(
        OBSERVATION_TYPE_OPTIONS.map((o) => [o, o === keywordType ? 1 : 0]),
      ),
      confidence: 0.5,
    };
    const decision = await askSiteDecision({
      siteId: OBSERVATION_TYPE_SITE,
      budgetMs: OBSERVATION_TYPE_BUDGET_MS,
      minConfidence: OBSERVATION_TYPE_MIN_CONFIDENCE,
      mode,
      heuristicVerdict: keywordType,
      buildRequest: (redact) => buildObservationTypeRequest(text, title, redact),
      heuristicAnswers: { [QUESTION]: heuristicAnswer },
      isValid: (answers) =>
        answers[QUESTION]?.type === 'choice' && isTypeOption(answers[QUESTION]?.value),
      agree: (answers) => answers[QUESTION]?.value === keywordType,
      wiring: opts.decide,
      projectRoot: opts.projectRoot,
    });
    const answer = decision?.answers[QUESTION];
    if (mode !== 'on' || !decision?.confident || answer?.type !== 'choice') return heuristic;
    if (!isTypeOption(answer.value)) return heuristic;
    return { type: answer.value, source: 'system-one', confidence: answer.confidence };
  } catch {
    return heuristic;
  }
}
