/**
 * LAFS Budget-Aware Truncation for MCP Resources
 *
 * Provides token estimation and truncation for MCP resource responses,
 * ensuring they stay within LAFS MVI budget constraints.
 *
 * @task T5240
 */

/** Default token budget for MCP resources (conservative). */
const DEFAULT_RESOURCE_BUDGET = 500;

/** Approximate tokens per character (conservative estimate). */
const TOKENS_PER_CHAR = 0.25;

/**
 * Estimate the number of tokens in a text string.
 * Uses a conservative character-based estimate (~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

/**
 * Truncate text to fit within a token budget.
 *
 * @param text - Text content to potentially truncate
 * @param budget - Maximum token budget
 * @returns Truncated text with indicator if truncation occurred
 */
export function truncateToTokenBudget(text: string, budget?: number): string {
  const maxTokens = budget ?? DEFAULT_RESOURCE_BUDGET;
  const estimated = estimateTokens(text);

  if (estimated <= maxTokens) {
    return text;
  }

  // Calculate max characters from budget
  const maxChars = Math.floor(maxTokens / TOKENS_PER_CHAR);

  // Find the last newline before the limit to truncate at line boundary
  const truncated = text.substring(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');
  const cutPoint = lastNewline > 0 ? lastNewline : maxChars;

  return text.substring(0, cutPoint) + '\n\n[Truncated: ~' + estimated + ' tokens, budget: ' + maxTokens + ']';
}
