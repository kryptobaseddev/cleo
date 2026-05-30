/**
 * Per-operation MVI token-budget ceilings — single source of truth.
 *
 * The dispatch budget-enforcement chokepoint
 * (`packages/cleo/src/dispatch/middleware/budget-enforcement.ts`) reads these
 * named constants instead of duplicating magic numbers across command files.
 * `cleo focus`'s documented "≤ 1500 tokens" ceiling and `cleo briefing`'s
 * "~600 tokens" target both live here, so tightening either ceiling is a
 * single edit.
 *
 * @module @cleocode/cleo/dispatch/lib/budget-ceilings
 *
 * @task T11352
 * @epic T11285 EP-MVI-PRIMITIVE
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import type { BudgetMode } from './budget.js';

/**
 * `cleo focus <id>` ceiling: ≤ 1500 tokens for typical task orientation.
 *
 * This is the runtime enforcement of the TSDoc "≤ 1 500 tokens" contract in
 * `packages/cleo/src/cli/commands/focus.ts`.
 *
 * @task T11352
 */
export const FOCUS_TOKEN_CEILING = 1500;

/**
 * `cleo briefing` ceiling: a generous bound above the ~600-token digest target
 * documented in CLEO-INJECTION.md. The briefing already diet-trims its payload;
 * this ceiling is the hard backstop that converts a runaway briefing into a
 * truncated/errored envelope rather than an unbounded context dump.
 *
 * @task T11352
 */
export const BRIEFING_TOKEN_CEILING = 4000;

/**
 * A per-operation budget policy: the ceiling and the overflow {@link BudgetMode}.
 *
 * @task T11352
 */
export interface BudgetPolicy {
  /** Maximum allowed tokens for the operation's response. */
  readonly budget: number;
  /** How to handle overflow (`'truncate'` or `'error'`). */
  readonly mode: BudgetMode;
}

/**
 * SSoT mapping canonical `<domain>.<operation>` keys to their budget policy.
 *
 * Operations not listed here are NOT budget-enforced (the chokepoint passes
 * them through untouched). Adding an entry is a deliberate act — pick a ceiling
 * and a mode intentionally.
 *
 * `cleo focus` (`focus.show`) and `cleo briefing` (`session.briefing.show`) are
 * enforced in `'truncate'` mode: an over-budget orientation envelope is shrunk
 * to fit (and stamped `_budgetEnforcement.truncated = true`) rather than
 * erroring the whole orient call. The truncation engine falls back to an
 * `E_MVI_BUDGET_EXCEEDED` error only when even a minimal payload cannot fit.
 *
 * @task T11352
 */
export const BUDGET_POLICIES: Readonly<Record<string, BudgetPolicy>> = {
  'focus.show': { budget: FOCUS_TOKEN_CEILING, mode: 'truncate' },
  'session.briefing.show': { budget: BRIEFING_TOKEN_CEILING, mode: 'truncate' },
};
