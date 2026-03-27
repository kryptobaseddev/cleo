/**
 * Discretion evaluation for CANT workflow conditionals.
 *
 * Discretion conditions (`**prose text**`) are AI-evaluated logic gates
 * in CANT workflows. The evaluation is pluggable: the default evaluator
 * stubs `true` (real LLM integration is a separate task), while custom
 * evaluators can be injected for testing, rule-based shortcuts, or
 * alternative model backends.
 *
 * @see docs/specs/CANT-DSL-SPEC.md Section 7.3 (Discretion Evaluation)
 */

import type { DiscretionContext } from './types.js';

// ---------------------------------------------------------------------------
// Evaluator Interface
// ---------------------------------------------------------------------------

/** Evaluates a discretion condition and returns a boolean judgment. */
export interface DiscretionEvaluator {
  /**
   * Evaluate whether a discretion condition is met.
   *
   * @param condition - The prose text between `**` delimiters.
   * @param context - Execution context including session, variables, and prior results.
   * @returns `true` if the condition is judged to be met.
   */
  evaluate(condition: string, context: DiscretionContext): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Default Evaluator (Stub)
// ---------------------------------------------------------------------------

/**
 * Default discretion evaluator that always returns `true`.
 *
 * This is a stub implementation. The real LLM-backed evaluator will be
 * implemented as a separate task. In production, this should be replaced
 * with an evaluator that:
 * - Calls the LLM API with the condition in a structured field
 * - Uses structured prompting (tool use / JSON mode)
 * - Returns a boolean judgment
 */
export class DefaultDiscretionEvaluator implements DiscretionEvaluator {
  /** Always returns `true` (stub). */
  async evaluate(_condition: string, _context: DiscretionContext): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Mock Evaluator (Testing)
// ---------------------------------------------------------------------------

/**
 * Mock discretion evaluator with configurable responses for testing.
 *
 * Responses can be set per condition text or as a blanket default.
 */
export class MockDiscretionEvaluator implements DiscretionEvaluator {
  private responses: Map<string, boolean> = new Map();
  private defaultResponse: boolean;
  private evaluationLog: Array<{ condition: string; context: DiscretionContext; result: boolean }> = [];

  /**
   * Creates a mock evaluator.
   *
   * @param defaultResponse - The response for conditions without a specific mapping.
   */
  constructor(defaultResponse = true) {
    this.defaultResponse = defaultResponse;
  }

  /** Set the response for a specific condition text. */
  setResponse(condition: string, result: boolean): void {
    this.responses.set(condition, result);
  }

  /** Evaluate using the configured response map. */
  async evaluate(condition: string, context: DiscretionContext): Promise<boolean> {
    const result = this.responses.get(condition) ?? this.defaultResponse;
    this.evaluationLog.push({ condition, context, result });
    return result;
  }

  /** Get the log of all evaluations performed. */
  getLog(): ReadonlyArray<{ condition: string; context: DiscretionContext; result: boolean }> {
    return this.evaluationLog;
  }

  /** Reset the evaluation log. */
  clearLog(): void {
    this.evaluationLog = [];
  }
}

// ---------------------------------------------------------------------------
// Rate-Limited Evaluator (Decorator)
// ---------------------------------------------------------------------------

/**
 * Wraps a discretion evaluator with rate limiting.
 *
 * Enforces a configurable maximum number of discretion evaluations per
 * workflow execution. Default limit is 100 per the spec. This prevents
 * runaway costs from loops containing discretion conditions.
 */
export class RateLimitedDiscretionEvaluator implements DiscretionEvaluator {
  private evaluationCount = 0;

  /**
   * Creates a rate-limited evaluator wrapper.
   *
   * @param inner - The underlying evaluator to delegate to.
   * @param maxEvaluations - Maximum evaluations allowed (default: 100).
   */
  constructor(
    private readonly inner: DiscretionEvaluator,
    private readonly maxEvaluations: number = 100,
  ) {}

  /**
   * Evaluate with rate limiting.
   *
   * @throws {Error} If the evaluation count exceeds the configured maximum.
   */
  async evaluate(condition: string, context: DiscretionContext): Promise<boolean> {
    this.evaluationCount++;
    if (this.evaluationCount > this.maxEvaluations) {
      throw new Error(
        `Discretion evaluation limit exceeded: ${this.evaluationCount} > ${this.maxEvaluations}. ` +
        'This prevents runaway costs from loops containing discretion conditions.',
      );
    }
    return this.inner.evaluate(condition, context);
  }

  /** Get the current evaluation count. */
  getEvaluationCount(): number {
    return this.evaluationCount;
  }

  /** Reset the evaluation counter (for reuse across workflow runs). */
  resetCount(): void {
    this.evaluationCount = 0;
  }
}
