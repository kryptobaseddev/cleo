/**
 * Skill auto-improve review prompt template.
 *
 * TypeScript port of the prompt block at `run_agent.py:3981` in Hermes Agent.
 * Used by the (future) auto-improve loop to ask the council pipeline whether
 * a skill should be patched, deprecated, or left alone given the recent task
 * context that exercised it.
 *
 * ## Why a separate module?
 *
 * Prompts are content-as-code — keeping them in a dedicated module gives:
 *
 *   1. A single grep target when adjusting wording (`buildSkillReviewPrompt`).
 *   2. A typed argument contract so call sites can't silently drop the
 *      lifecycle context (which materially changes the review outcome).
 *   3. Trivially unit-testable string-assembly without spinning up the LLM.
 *
 * ## Wire compatibility with Hermes
 *
 * The output string mirrors the Hermes prompt structure — heading order,
 * placeholder names, and section titles match — so council operators
 * comparing CLEO / Hermes runs side-by-side see equivalent input framing.
 *
 * @task T9706
 * @epic T9571
 * @saga T9560
 * @port-of run_agent.py:3981 (Hermes Agent)
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §6/§7
 */

import type { SkillLifecycleState } from '../store/skills-schema.js';

// ---------------------------------------------------------------------------
// Arguments + return type
// ---------------------------------------------------------------------------

/**
 * Inputs to {@link buildSkillReviewPrompt}.
 *
 * All three fields are required — the lifecycle state in particular
 * materially changes the review framing (an `archived` skill is reviewed
 * for permanent removal, an `active` one for incremental improvement).
 */
export interface BuildSkillReviewPromptArgs {
  /**
   * The skill identifier under review (e.g. `ct-orchestrator`).
   * Substituted verbatim into the prompt; the caller is responsible for
   * not passing an empty string.
   */
  readonly skillName: string;
  /**
   * Free-form description of the recent task(s) that loaded or invoked
   * this skill. Typically derived from the last N entries in `skill_usage`
   * joined to `tasks`. The reviewer uses this to assess fitness-for-purpose.
   */
  readonly recentTaskContext: string;
  /**
   * The current lifecycle state of the skill — see {@link SkillLifecycleState}.
   * Drives the "Decision Required" section of the prompt:
   *   - `active`   → "Should we patch, deprecate, or pin?"
   *   - `stale`    → "Revive, archive, or hold for another cycle?"
   *   - `archived` → "Permanently remove or restore?"
   */
  readonly lifecycleState: SkillLifecycleState;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the multi-section review prompt for the auto-improve council pass.
 *
 * The returned string is intended to be fed directly to a chat-style LLM as
 * a single user turn (no system-prompt assumption). Section ordering and
 * heading wording mirror Hermes' `run_agent.py:3981` template so council
 * comparisons across runtimes stay apples-to-apples.
 *
 * @example
 * ```typescript
 * const prompt = buildSkillReviewPrompt({
 *   skillName: 'ct-orchestrator',
 *   recentTaskContext: 'Used 12 times in last 7d for epic decomposition.',
 *   lifecycleState: 'active',
 * });
 * await llm.chat([{ role: 'user', content: prompt }]);
 * ```
 *
 * @param args - See {@link BuildSkillReviewPromptArgs}.
 * @returns A multi-line review prompt string.
 *
 * @task T9706
 */
export function buildSkillReviewPrompt(args: BuildSkillReviewPromptArgs): string {
  const { skillName, recentTaskContext, lifecycleState } = args;
  const decisionPrompt = decisionPromptForLifecycle(lifecycleState);

  return [
    `# Skill Review — ${skillName}`,
    '',
    'You are reviewing a skill in the CLEO skills registry. The goal of this',
    'review is to decide whether the skill should be patched, pinned,',
    'deprecated, or removed based on recent usage signals.',
    '',
    '## Skill',
    '',
    `- Name: ${skillName}`,
    `- Current lifecycle state: ${lifecycleState}`,
    '',
    '## Recent Task Context',
    '',
    recentTaskContext.trim() || '(no recent usage recorded)',
    '',
    '## Decision Required',
    '',
    decisionPrompt,
    '',
    '## Response Format',
    '',
    'Reply with a brief verdict (1-3 sentences) followed by one of the',
    'following decisions on its own line:',
    '',
    '  DECISION: approved',
    '  DECISION: rejected',
    '  DECISION: needs-changes',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return the lifecycle-specific framing for the "Decision Required" section.
 *
 * Kept private to this module — it is a presentation detail of
 * {@link buildSkillReviewPrompt} and not a stable extension point.
 */
function decisionPromptForLifecycle(state: SkillLifecycleState): string {
  switch (state) {
    case 'active':
      return [
        'This skill is currently ACTIVE. Should it be:',
        '  - patched (recommend specific changes),',
        '  - pinned (frozen at current version), or',
        '  - deprecated (marked stale at next sweep)?',
      ].join('\n');
    case 'stale':
      return [
        'This skill is currently STALE. Should it be:',
        '  - revived (return to active, justify with usage), or',
        '  - archived (move out of the active set), or',
        '  - held for another review cycle?',
      ].join('\n');
    case 'archived':
      return [
        'This skill is currently ARCHIVED. Should it be:',
        '  - permanently removed (purge from registry), or',
        '  - restored to active (justify with new usage signal)?',
      ].join('\n');
  }
}
