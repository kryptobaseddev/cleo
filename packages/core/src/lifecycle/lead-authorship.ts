/**
 * Lead authorship-bypass guard (FISE-2 · T9231 · ADR-070).
 *
 * Moved out of the retired IVTR module (`ivtr-loop.ts`, deleted in T14311)
 * because it guards the `implemented` gate, not the IVTR loop.
 *
 * @task T9231
 * @task T14311 — moved out of ivtr-loop.ts before its deletion
 */

/**
 * Result of {@link validateSpawnRequest}.
 * @task T9231
 */
export interface SpawnRequestValidationResult {
  allowed: boolean;
  /** Populated when `allowed=false`. */
  code?: string;
  message?: string;
}

/**
 * Validate whether a Lead agent is permitted to write the `implemented` gate
 * for a task.
 *
 * A Lead MUST have produced at least one downstream delegate_task spawn event
 * for the target task in the current session before claiming authorship of
 * the `implemented` gate. If no such event exists, the write is blocked with
 * `E_LEAD_AUTHORSHIP_BYPASS`.
 *
 * Provider-neutral: detection uses the CLEO audit log (SQLite-backed) and the
 * `CLEO_AGENT_ROLE` environment variable — no adapter-specific API required.
 *
 * Override: `CLEO_OWNER_OVERRIDE=1` is not effective here because T1118 L4b
 * already silently blocks overrides for `lead` role — owners must use
 * `CLEO_AGENT_ROLE` unset or set to a non-restricted role to override.
 *
 * @param taskId - Task being verified.
 * @param gate - Gate being written (only `implemented` triggers this check).
 * @param sessionId - Active session ID for audit log lookup.
 * @param cwd - Project root (defaults to `process.cwd()`).
 *
 * @task T9231
 * @adr ADR-070
 */
export async function validateSpawnRequest(
  taskId: string,
  gate: string,
  sessionId: string | null | undefined,
): Promise<SpawnRequestValidationResult> {
  const role = process.env['CLEO_AGENT_ROLE'];
  const isLeadOrHigher = role === 'lead';

  if (!isLeadOrHigher || gate !== 'implemented') {
    return { allowed: true };
  }

  if (!sessionId) {
    return { allowed: true };
  }

  try {
    const { queryAudit } = await import('../audit.js');
    const sessionEntries = await queryAudit({ sessionId, taskId });
    const hasDelegateEvent = sessionEntries.some(
      (e) =>
        e.operation === 'delegate_task' ||
        (e.domain === 'orchestrate' && e.operation === 'spawn' && e.result.success),
    );

    if (!hasDelegateEvent) {
      return {
        allowed: false,
        code: 'E_LEAD_AUTHORSHIP_BYPASS',
        message:
          `Lead agent attempted to write implemented gate for ${taskId} without a ` +
          `sub-agent delegation event. Leads MUST fan out implementation to Workers ` +
          `via delegate_task before claiming the implemented gate. (T9231 / ADR-070)`,
      };
    }
  } catch {
    // Audit query failure is non-fatal — allow the write (graceful degradation)
    return { allowed: true };
  }

  return { allowed: true };
}
