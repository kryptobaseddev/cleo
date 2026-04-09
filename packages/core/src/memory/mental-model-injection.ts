/**
 * Pure helpers for validate-on-load mental-model injection.
 *
 * These helpers are used by:
 *   - The Pi CANT bridge (cleo-cant-bridge.ts) to build the system-prompt block
 *   - T421 empirical tests to assert on preamble content without a real Pi runtime
 *
 * No I/O. Safe to call in tests without a real DB or Pi extension context.
 *
 * @task T420
 * @epic T377
 * @wave W8
 */

// ============================================================================
// Types
// ============================================================================

/** Minimal observation shape returned by memoryFind / searchBrainCompact. */
export interface MentalModelObservation {
  /** Brain DB observation ID (O- prefix). */
  id: string;
  /** Observation type: discovery, change, feature, decision, bugfix, refactor, etc. */
  type: string;
  /** Short observation title or truncated text. */
  title: string;
  /** ISO date string for display. */
  date?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Preamble text injected into the Pi system prompt when an agent has a
 * `mental_model:` CANT block. The agent MUST re-evaluate each observation
 * against the current project state before acting.
 *
 * Exported so empirical tests (T421) can assert on its presence.
 */
export const VALIDATE_ON_LOAD_PREAMBLE =
  '===== MENTAL MODEL (validate-on-load) =====\n' +
  'These are your prior observations, patterns, and learnings for this project.\n' +
  'Before acting, you MUST re-evaluate each entry against current project state.\n' +
  'If an entry is stale, note it and proceed with fresh understanding.';

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * Build the validate-on-load mental-model injection string.
 *
 * Pure function — no I/O, safe to call in tests without a real DB.
 *
 * @param agentName - Name of the spawned agent (used in the header line).
 * @param observations - Prior mental-model observations to list.
 * @returns System-prompt block containing the preamble and numbered observations,
 *          or an empty string when `observations` is empty.
 *
 * @example
 * ```ts
 * const block = buildMentalModelInjection('my-agent', [
 *   { id: 'O-abc1', type: 'discovery', title: 'Auth uses JWT', date: '2026-04-08' },
 * ]);
 * // block contains VALIDATE_ON_LOAD_PREAMBLE + numbered list
 * ```
 */
export function buildMentalModelInjection(
  agentName: string,
  observations: MentalModelObservation[],
): string {
  if (observations.length === 0) return '';

  const lines: string[] = ['', `// Agent: ${agentName}`, VALIDATE_ON_LOAD_PREAMBLE, ''];

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const datePart = obs.date ? ` [${obs.date}]` : '';
    lines.push(`${i + 1}. [${obs.id}] (${obs.type})${datePart}: ${obs.title}`);
  }

  lines.push('===== END MENTAL MODEL =====');

  return lines.join('\n');
}
