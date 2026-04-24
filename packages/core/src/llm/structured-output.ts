/**
 * Structured output validation and repair.
 *
 * Ported from Honcho src/llm/structured_output.py. Implements a 3-tier
 * fallback pipeline:
 *   Tier 1: validateStructuredOutput — direct schema parse
 *   Tier 2: jsonrepair → JSON.parse → schema.parse
 *   Tier 3: policy-driven: 'repair_then_empty' | 'raise' | 'repair_then_raise'
 *
 * The PromptRepresentation special-case from Honcho is replaced by the
 * generic `repairHook?` option for any pre-validation transforms.
 *
 * @task T1396 (T1386-W10)
 * @epic T1386
 */

import { jsonrepair } from 'jsonrepair';
import type { z } from 'zod';

import type { CompletionResult } from './backend.js';

/** Policy for handling structured output failures after repair attempt. */
export type StructuredOutputFailurePolicy = 'raise' | 'repair_then_raise' | 'repair_then_empty';

/** Error thrown when structured output cannot be validated or repaired. */
export class StructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

/**
 * Validate that content conforms to the response schema.
 *
 * Accepts: Zod-parsed instance, raw string (JSON), or plain object.
 */
export function validateStructuredOutput<T>(content: unknown, schema: z.ZodType<T>): T {
  // Already parsed instance
  if (schema.safeParse(content).success) {
    return schema.parse(content);
  }
  if (typeof content === 'string') {
    return schema.parse(JSON.parse(content));
  }
  if (typeof content === 'object' && content !== null) {
    return schema.parse(content);
  }
  throw new StructuredOutputError(`Unsupported structured output payload: ${typeof content}`);
}

/**
 * Repair malformed / truncated JSON and validate against the schema.
 *
 * Optional `repairHook` allows callers to pre-process the repaired data
 * before schema validation (replaces Honcho's PromptRepresentation special-case).
 */
export function repairResponseModelJson<T>(
  rawContent: string,
  schema: z.ZodType<T>,
  _modelName: string,
  repairHook?: (data: unknown) => unknown,
): T {
  let repaired: string;
  try {
    repaired = jsonrepair(rawContent);
  } catch {
    repaired = '{}';
  }

  let data: unknown;
  try {
    data = JSON.parse(repaired);
  } catch {
    data = {};
  }

  if (repairHook) {
    data = repairHook(data);
  }

  const result = schema.safeParse(data);
  if (result.success) return result.data;

  throw new StructuredOutputError(`JSON repair failed to produce valid structured output`);
}

/**
 * Attempt structured output repair. Returns null if repair fails.
 */
export function attemptStructuredOutputRepair<T>(
  content: unknown,
  schema: z.ZodType<T>,
  modelName: string,
  repairHook?: (data: unknown) => unknown,
): T | null {
  if (typeof content !== 'string') return null;
  try {
    return repairResponseModelJson(content, schema, modelName, repairHook);
  } catch {
    return null;
  }
}

/**
 * Produce an empty structured output for the schema (schema.parse({})).
 */
export function emptyStructuredOutput<T>(schema: z.ZodType<T>): T {
  return schema.parse({});
}

/**
 * Execute a structured output call with 3-tier fallback.
 *
 * Tier 1: validate directly
 * Tier 2: repair via jsonrepair
 * Tier 3: policy-driven empty/raise
 */
export async function executeStructuredOutputCall<T>(
  executor: () => Promise<CompletionResult>,
  params: {
    schema: z.ZodType<T>;
    modelName: string;
    failurePolicy?: StructuredOutputFailurePolicy;
    repairHook?: (data: unknown) => unknown;
  },
): Promise<CompletionResult> {
  const result = await executor();
  const { schema, modelName, failurePolicy = 'repair_then_raise', repairHook } = params;

  // Tier 1: direct validation
  try {
    result.content = validateStructuredOutput(result.content, schema);
    return result;
  } catch {
    if (failurePolicy === 'raise') {
      throw new StructuredOutputError(`Structured output validation failed for ${modelName}`);
    }
  }

  // Tier 2: jsonrepair
  const repaired = attemptStructuredOutputRepair(result.content, schema, modelName, repairHook);
  if (repaired !== null) {
    result.content = repaired;
    return result;
  }

  // Tier 3: policy
  if (failurePolicy === 'repair_then_empty') {
    result.content = emptyStructuredOutput(schema);
    return result;
  }

  throw new StructuredOutputError(`Failed to produce valid structured output for ${modelName}`);
}
