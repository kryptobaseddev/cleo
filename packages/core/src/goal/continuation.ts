/**
 * Prompt-cache-safe goal continuation builder (Layer 4 of SG-COGNITIVE-SUBSTRATE).
 *
 * ## The prompt-cache-safety contract (why user-message, not system mutation)
 *
 * Prompt caching keys on a STABLE message prefix — most importantly the system
 * prompt. The harness assembles `[system, ...history]` once and caches the long
 * static prefix; every cache hit skips re-processing those tokens. If the goal
 * loop nudged the agent by REWRITING the system prompt each turn, it would
 * invalidate that cached prefix on every single turn — turning a cheap cache hit
 * into a full re-encode and defeating the entire point of caching.
 *
 * {@link buildContinuation} therefore emits the nudge as a `role: 'user'`
 * message that is APPENDED after the existing conversation. The system prompt is
 * never touched, so the cached prefix stays valid and only the new (short) user
 * message is processed. The builder is also byte-stable for identical
 * `(goal, verdict)` inputs — the same continuation text is produced every call —
 * which is required so a re-issued turn reuses the same cache prefix rather than
 * minting a fresh, cache-busting string.
 *
 * ## Harness boundary (AC4)
 *
 * The CLI/SDK side (this builder) guarantees the continuation is a user message
 * and never mutates the system prompt. The HARNESS owns final message-array
 * assembly (it decides where to splice this user message and how the system
 * prompt is cached). This module guarantees the CLI-side contract; the harness
 * guarantees its own. The two together deliver end-to-end cache safety.
 *
 * @module @cleocode/core/goal/continuation
 *
 * @epic T11290 EP-CLEO-GOAL-SYSTEM
 * @task T11380
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import {
  type GoalContinuation,
  type GoalJudgeVerdict,
  type GoalRecord,
  isTerminalGoalStatus,
} from '@cleocode/contracts';

/**
 * Maximum byte length of a continuation's `content`. A continuation is a nudge,
 * not a document — keeping it small bounds the per-turn token cost and keeps the
 * appended user message cheap to (re)process. Criteria beyond what fits are
 * truncated with an explicit marker so the cap is never silently exceeded.
 *
 * @task T11380
 */
export const CONTINUATION_MAX_BYTES = 1200;

/**
 * Build the next-turn continuation nudge for a goal, or `null` when no nudge is
 * warranted.
 *
 * Returns `null` for a TERMINAL verdict/status — a `satisfied`, `abandoned`, or
 * `impossible` goal has nothing left to nudge toward, so no user message is
 * emitted. Only `active` and `paused` goals receive a continuation (`paused`
 * because it can be resumed). The presence of `verdict.ok` or
 * `verdict.impossible` ALSO short-circuits to `null` even if a stale status says
 * otherwise — the verdict is the freshest signal.
 *
 * The continuation embeds the goal intent, the outstanding criteria, and the
 * judge's reason (so the agent knows WHY it must continue), and is byte-stable
 * for identical inputs (deterministic — required for prompt-cache prefix reuse).
 *
 * @param goal - The current goal record.
 * @param verdict - The judge's latest verdict for this goal.
 * @returns A `{ role: 'user', content }` continuation, or `null` when terminal.
 * @task T11380
 */
export function buildContinuation(
  goal: GoalRecord,
  verdict: GoalJudgeVerdict,
): GoalContinuation | null {
  // The verdict is the freshest signal: a satisfied or impossible verdict means
  // there is nothing to nudge toward, regardless of the persisted status.
  if (verdict.ok || verdict.impossible) {
    return null;
  }
  // A terminal status (satisfied/abandoned/impossible) likewise yields no nudge.
  if (isTerminalGoalStatus(goal.status)) {
    return null;
  }

  const lines: string[] = [];
  lines.push(`[GOAL CONTINUATION] Your active goal is not yet satisfied.`);
  lines.push(`Intent: ${goal.intent}`);

  if (goal.criteria.length > 0) {
    lines.push(`Outstanding criteria:`);
    for (const criterion of goal.criteria) {
      lines.push(`  - ${criterion}`);
    }
  }

  lines.push(`Why continue: ${verdict.reason}`);
  lines.push(
    `Turns: ${goal.turnsUsed}/${goal.turnBudget} used. Keep working until the goal's gates are evidence-backed.`,
  );

  const content = clampToBytes(lines.join('\n'), CONTINUATION_MAX_BYTES);
  return { role: 'user', content };
}

/**
 * Clamp a string to at most `maxBytes` UTF-8 bytes, appending a truncation
 * marker when it overflows. Deterministic — identical input yields identical
 * output, preserving byte-stability for prompt-cache prefix reuse.
 *
 * @internal
 */
function clampToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) {
    return text;
  }
  const marker = '\n… [truncated]';
  const budget = maxBytes - encoder.encode(marker).length;
  // Walk back from the byte budget to a safe character boundary so we never
  // split a multi-byte codepoint.
  let sliced = text;
  while (encoder.encode(sliced).length > budget && sliced.length > 0) {
    sliced = sliced.slice(0, -1);
  }
  return sliced + marker;
}
