/**
 * Typed-decision contracts — provider-neutral domain types and zod schemas.
 *
 * A *typed decision* asks a decision model a set of named questions about a
 * piece of state and receives, for every question, a calibrated probability
 * distribution over the admissible answers plus a confidence score. Three
 * question shapes exist:
 *
 * - `noul`   — a yes/no question; the answer is a probability that it holds.
 * - `choice` — pick one of several named options.
 * - `score`  — place the state on an ordered scale of 2–10 levels.
 *
 * These types describe the DOMAIN, not any one vendor's wire format. Provider
 * adapters (in `packages/core/`) translate between these shapes and their
 * transport; nothing here names a provider.
 *
 * This file is types + zod schemas + const data only (arch gate 10,
 * `scripts/lint-no-runtime-in-contracts.mjs`). Validation entry points are the
 * exported `*Schema` values; call `.parse()` / `.safeParse()` on them.
 *
 * @task T12489
 * @epic T12486
 */

import { z } from 'zod';

// ─── Const data ───────────────────────────────────────────────────────────────

/** Every supported decision-question shape, in canonical order. */
export const DECISION_QUESTION_TYPES = ['noul', 'choice', 'score'] as const;

/**
 * Where a {@link DecisionOutcome} came from.
 *
 * - `provider` — answered live by a decision provider.
 * - `cache`    — replayed from a previously stored provider answer.
 * - `fallback` — produced locally because no provider answer was available.
 */
export const DECISION_OUTCOME_SOURCES = ['provider', 'cache', 'fallback'] as const;

/**
 * Hard limits a {@link DecisionRequest} must respect. Enforced by
 * {@link decisionRequestSchema}.
 */
export const DECISION_REQUEST_LIMITS = {
  /**
   * Maximum size of `state`, in UTF-16 characters. A string state is measured
   * directly; a structured (object/array) state is measured on its
   * `JSON.stringify` serialization, which is what goes over the wire.
   */
  maxStateChars: 32_000,
  /** Minimum number of questions in one request. */
  minQuestions: 1,
  /** Maximum number of questions in one request. */
  maxQuestions: 32,
  /** Minimum number of options a `choice` question must offer. */
  minChoiceOptions: 2,
  /** Minimum number of levels on a `score` question's scale. */
  minScoreLevels: 2,
  /** Maximum number of levels on a `score` question's scale. */
  maxScoreLevels: 10,
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

/** A decision-question shape: `noul`, `choice` or `score`. */
export type DecisionQuestionType = (typeof DECISION_QUESTION_TYPES)[number];

/** Origin of a {@link DecisionOutcome}. See {@link DECISION_OUTCOME_SOURCES}. */
export type DecisionOutcomeSource = (typeof DECISION_OUTCOME_SOURCES)[number];

/** Any JSON value — the payload type for structured state and instructions. */
export type DecisionJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly DecisionJsonValue[]
  | { readonly [key: string]: DecisionJsonValue };

/**
 * The state a decision is made about: free text, or a structured JSON
 * object/array. Bounded by {@link DECISION_REQUEST_LIMITS.maxStateChars}.
 */
export type DecisionState =
  | string
  | readonly DecisionJsonValue[]
  | { readonly [key: string]: DecisionJsonValue };

/**
 * Optional guidance for how a question should be judged: free text or a
 * structured JSON object.
 */
export type DecisionInstructions = string | { readonly [key: string]: DecisionJsonValue };

/** A yes/no question. `criteria` describes what makes the answer "yes". */
export interface NoulDecisionQuestion {
  /** Discriminant. */
  readonly type: 'noul';
  /** Optional extra guidance for the decision model. */
  readonly instructions?: DecisionInstructions;
  /** Description of the condition whose truth is being judged. */
  readonly criteria: string;
}

/**
 * A pick-one question. `criteria` maps each option name to a description of
 * when that option applies. At least two options are required.
 */
export interface ChoiceDecisionQuestion {
  /** Discriminant. */
  readonly type: 'choice';
  /** Optional extra guidance for the decision model. */
  readonly instructions?: DecisionInstructions;
  /** Option name → description of when the option applies (≥ 2 entries). */
  readonly criteria: Readonly<Record<string, string>>;
}

/**
 * An ordered-scale question. `criteria` lists the level descriptions from the
 * lowest level (index 0) to the highest; 2–10 levels.
 */
export interface ScoreDecisionQuestion {
  /** Discriminant. */
  readonly type: 'score';
  /** Optional extra guidance for the decision model. */
  readonly instructions?: DecisionInstructions;
  /** Level descriptions, lowest first (2–10 entries). */
  readonly criteria: readonly string[];
}

/** One question in a {@link DecisionRequest}, discriminated on `type`. */
export type DecisionQuestion =
  | NoulDecisionQuestion
  | ChoiceDecisionQuestion
  | ScoreDecisionQuestion;

/** A typed-decision request: some state plus 1–32 named questions about it. */
export interface DecisionRequest {
  /** Optional provider-specific model identifier; the provider default applies when absent. */
  readonly model?: string;
  /** The state being judged. */
  readonly state: DecisionState;
  /** Question name → question (1–32 entries). Names key the answers in {@link DecisionOutcome}. */
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  /**
   * Language hint (e.g. `en`). Sent only to a provider whose capabilities
   * include `langHint`; others never see it (T12664).
   */
  readonly lang?: string;
  /**
   * Provider-side answer cache. `false` asks a provider with `cacheControl`
   * not to answer from its cache (real latency, sensitive text). Ignored by
   * providers without the capability.
   */
  readonly cache?: boolean;
}

/** Answer to a {@link NoulDecisionQuestion}. */
export interface NoulDecisionAnswer {
  /** Discriminant — matches the question's type. */
  readonly type: 'noul';
  /** The decided value: `true` when {@link NoulDecisionAnswer.probability} is at least 0.5. */
  readonly value: boolean;
  /** Probability in [0, 1] that the criteria hold. */
  readonly probability: number;
  /** Model confidence in [0, 1]. */
  readonly confidence: number;
}

/** Answer to a {@link ChoiceDecisionQuestion}. */
export interface ChoiceDecisionAnswer {
  /** Discriminant — matches the question's type. */
  readonly type: 'choice';
  /** The decided option name (the most probable option). */
  readonly value: string;
  /** Option name → probability in [0, 1]. */
  readonly probabilities: Readonly<Record<string, number>>;
  /** Model confidence in [0, 1]. */
  readonly confidence: number;
}

/** Answer to a {@link ScoreDecisionQuestion}. */
export interface ScoreDecisionAnswer {
  /** Discriminant — matches the question's type. */
  readonly type: 'score';
  /** The decided level, as a 0-based index into the question's `criteria`. */
  readonly value: number;
  /** Per-level probabilities in [0, 1], index-aligned with the question's `criteria`. */
  readonly probabilities: readonly number[];
  /** Model confidence in [0, 1]. */
  readonly confidence: number;
}

/** Answer to one {@link DecisionQuestion}, discriminated on `type`. */
export type DecisionAnswer = NoulDecisionAnswer | ChoiceDecisionAnswer | ScoreDecisionAnswer;

/** The result of executing a {@link DecisionRequest}. */
export interface DecisionOutcome {
  /** Question name → answer; keys match the request's `questions`. */
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  /** Where this outcome came from. */
  readonly source: DecisionOutcomeSource;
  /** Provider request identifier, when the provider returned one. */
  readonly requestId?: string;
  /** Wall-clock latency of producing this outcome, in milliseconds. */
  readonly latencyMs: number;
  /** Provider-reported cost in US dollars, when known. */
  readonly costUsd?: number;
  /** Provider-reported cost in integer micro-dollars, when known (T12664). */
  readonly costMicros?: number;
  /** Account balance in integer micro-dollars reported with this answer, when known. */
  readonly balanceMicros?: number;
  /** Provider model checkpoint that answered, when reported. */
  readonly checkpoint?: string;
  /** Provider-reported input-token count, when known. */
  readonly inputTokens?: number;
}

// ─── Provider kinds (T12713) ─────────────────────────────────────────────────

/**
 * Every supported decision-provider kind, recommended first.
 *
 * - `layahost` — the hosted provider at {@link LAYAHOST_BASE_URL}; the user
 *   supplies only an API key.
 * - `jev`      — any other Jev-compatible endpoint; the user supplies the URL.
 */
export const DECISION_PROVIDER_KINDS = ['layahost', 'jev'] as const;

/** A decision-provider kind. See {@link DECISION_PROVIDER_KINDS}. */
export type DecisionProviderKind = (typeof DECISION_PROVIDER_KINDS)[number];

/** Base URL of the layahost API (its OpenAPI `servers[0].url`). */
export const LAYAHOST_BASE_URL = 'https://layahost.com';

/** layahost's routing model, the default for a layahost connection. */
export const LAYAHOST_DEFAULT_MODEL = 'laya-auto';

/** Connection settings for a decision provider. */
export interface DecisionProviderConfig {
  /** Absolute base URL of the provider's API (no trailing path to the endpoint). */
  readonly baseUrl: string;
  /** Provider kind; absent means a custom Jev-compatible endpoint (`jev`). */
  readonly provider?: DecisionProviderKind;
}

// ─── Provider capabilities (T12664) ──────────────────────────────────────────

/**
 * What a decision provider can do beyond the Jev minimum
 * (`POST /v1/systemone`, 32 questions, 32,000-character state). A caller asks
 * for a capability; the client degrades when it is absent (spec
 * `system-one-integration` §2.2).
 */
export interface DecisionProviderCapabilities {
  /** Wire protocol the provider speaks. */
  readonly wire: string;
  /** Most questions one request may carry. */
  readonly maxQuestionsPerRequest: number;
  /** Largest state, in characters. */
  readonly maxStateChars: number;
  /** Batch endpoint limits, when the provider has one. */
  readonly batch?: { readonly maxRequests: number; readonly maxQuestions: number };
  /** Built-in template names, when the provider has templates. */
  readonly templates?: readonly string[];
  /** Server-side flows are available. */
  readonly flows?: boolean;
  /** A usage/balance endpoint and cost headers are available. */
  readonly usage?: boolean;
  /** The request's `cache` field is honoured. */
  readonly cacheControl?: boolean;
  /** The request's `lang` field is honoured. */
  readonly langHint?: boolean;
  /** How the provider reports cost. */
  readonly reportsCost?: 'micros' | 'usd' | false;
}

/** The Jev minimum every provider supports; the default when a provider reports nothing. */
export const JEV_MINIMUM_CAPABILITIES: DecisionProviderCapabilities = {
  wire: 'jev-systemone/1',
  maxQuestionsPerRequest: 32,
  maxStateChars: 32_000,
  reportsCost: 'usd',
};

/** One item of a batch call: its outcome, or why it failed. */
export type DecisionBatchItem =
  | { readonly ok: true; readonly outcome: DecisionOutcome }
  | { readonly ok: false; readonly status?: number; readonly errorKind: string };

/** Account usage and balance as a provider reports it. */
export interface DecisionProviderUsage {
  /** Balance in integer micro-dollars. */
  readonly balanceMicros?: number;
  /** Decisions the balance still covers. */
  readonly decisionsLeft?: number;
  /** Plan name. */
  readonly plan?: string;
  /** End of the current plan period, ISO-8601. */
  readonly periodEnd?: string;
  /** Decisions and cost over the queried window. */
  readonly totals?: { readonly decisions?: number; readonly costMicros?: number };
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

/** Zod schema for {@link DecisionQuestionType}. */
export const decisionQuestionTypeSchema = z.enum(DECISION_QUESTION_TYPES);

/** Zod schema for {@link DecisionOutcomeSource}. */
export const decisionOutcomeSourceSchema = z.enum(DECISION_OUTCOME_SOURCES);

/** Zod schema for {@link DecisionInstructions}. */
export const decisionInstructionsSchema = z.union([z.string(), z.record(z.string(), z.json())]);

/** A probability or confidence: a finite number in [0, 1]. */
const unitIntervalSchema = z.number().min(0).max(1);

/**
 * Zod schema for {@link DecisionState}. Rejects a state whose size exceeds
 * {@link DECISION_REQUEST_LIMITS.maxStateChars} (serialized size for
 * structured state).
 */
export const decisionStateSchema = z
  .union([z.string(), z.array(z.json()), z.record(z.string(), z.json())])
  .superRefine((state, context) => {
    const size = typeof state === 'string' ? state.length : JSON.stringify(state).length;
    if (size > DECISION_REQUEST_LIMITS.maxStateChars) {
      context.addIssue({
        code: 'custom',
        message: `state is ${size} characters; the limit is ${DECISION_REQUEST_LIMITS.maxStateChars}`,
      });
    }
  });

/** Zod schema for {@link NoulDecisionQuestion}. */
export const noulDecisionQuestionSchema = z.object({
  type: z.literal('noul'),
  instructions: decisionInstructionsSchema.optional(),
  criteria: z.string().min(1),
});

/** Zod schema for {@link ChoiceDecisionQuestion}; requires at least two options. */
export const choiceDecisionQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions: decisionInstructionsSchema.optional(),
  criteria: z
    .record(z.string().min(1), z.string())
    .refine((options) => Object.keys(options).length >= DECISION_REQUEST_LIMITS.minChoiceOptions, {
      message: `a choice question needs at least ${DECISION_REQUEST_LIMITS.minChoiceOptions} options`,
    }),
});

/** Zod schema for {@link ScoreDecisionQuestion}; requires 2–10 levels. */
export const scoreDecisionQuestionSchema = z.object({
  type: z.literal('score'),
  instructions: decisionInstructionsSchema.optional(),
  criteria: z
    .array(z.string())
    .min(DECISION_REQUEST_LIMITS.minScoreLevels)
    .max(DECISION_REQUEST_LIMITS.maxScoreLevels),
});

/** Zod discriminated-union schema for {@link DecisionQuestion}. */
export const decisionQuestionSchema = z.discriminatedUnion('type', [
  noulDecisionQuestionSchema,
  choiceDecisionQuestionSchema,
  scoreDecisionQuestionSchema,
]);

/**
 * Zod schema for {@link DecisionRequest}. Enforces every
 * {@link DECISION_REQUEST_LIMITS} bound: state size, 1–32 questions, ≥ 2
 * choice options and 2–10 score levels.
 *
 * @example
 * ```ts
 * decisionRequestSchema.parse({
 *   state: 'The build failed on a flaky network test.',
 *   questions: {
 *     retry: { type: 'noul', criteria: 'Retrying is likely to succeed' },
 *     severity: { type: 'score', criteria: ['trivial', 'minor', 'major'] },
 *   },
 * });
 * ```
 */
export const decisionRequestSchema = z.object({
  model: z.string().min(1).optional(),
  lang: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/)
    .optional(),
  cache: z.boolean().optional(),
  state: decisionStateSchema,
  questions: z.record(z.string().min(1), decisionQuestionSchema).refine(
    (questions) => {
      const count = Object.keys(questions).length;
      return (
        count >= DECISION_REQUEST_LIMITS.minQuestions &&
        count <= DECISION_REQUEST_LIMITS.maxQuestions
      );
    },
    {
      message: `a request needs ${DECISION_REQUEST_LIMITS.minQuestions}–${DECISION_REQUEST_LIMITS.maxQuestions} questions`,
    },
  ),
});

/** Zod schema for {@link NoulDecisionAnswer}. */
export const noulDecisionAnswerSchema = z.object({
  type: z.literal('noul'),
  value: z.boolean(),
  probability: unitIntervalSchema,
  confidence: unitIntervalSchema,
});

/** Zod schema for {@link ChoiceDecisionAnswer}. */
export const choiceDecisionAnswerSchema = z.object({
  type: z.literal('choice'),
  value: z.string().min(1),
  probabilities: z.record(z.string().min(1), unitIntervalSchema),
  confidence: unitIntervalSchema,
});

/** Zod schema for {@link ScoreDecisionAnswer}. */
export const scoreDecisionAnswerSchema = z.object({
  type: z.literal('score'),
  value: z.number().int().nonnegative(),
  probabilities: z
    .array(unitIntervalSchema)
    .min(DECISION_REQUEST_LIMITS.minScoreLevels)
    .max(DECISION_REQUEST_LIMITS.maxScoreLevels),
  confidence: unitIntervalSchema,
});

/** Zod discriminated-union schema for {@link DecisionAnswer}. */
export const decisionAnswerSchema = z.discriminatedUnion('type', [
  noulDecisionAnswerSchema,
  choiceDecisionAnswerSchema,
  scoreDecisionAnswerSchema,
]);

/** Zod schema for {@link DecisionOutcome} (e.g. when reading a cached outcome back). */
export const decisionOutcomeSchema = z.object({
  answers: z.record(z.string().min(1), decisionAnswerSchema),
  source: decisionOutcomeSourceSchema,
  requestId: z.string().min(1).optional(),
  latencyMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
  costMicros: z.number().int().nonnegative().optional(),
  balanceMicros: z.number().int().optional(),
  checkpoint: z.string().min(1).optional(),
  inputTokens: z.number().int().nonnegative().optional(),
});

/** Zod schema for {@link DecisionProviderKind}. */
export const decisionProviderKindSchema = z.enum(DECISION_PROVIDER_KINDS);

/** Zod schema for {@link DecisionProviderConfig}; `baseUrl` must be an absolute URL. */
export const decisionProviderConfigSchema = z.object({
  baseUrl: z.url(),
  provider: decisionProviderKindSchema.optional(),
});
