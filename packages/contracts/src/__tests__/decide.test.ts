/**
 * Tests for the typed-decision contracts (T12489).
 *
 * @task T12489
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  DECISION_REQUEST_LIMITS,
  type DecisionAnswer,
  type DecisionOutcome,
  type DecisionQuestion,
  decisionAnswerSchema,
  decisionOutcomeSchema,
  decisionProviderConfigSchema,
  decisionQuestionSchema,
  decisionRequestSchema,
} from '../decide.js';

const noul = { type: 'noul', criteria: 'The change is safe to merge' } as const;

describe('decisionRequestSchema', () => {
  it('accepts a request with each question shape and structured state', () => {
    const result = decisionRequestSchema.safeParse({
      model: 'default',
      state: { diff: ['a', 'b'], files: 2 },
      questions: {
        safe: { ...noul, instructions: { strict: true } },
        area: { type: 'choice', criteria: { api: 'Touches the API', ui: 'Touches the UI' } },
        risk: { type: 'score', criteria: ['low', 'medium', 'high'] },
      },
    });
    expect(result.success).toBe(true);
  });

  it('enforces 1-32 questions', () => {
    expect(decisionRequestSchema.safeParse({ state: 's', questions: {} }).success).toBe(false);
    const questions = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, noul]));
    expect(
      decisionRequestSchema.safeParse({
        state: 's',
        questions: questions(DECISION_REQUEST_LIMITS.maxQuestions),
      }).success,
    ).toBe(true);
    expect(
      decisionRequestSchema.safeParse({
        state: 's',
        questions: questions(DECISION_REQUEST_LIMITS.maxQuestions + 1),
      }).success,
    ).toBe(false);
  });

  it('enforces the state size limit for string and structured state', () => {
    const max = DECISION_REQUEST_LIMITS.maxStateChars;
    const q = { q: noul };
    expect(decisionRequestSchema.safeParse({ state: 'x'.repeat(max), questions: q }).success).toBe(
      true,
    );
    expect(
      decisionRequestSchema.safeParse({ state: 'x'.repeat(max + 1), questions: q }).success,
    ).toBe(false);
    expect(
      decisionRequestSchema.safeParse({ state: ['x'.repeat(max)], questions: q }).success,
    ).toBe(false);
  });
});

describe('decisionQuestionSchema', () => {
  it('requires at least two choice options', () => {
    expect(decisionQuestionSchema.safeParse({ type: 'choice', criteria: { a: 'A' } }).success).toBe(
      false,
    );
    expect(
      decisionQuestionSchema.safeParse({ type: 'choice', criteria: { a: 'A', b: 'B' } }).success,
    ).toBe(true);
  });

  it('requires 2-10 score levels', () => {
    const levels = (n: number) => Array.from({ length: n }, (_, i) => `level ${i}`);
    expect(decisionQuestionSchema.safeParse({ type: 'score', criteria: levels(1) }).success).toBe(
      false,
    );
    expect(decisionQuestionSchema.safeParse({ type: 'score', criteria: levels(2) }).success).toBe(
      true,
    );
    expect(decisionQuestionSchema.safeParse({ type: 'score', criteria: levels(10) }).success).toBe(
      true,
    );
    expect(decisionQuestionSchema.safeParse({ type: 'score', criteria: levels(11) }).success).toBe(
      false,
    );
  });
});

describe('answer, outcome and provider config schemas', () => {
  it('rejects probabilities outside [0, 1]', () => {
    expect(
      decisionAnswerSchema.safeParse({
        type: 'noul',
        value: true,
        probability: 1.2,
        confidence: 0.9,
      }).success,
    ).toBe(false);
  });

  it('accepts a cached outcome', () => {
    const outcome: DecisionOutcome = {
      answers: {
        safe: { type: 'noul', value: true, probability: 0.8, confidence: 0.7 },
        area: {
          type: 'choice',
          value: 'api',
          probabilities: { api: 0.9, ui: 0.1 },
          confidence: 0.6,
        },
        risk: { type: 'score', value: 0, probabilities: [0.7, 0.2, 0.1], confidence: 0.5 },
      },
      source: 'cache',
      latencyMs: 3,
    };
    expect(decisionOutcomeSchema.parse(outcome)).toEqual(outcome);
  });

  it('requires an absolute baseUrl', () => {
    expect(
      decisionProviderConfigSchema.safeParse({ baseUrl: 'https://example.test' }).success,
    ).toBe(true);
    expect(decisionProviderConfigSchema.safeParse({ baseUrl: 'not a url' }).success).toBe(false);
  });

  it('schema outputs are assignable to the domain types', () => {
    expectTypeOf<z.output<typeof decisionQuestionSchema>>().toExtend<DecisionQuestion>();
    expectTypeOf<z.output<typeof decisionAnswerSchema>>().toExtend<DecisionAnswer>();
    expectTypeOf<z.output<typeof decisionOutcomeSchema>>().toExtend<DecisionOutcome>();
  });
});
