/**
 * Optional retrieval telemetry registered with the existing operation lifecycle.
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 * @packageDocumentation
 */
import { captureProjectScope, worktreeScope } from '../../project-scope.js';
import { trackBackgroundOp } from '../../store/background-ops.js';
import { getCurrentSessionId } from './get-current-session-id.js';
import { incrementCitationCounts } from './increment-citation-counts.js';
import { logRetrieval } from './log-retrieval.js';

/**
 * Register optional citation writes within the caller's captured ownership.
 * @param projectRoot - Explicit owning project root.
 * @param entryIds - Returned evidence identities copied before scheduling.
 * @returns No durable receipt; the existing background barrier observes completion.
 * @remarks Reuses the inherited execution deadline and cancellation without a new
 * budget or queue. Underlying citation failures remain best-effort.
 * @example
 * ```ts
 * scheduleCitationTracking(projectRoot, ['O-example']);
 * ```
 */
export function scheduleCitationTracking(projectRoot: string, entryIds: string[]): void {
  const scope = captureProjectScope(projectRoot, worktreeScope.getStore());
  const ids = [...entryIds];
  trackBackgroundOp(
    () => worktreeScope.run(scope, () => incrementCitationCounts(scope.worktreeRoot, ids)),
    scope.execution,
  );
}

/**
 * Capture attribution, then independently register citations and a retrieval log.
 * @param projectRoot - Explicit owning project root.
 * @param query - Original search query or exact fetched identity list.
 * @param entryIds - Returned evidence identities copied before asynchronous work.
 * @param source - Existing retrieval path label retained in the log.
 * @param tokensUsed - Existing estimated token count, without recalculating policy.
 * @returns Completion of session capture and scheduling, not a durable telemetry receipt.
 * @remarks Both writers retain the original operation lifetime. A failed sibling
 * cannot release the barrier over pending work. No global session is resolved
 * after scheduling; underlying telemetry failures remain best-effort.
 * @example
 * ```ts
 * await scheduleRetrievalTelemetry(projectRoot, 'auth', ['O-example'], 'find', 50);
 * ```
 */
export async function scheduleRetrievalTelemetry(
  projectRoot: string,
  query: string,
  entryIds: string[],
  source: string,
  tokensUsed: number,
): Promise<void> {
  const scope = captureProjectScope(projectRoot, worktreeScope.getStore());
  const ids = [...entryIds];
  return worktreeScope.run(scope, async () => {
    const sessionId = await getCurrentSessionId(scope.worktreeRoot);
    scheduleCitationTracking(scope.worktreeRoot, ids);
    trackBackgroundOp(
      () =>
        worktreeScope.run(scope, () =>
          logRetrieval(scope.worktreeRoot, query, ids, source, tokensUsed, sessionId),
        ),
      scope.execution,
    );
  });
}
