/**
 * Shared conduit trace writer for SDK-backed providers.
 *
 * Writes structured span events to conduit.db via the CLEO transport layer.
 * Both T581 (Claude SDK) and T582 (OpenAI SDK) use this module so the
 * conduit write path stays DRY.
 *
 * The writer is fire-and-forget: if conduit is unavailable, write failures are
 * silently swallowed so that missing tracing never breaks agent execution.
 *
 * @task T582
 */

/**
 * A single normalised span event written to conduit.
 *
 * @remarks
 * This shape is intentionally minimal — only fields that both SDK providers
 * can populate consistently are required. Provider-specific fields go into
 * the `metadata` bag.
 */
export interface ConduitSpanEvent {
  /** Unique identifier for this span (from the SDK). */
  spanId: string;
  /** The task ID this span belongs to. */
  taskId: string;
  /** The name of the agent that produced this span. */
  agentName: string;
  /** Type of span: `'agent'`, `'function'`, `'handoff'`, `'generation'`, etc. */
  spanType: string;
  /** ISO timestamp when the span started. */
  startTime: string;
  /** ISO timestamp when the span ended. */
  endTime: string;
  /** Optional tool name for function/tool spans. */
  toolName?: string;
  /** Optional handoff target agent name. */
  handoffTarget?: string;
  /** Extra provider-specific metadata. */
  metadata?: Record<string, unknown>;
}

/** Conduit write result — only used internally for error handling. */
interface WriteResult {
  written: boolean;
  error?: string;
}

/**
 * Write a single span event to conduit via `cleo` CLI transport.
 *
 * Falls back gracefully when conduit is unavailable. All errors are caught
 * and returned in the result rather than thrown.
 *
 * @param event - The span event to persist.
 * @returns Result indicating whether the write succeeded.
 *
 * @remarks
 * The current implementation writes to conduit using the `cleo conduit send`
 * CLI command. This keeps the trace writer free of direct DB dependencies and
 * consistent with the no-direct-SQLite rule (ADR).
 *
 * When conduit grows a native TS API this writer can be updated without
 * changing caller code.
 */
export async function writeSpanToConduit(event: ConduitSpanEvent): Promise<WriteResult> {
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    const payload = JSON.stringify({
      type: 'agent_span',
      version: '1',
      ...event,
    });

    // Use the CLEO conduit send command which handles DB access via the
    // business logic layer (no direct SQLite per ADR-013 §9).
    await execAsync(`cleo conduit send --type agent_span --payload ${JSON.stringify(payload)}`);
    return { written: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { written: false, error: message };
  }
}

/**
 * Write multiple span events to conduit, swallowing individual write failures.
 *
 * @param events - Array of span events to persist.
 * @returns Number of events successfully written.
 */
export async function writeSpanBatchToConduit(events: ConduitSpanEvent[]): Promise<number> {
  let written = 0;
  for (const event of events) {
    const result = await writeSpanToConduit(event);
    if (result.written) written++;
  }
  return written;
}
