/**
 * `cleo hook subagent-start --provider claude-code`: give every subagent the
 * ct-lean rules (T13667).
 *
 * Session-start context reaches the main thread only, so a subagent spawned
 * through the harness (Claude Code's Agent tool) runs without the lean rules
 * unless a SubagentStart hook injects them. CLEO-spawned agents already get
 * them from the spawn prompt. Mirrors Ponytail 5.1.0's `ponytail-subagent.js`
 * (DietrichGebert, MIT): the level-specific rules go in as
 * `hookSpecificOutput.additionalContext`, nothing at level `off`, and
 * `CLEO_LEAN_SUBAGENT_MATCHER` (a case-insensitive regex over `agent_type`)
 * scopes it to some subagents. Every failure is fail-open: exit 0, no output.
 *
 * @task T13667
 * @epic T13418
 */

import type { HookJsonValue } from '@cleocode/contracts';

/** Harnesses `cleo hook subagent-start` answers for. */
export const SUBAGENT_START_PROVIDERS = ['claude-code'] as const;

/** One of {@link SUBAGENT_START_PROVIDERS}. */
export type SubagentStartProvider = (typeof SUBAGENT_START_PROVIDERS)[number];

/** Longest matcher accepted; a longer one is ignored (inject), bounding regex cost. */
const MAX_MATCHER_LENGTH = 200;

function isRecord(
  value: HookJsonValue | undefined,
): value is { readonly [key: string]: HookJsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function agentTypeOf(stdin: string): string {
  try {
    const raw = JSON.parse(stdin.replace(/^\uFEFF/, '')) as HookJsonValue;
    const value = isRecord(raw) ? raw.agent_type : undefined;
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    // Unparseable payload: inject (fail open).
    return '';
  }
}

/**
 * Whether the subagent is in scope: no matcher, an unusable matcher, or an
 * unknown agent type all mean yes; only a definite mismatch skips it.
 *
 * @param matcher - `CLEO_LEAN_SUBAGENT_MATCHER`, if set.
 * @param agentType - the payload's `agent_type`.
 */
export function subagentInScope(matcher: string | undefined, agentType: string): boolean {
  if (!matcher || matcher.length > MAX_MATCHER_LENGTH || !agentType) return true;
  try {
    return new RegExp(matcher, 'i').test(agentType);
  } catch {
    return true;
  }
}

/**
 * Answer one SubagentStart payload.
 *
 * @param stdin - the payload.
 * @param env - environment (`CLEO_LEAN_*`, `CLEO_SESSION_ID`).
 * @param cwd - the hook's working directory (the project is found above it).
 * @returns the harness answer, or `''` for no output.
 */
export async function subagentStartHook(
  stdin: string,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): Promise<string> {
  if (!subagentInScope(env.CLEO_LEAN_SUBAGENT_MATCHER, agentTypeOf(stdin))) return '';
  const { heavyHookProjectRoot } = await import('@cleocode/core/resources/heavy-command.js');
  const lean = await import('@cleocode/core/orchestration/lean-change.js');
  const projectRoot = heavyHookProjectRoot(cwd);
  // The session the CLI would bind: CLEO_SESSION_ID, else the terminal binding,
  // which under Claude Code is keyed by CLAUDE_CODE_SESSION_ID.
  const { resolveBoundSessionId } = await import('@cleocode/core/store/session-store.js');
  const sessionId = await resolveBoundSessionId(projectRoot, env).catch(() => null);
  const { level } = await lean.effectiveLeanLevel({ projectRoot, sessionId, env });
  const block = lean.buildLeanChangeBlock(level);
  if (block === null) return '';
  const answer: HookJsonValue = {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: block },
  };
  return `${JSON.stringify(answer)}\n`;
}
