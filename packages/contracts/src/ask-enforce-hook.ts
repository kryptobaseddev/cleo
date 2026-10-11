/**
 * Ask-enforce Stop hook — shared types (T13420).
 *
 * The owner rule (CLEO-INJECTION.md universal protocol step 7) routes every
 * owner question or decision through the harness ask tool. The ask-enforce
 * hook runs when an agent's turn ends: if the final reply asks the owner
 * something in prose and the turn made no ask-tool call, the hook blocks the
 * stop and tells the agent to re-ask with its ask tool. The classifier lives
 * in `@cleocode/core` (`harness/ask-enforce`); the provider wire formats and
 * the entry point (`cleo hook ask-enforce`) in `@cleocode/cleo`.
 *
 * Design: `cleo docs fetch t13420-ask-enforce-stop-hook-design`.
 *
 * @task T13420
 * @epic T13418
 */

/**
 * How the hook treats a turn that ends in a prose owner question.
 *
 * - `block` — DEFAULT. Block the stop once per turn with the re-ask message.
 * - `warn` — never block; surface the message as context only.
 * - `off` — do nothing.
 */
export type AskEnforceMode = 'block' | 'warn' | 'off';

/** What the classifier sees for one ended turn. */
export interface AskEnforceInput {
  /** The final assistant message of the turn (empty or absent: fail open). */
  readonly lastAssistantText: string | null | undefined;
  /** Tool names called since the last user message. */
  readonly turnToolCalls: readonly string[];
  /** Every tool name that counts as an ask-tool call (provider names, CAAMP union). */
  readonly askToolNames: readonly string[];
  /** The harness already re-prompted once from a stop hook in this turn. */
  readonly stopHookActive?: boolean;
  /** Blocks this hook already issued in this turn (loop guard for harnesses without `stopHookActive`). */
  readonly blocksThisTurn?: number;
}

/**
 * Which rule decided the verdict.
 *
 * - `no-text` — nothing to classify (fail open).
 * - `asked` — the turn already called an ask tool.
 * - `loop-guard` — the stop was already blocked once this turn.
 * - `hitl-request` — the reply carries a `hitl.request` envelope (no-ask-tool fallback).
 * - `clean` — no owner question in the reply's tail.
 * - `prose-question` — a reader-directed question ends the reply.
 * - `written-decision` — a request for an owner choice or approval without `?`.
 */
export type AskEnforceSignal =
  | 'no-text'
  | 'asked'
  | 'loop-guard'
  | 'hitl-request'
  | 'clean'
  | 'prose-question'
  | 'written-decision';

/** The classifier's answer for one ended turn. */
export interface AskEnforceVerdict {
  /** `block` only for `prose-question` / `written-decision`. */
  readonly verdict: 'allow' | 'block';
  /** The rule that decided. */
  readonly signal: AskEnforceSignal;
  /** The offending sentence, at most 160 characters (block only). */
  readonly excerpt: string | null;
}
