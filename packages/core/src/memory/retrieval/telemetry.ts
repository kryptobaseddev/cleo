/**
 * Optional retrieval telemetry registered with the existing operation lifecycle.
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 * @packageDocumentation
 */
import { captureProjectScope, worktreeScope } from '../../project-scope.js';
import { trackBackgroundOp } from '../../store/background-ops.js';
import { getCurrentSessionId } from './get-current-session-id.js';
import { logRetrieval } from './log-retrieval.js';

/**
 * Capture attribution, then register a retrieval-log write.
 * @param projectRoot - Explicit owning project root.
 * @param query - Original search query or exact fetched identity list.
 * @param entryIds - Returned evidence identities copied before asynchronous work.
 * @param source - Existing retrieval path label retained in the log.
 * @param tokensUsed - Existing estimated token count, without recalculating policy.
 * @returns Completion of session capture and scheduling, not a durable telemetry receipt.
 * @remarks Reads are pure (T13947): only `brain_retrieval_log` is written,
 * never the returned memory rows. Bumping `citation_count`/`updated_at` on every
 * read made whatever ranked first get cited, promoted and ranked again. The
 * writer retains the original operation lifetime; no global session is resolved
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
    trackBackgroundOp(
      () =>
        worktreeScope.run(scope, () =>
          logRetrieval(scope.worktreeRoot, query, ids, source, tokensUsed, sessionId),
        ),
      scope.execution,
    );
  });
}
