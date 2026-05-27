/**
 * HITL auto-policy — evaluates whether a deterministic command requires
 * human approval before execution. Conservative defaults per OpenProse standard.
 *
 * `require-human` rules are evaluated FIRST and cannot be bypassed by
 * `auto-approve` rules even when callers append custom rules to the list.
 * The default decision for an unmatched command is `require-human` so the
 * runtime fails closed when confronted with unknown surface area.
 *
 * @task T889 / T908 / W4-9
 */

/**
 * One policy rule in the auto-approval evaluation order. Rules are matched by
 * applying `pattern.test(command)` against the fully-resolved command string.
 */
export interface PolicyRule {
  pattern: RegExp;
  action: 'auto-approve' | 'require-human';
  reason: string;
}

/**
 * Result of {@link evaluatePolicy}. `matchedPattern` carries the source of
 * the regex that produced the decision so operators can audit the trail;
 * it is absent for the terminal `default` fallthrough.
 */
export interface EvaluatePolicyResult {
  action: 'auto-approve' | 'require-human';
  reason: string;
  matchedPattern?: string;
}

/**
 * Conservative default policy. `require-human` rules come first for ordering
 * clarity, but evaluation order in {@link evaluatePolicy} enforces the
 * priority regardless of array position.
 */
export const DEFAULT_POLICY_RULES: readonly PolicyRule[] = Object.freeze([
  { pattern: /\bnpm\s+publish\b/, action: 'require-human', reason: 'publish' },
  { pattern: /\bpnpm\s+publish\b/, action: 'require-human', reason: 'publish' },
  { pattern: /\byarn\s+publish\b/, action: 'require-human', reason: 'publish' },
  { pattern: /\bgit\s+push\b/, action: 'require-human', reason: 'push' },
  { pattern: /\bgit\s+tag\b/, action: 'require-human', reason: 'tag' },
  { pattern: /\bgh\s+release\s+create\b/, action: 'require-human', reason: 'release' },
  { pattern: /\bgh\s+workflow\s+run\b/, action: 'require-human', reason: 'workflow-trigger' },
  {
    pattern: /\b(rm\s+-rf|drop\s+table|truncate|delete\s+from)\b/i,
    action: 'require-human',
    reason: 'destructive',
  },
  {
    pattern: /\b(curl|wget|fetch)\b.*\bhttps?:/i,
    action: 'require-human',
    reason: 'external-api',
  },
  { pattern: /\b(ssh|scp|rsync)\b.+@/, action: 'require-human', reason: 'remote-access' },
  {
    pattern: /^pnpm\s+(test|run\s+test|biome|tsc)\b/,
    action: 'auto-approve',
    reason: 'safe-qa-tool',
  },
  {
    pattern: /^cleo\s+(verify|check|show|find|list|status|current|next)\b/,
    action: 'auto-approve',
    reason: 'safe-cleo-read',
  },
]);

/**
 * Evaluates a command against the supplied policy rules and returns the
 * resolved approval decision.
 *
 * Priority:
 * 1. Every `require-human` rule across the list is tested first.
 * 2. `auto-approve` rules are tested only if no block fired.
 * 3. Fallback is `{ action: 'require-human', reason: 'default' }` so
 *    unknown commands never auto-execute.
 *
 * Callers MAY pass a custom rule list, but they CANNOT relax default blocks —
 * any rule elsewhere in the list that matches with `require-human` wins over
 * any auto-approve match, regardless of order.
 *
 * @param command The fully-resolved command string (executable plus arguments).
 * @param rules The ordered rule list. Defaults to {@link DEFAULT_POLICY_RULES}.
 * @returns The approval decision including the matched reason.
 */
export function evaluatePolicy(
  command: string,
  rules: readonly PolicyRule[] = DEFAULT_POLICY_RULES,
): EvaluatePolicyResult {
  for (const rule of rules) {
    if (rule.action === 'require-human' && rule.pattern.test(command)) {
      return {
        action: 'require-human',
        reason: rule.reason,
        matchedPattern: rule.pattern.source,
      };
    }
  }
  for (const rule of rules) {
    if (rule.action === 'auto-approve' && rule.pattern.test(command)) {
      return {
        action: 'auto-approve',
        reason: rule.reason,
        matchedPattern: rule.pattern.source,
      };
    }
  }
  return { action: 'require-human', reason: 'default' };
}
