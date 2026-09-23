/**
 * Regression tests for gh#1219 — "transcript extraction fails on
 * openai-compatible providers: prompt contradicts schema and response_format
 * is dropped".
 *
 * Two independent defects combined to make structured extraction unreliable
 * through any provider that does not receive an enforced schema:
 *
 *   1. The system prompt ended "Return empty array if nothing of durable value
 *      exists", and the user prompt repeated it — while the zod schema
 *      requires the object `{memories: [...]}`. Literal-minded models followed
 *      the prose. The reporter captured the spread across four models: a bare
 *      `[]`, a `{"extractions": []}`, a `{"memories": ["string", ...]}`, and
 *      one correct response in 1 of 4 attempts. Nothing was stored in any
 *      failing case.
 *
 *   2. `generateObject` was called without `structuredOutputs`, so the AI SDK
 *      dropped `response_format` and sent no schema on the wire — leaving
 *      correctness entirely to the prompt discipline that defect 1 undermined.
 *
 * The prompt is the artefact under test here: these assertions fail on the old
 * text, and they are the only thing standing between a future prompt edit and
 * a silent return to "extraction looks flaky".
 *
 * @task T12133 (gh#1219)
 */

import { describe, expect, it } from 'vitest';
import { EXTRACTION_SYSTEM_PROMPT } from '../transcript-extractor.js';

describe('gh#1219 — the extraction prompt must agree with the schema', () => {
  it('tells the model the top level is an object with a "memories" key', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('"memories"');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('{"memories": []}');
  });

  it('does NOT instruct a bare empty array', () => {
    // The exact prose that produced `[]` from deepseek-chat.
    expect(EXTRACTION_SYSTEM_PROMPT).not.toMatch(/Return empty array if nothing/i);
  });

  it('says explicitly that a bare array is wrong', () => {
    // Naming the failure mode beats only describing the success case: several
    // models invented their own envelope rather than emitting a bare array.
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/NOT a bare array/i);
  });

  it('contains the word "json"', () => {
    // OpenRouter/OpenAI reject `response_format: json_object` with HTTP 400
    // unless "json" appears somewhere in messages. The old prompts contained
    // no form of the word, so short transcripts failed hard while longer ones
    // that happened to mention json failed later at validation — which is why
    // the command read as flaky rather than broken.
    expect(EXTRACTION_SYSTEM_PROMPT.toLowerCase()).toContain('json');
  });

  it('still caps extractions', () => {
    // Guard against losing an instruction while rewriting the tail.
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/Maximum 7/);
  });
});
