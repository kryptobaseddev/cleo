/**
 * Adaptive thinking-budget calculator for extended-thinking providers.
 *
 * Computes a safe token budget for Anthropic-style extended thinking so that
 * the thinking window never starves the model's visible output. The formula
 * mirrors the heuristic used in Hermes:
 *
 *   budget = min(maxTokens × 0.5, (contextLength − promptTokens) × 0.2, 32_000)
 *
 * @module llm/thinking-budget
 * @task T9303 (W6b — adaptive thinking-budget calculator)
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

/** Maximum thinking-budget cap in tokens (Anthropic API hard limit). */
export const THINKING_BUDGET_CAP = 32_000;

/**
 * Arguments accepted by {@link computeThinkingBudget}.
 */
export interface ThinkingBudgetArgs {
  /** Total context window size in tokens for the model. */
  readonly modelContextLength: number;
  /** Estimated prompt token count (rough character / 4 heuristic is fine). */
  readonly promptTokens: number;
  /** Maximum output tokens requested by the caller (from `TransportRequest.maxTokens`). */
  readonly maxTokens: number;
}

/**
 * Compute an adaptive thinking-budget token allocation.
 *
 * The budget is the minimum of three upper bounds:
 * 1. **Half of `maxTokens`** — ensures thinking never consumes more than half
 *    of the caller's declared output budget.
 * 2. **20 % of remaining context** (`(contextLength − promptTokens) × 0.2`) —
 *    reserves the bulk of available tokens for visible output.
 * 3. **Hard cap** of {@link THINKING_BUDGET_CAP} (32 000 tokens) — matches the
 *    Anthropic API maximum for `thinking.budget_tokens`.
 *
 * Returns `0` when the context is exhausted (`promptTokens >= contextLength`),
 * meaning no thinking budget is available.
 *
 * @param args - Budget calculation inputs.
 * @returns Non-negative integer token budget.
 */
export function computeThinkingBudget(args: ThinkingBudgetArgs): number {
  const { modelContextLength, promptTokens, maxTokens } = args;

  const remainingContext = modelContextLength - promptTokens;
  if (remainingContext <= 0) {
    return 0;
  }

  const fromMaxTokens = maxTokens * 0.5;
  const fromContext = remainingContext * 0.2;

  return Math.floor(Math.min(fromMaxTokens, fromContext, THINKING_BUDGET_CAP));
}
