/**
 * Claude Code Stop-hook — goal-continuation loop adapter (E4-GOAL-LOOP).
 *
 * ## What this does
 *
 * Claude Code fires the `Stop` event every time Claude finishes a response
 * turn. When a CLEO goal is active, this hook advances the goal one turn
 * (via `cleo goal advance <goalId>`) and — if the goal is not yet terminal —
 * emits a `{ decision: "block", reason: "<continuation>" }` JSON response that
 * Claude Code interprets as "do NOT stop; inject this message instead". This
 * re-nudges Claude to keep working toward the goal, closing the
 * self-renudging loop (AC2).
 *
 * ## Decision protocol (Claude Code Stop-hook contract)
 *
 * - Output `{ "decision": "block", "reason": "<user message>" }` → Claude Code
 *   does not stop; it injects `reason` as a fresh user message and continues.
 * - Output nothing (or anything not parseable as `{ decision: "block" }`) →
 *   Claude Code stops normally.
 *
 * ## Safety
 *
 * - Best-effort: any error exits 0 (Claude Code stops normally — no crash loop).
 * - Terminal goals (satisfied/abandoned/impossible) emit nothing → stop.
 * - Missing/no active goal → stop normally.
 *
 * ## Installation
 *
 * This script is registered as a Claude Code Stop hook via
 * `ClaudeCodeHookProvider.registerGoalLoopHook()` or by running
 * `cleo goal arm` (AC3). The hook entry in `~/.claude/settings.json`:
 *
 * ```json
 * {
 *   "Stop": [{
 *     "matcher": "",
 *     "hooks": [{
 *       "type": "command",
 *       "command": "node /path/to/goal-stop-hook.js # cleo-goal-loop"
 *     }]
 *   }]
 * }
 * ```
 *
 * @module @cleocode/cleo-os/harnesses/goal-stop-hook
 *
 * @task T11496 E4-GOAL-LOOP
 * @epic T11492 SG-AUTOPILOT
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 * @adr ADR-051
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The LAFS envelope shape returned by `cleo goal advance`.
 *
 * @internal
 */
interface GoalAdvanceEnvelope {
  success: boolean;
  data?: {
    continuation?: { role: string; content: string } | null;
    advanceResult?: { nextStatus: string };
    goal?: { status: string };
  };
}

/**
 * The LAFS envelope shape returned by `cleo goal status`.
 *
 * @internal
 */
interface GoalStatusEnvelope {
  success: boolean;
  data?: { id?: string; status?: string; active?: null } | null;
}

/**
 * Claude Code Stop-hook decision envelope.
 *
 * @internal
 */
interface StopDecision {
  decision: 'block';
  reason: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run the goal-loop Stop-hook logic.
 *
 * 1. Query `cleo goal status` to find the active goal.
 * 2. If no active goal → stop normally (no output).
 * 3. Call `cleo goal advance <goalId>` to advance one turn.
 * 4. If the advance result carries a continuation (goal still active) →
 *    emit a `{ decision: "block", reason: content }` JSON block to stdout.
 * 5. If terminal (satisfied/abandoned/impossible) → stop normally.
 */
async function main(): Promise<void> {
  // 1. Resolve the active goal (per-agent scoped).
  let statusEnvelope: GoalStatusEnvelope;
  try {
    const { stdout } = await execFileAsync('cleo', ['goal', 'status'], {
      timeout: 10_000,
      env: process.env,
    });
    statusEnvelope = JSON.parse(stdout.trim()) as GoalStatusEnvelope;
  } catch {
    // cleo unavailable or no project — stop normally.
    return;
  }

  const goalData = statusEnvelope?.data;
  // `active: null` means no active goal; an absent or null `id` similarly.
  if (!goalData || 'active' in goalData || !goalData.id) {
    // No active goal — stop normally.
    return;
  }

  const goalId = goalData.id;

  // 2. Advance one turn.
  let advanceEnvelope: GoalAdvanceEnvelope;
  try {
    const { stdout } = await execFileAsync('cleo', ['goal', 'advance', goalId], {
      timeout: 30_000,
      env: process.env,
    });
    advanceEnvelope = JSON.parse(stdout.trim()) as GoalAdvanceEnvelope;
  } catch {
    // Advance failed — stop normally rather than crashing.
    return;
  }

  if (!advanceEnvelope?.success) {
    // Advance returned an error envelope — stop normally.
    return;
  }

  const continuation = advanceEnvelope?.data?.continuation;

  // 3. If there is a continuation nudge, emit the block decision.
  if (continuation && typeof continuation.content === 'string') {
    const decision: StopDecision = {
      decision: 'block',
      reason: continuation.content,
    };
    process.stdout.write(JSON.stringify(decision) + '\n'); // stdout-discipline-allowed: Stop-hook contract — Claude Code reads decision JSON from stdout to determine whether to continue // stdout-write-allowed: Stop-hook protocol output (not render layer — Claude Code reads raw stdout)
  }
  // Otherwise (terminal goal) — no output → Claude Code stops normally.
}

// Run and exit cleanly on any error (never crash the hook).
main().catch(() => {
  process.exit(0);
});
