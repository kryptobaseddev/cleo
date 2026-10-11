/**
 * Lean-change block for spawn prompts (T13422).
 *
 * The core rules of the `ct-lean` skill (adapted from Ponytail 5.1.0,
 * DietrichGebert, MIT), emitted at every spawn tier so workers that never load
 * the skill still get them. The skill holds the full text; this block is the
 * part a worker needs on every task.
 *
 * @task T13422
 */

/** One-paragraph lean-change rule; the full rules are in the `ct-lean` skill. */
export const LEAN_CHANGE_LINE =
  'Make the smallest complete change: skip anything nobody asked for (name it in one line); reuse a helper, contract or chokepoint already in the repo before writing new code; add no abstraction, option or dependency for later; fix a bug once at its root after grepping every caller; finish every caller, test and fixture the change breaks; leave one small test for new non-trivial logic. Never cut validation, data-loss error handling, security, evidence gates, type safety or the package boundary. End with one line on what you skipped or did not check. Full rules: the `ct-lean` skill.';

/** Build the `## Lean Change (ct-lean)` spawn-prompt block. */
export function buildLeanChangeBlock(): string {
  return ['## Lean Change (ct-lean)', '', LEAN_CHANGE_LINE].join('\n');
}
