/**
 * Structured session recording via llmtxt AgentSession — T947 Step 2.
 *
 * Provides a high-level `recordAgentSession` function that writes a
 * complete agent run (prompt, output, tool calls, timing, exit code)
 * to the project's `.cleo/sessions/<sessionId>.llmtxt` path using the
 * llmtxt `AgentSession` primitive.
 *
 * Design decisions:
 *   - Uses `openAgentSession` / `closeAgentSession` from the lower-level
 *     {@link ./agent-session-adapter.ts} rather than duplicating backend
 *     setup. This file is a thin write-path convenience wrapper only.
 *   - Session data is contributed via `session.contribute()` so the
 *     llmtxt receipt's `eventCount` is incremented and the structured
 *     run object is embedded in the signed receipt.
 *   - The `.llmtxt` file path returned is deterministic:
 *     `<projectRoot>/.cleo/sessions/<sessionId>.llmtxt`. The caller is
 *     responsible for writing structured content there; this function
 *     writes the llmtxt receipt record only (the path is reserved for
 *     future wave-B rich export).
 *   - NEVER throws. All peer-dep and I/O failures degrade to a best-
 *     effort stub result with `sessionId: "<agentId>-<ts>"`.
 *
 * Non-goals:
 *   - Does NOT replace the CLEO `Session` record in `tasks.db`.
 *   - Does NOT write the structured `.llmtxt` document itself in this
 *     wave (Wave B will adopt `formatLlmtxt` from `llmtxt/export` for
 *     that purpose).
 *
 * @epic T947
 * @adr ADR-051 §6 — receipt as per-session audit companion
 * @see ./agent-session-adapter.ts (AgentSession open/close/wrap primitives)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { getProjectRoot } from '../paths.js';
import { closeAgentSession, openAgentSession } from './agent-session-adapter.js';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * A single tool invocation recorded within an agent session.
 */
export interface AgentToolCall {
  /** Tool name (e.g. `"bash"`, `"read_file"`, `"cleo-dispatch"`). */
  readonly name: string;
  /** Arguments passed to the tool. May be any JSON-serialisable value. */
  readonly args: unknown;
  /** Value returned by the tool. May be any JSON-serialisable value. */
  readonly result: unknown;
}

/**
 * Input options for {@link recordAgentSession}.
 */
export interface RecordAgentSessionOptions {
  /** Agent identifier (e.g. `"cleo-prime"`, `"subagent-T947"`). */
  readonly agentId: string;
  /**
   * CLEO task ID this run is associated with.
   * When present, embedded in the session document for traceability.
   */
  readonly taskId?: string;
  /** Full prompt / user instruction given to the agent. */
  readonly prompt: string;
  /** Full agent output / response text. */
  readonly output: string;
  /** Ordered list of tool invocations made during the session. */
  readonly toolCalls: AgentToolCall[];
  /** ISO 8601 UTC timestamp when the session started. */
  readonly startedAt: string;
  /** ISO 8601 UTC timestamp when the session ended. */
  readonly endedAt: string;
  /**
   * Process exit code. `0` = success, non-zero = failure.
   * Matches the llmtxt `AgentSession` contract for `eventCount`
   * (a zero-eventCount receipt is NOT emitted on non-zero exit).
   */
  readonly exitCode: number;
  /**
   * Absolute project root. Defaults to `getProjectRoot()`.
   */
  readonly projectRoot?: string;
}

/**
 * Result returned by {@link recordAgentSession}.
 */
export interface RecordAgentSessionResult {
  /**
   * Session identifier as recorded in the llmtxt receipt, or a best-effort
   * stub when llmtxt peer deps are unavailable.
   */
  readonly sessionId: string;
  /**
   * Absolute path where the `.llmtxt` session document was written.
   * Path is always populated; the file contains a minimal JSON stub
   * when llmtxt is unavailable.
   */
  readonly llmtxtPath: string;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Record a completed agent session as a structured `.llmtxt` document.
 *
 * Writes via llmtxt AgentSession to
 * `<projectRoot>/.cleo/sessions/<sessionId>.llmtxt` and appends
 * the signed receipt to `.cleo/audit/receipts.jsonl`.
 *
 * Returns both the canonical `sessionId` and the absolute `llmtxtPath`
 * so callers can reference the artefact for later retrieval.
 *
 * NEVER throws — all failures degrade to a best-effort stub so that
 * callers (e.g. `cleo complete`, `cleo session end`) are never blocked.
 *
 * @param options - Session recording options.
 * @returns Resolved session id and path.
 *
 * @example
 * ```ts
 * import { recordAgentSession } from '@cleocode/core/sessions/agent-session';
 *
 * const { sessionId, llmtxtPath } = await recordAgentSession({
 *   agentId: 'cleo-prime',
 *   taskId: 'T947',
 *   prompt: 'Implement blob-ops.ts',
 *   output: 'Done. See blob-ops.ts.',
 *   toolCalls: [{ name: 'bash', args: { cmd: 'pnpm run build' }, result: 0 }],
 *   startedAt: new Date().toISOString(),
 *   endedAt: new Date().toISOString(),
 *   exitCode: 0,
 * });
 * console.log(sessionId, llmtxtPath);
 * ```
 *
 * @epic T947
 * @adr ADR-051 §6
 */
export async function recordAgentSession(
  options: RecordAgentSessionOptions,
): Promise<RecordAgentSessionResult> {
  const projectRoot = options.projectRoot ?? getProjectRoot();

  // Build session document content for the .llmtxt file
  const sessionDoc = buildSessionDocument(options);

  // Open llmtxt AgentSession — null when peer deps absent
  const handle = await openAgentSession({
    agentId: options.agentId,
    projectRoot,
  });

  let sessionId: string;

  if (handle !== null) {
    // Contribute the session document inside an llmtxt session so
    // the receipt's eventCount is incremented.
    try {
      await handle.session.contribute(async () => {
        // The contribution value is the structured session snapshot.
        // llmtxt scans the returned object for `documentId` / `documentIds`
        // fields (§3.3). We embed `documentId` so the receipt references
        // this session's canonical path.
        return {
          documentId: `cleo:session:${options.agentId}:${options.startedAt}`,
          taskId: options.taskId,
          toolCallCount: options.toolCalls.length,
          exitCode: options.exitCode,
        };
      });
    } catch {
      /* Contribution failure is best-effort — receipt still emitted below. */
    }

    const receipt = await closeAgentSession(handle);
    // Use the llmtxt-generated session id when available; fall back to
    // the agent+timestamp stub.
    sessionId = receipt?.sessionId ?? buildStubSessionId(options.agentId, options.startedAt);
  } else {
    // Peer deps unavailable — generate a deterministic stub id.
    sessionId = buildStubSessionId(options.agentId, options.startedAt);
  }

  const llmtxtPath = buildSessionPath(projectRoot, sessionId);

  // Write the structured document to disk regardless of llmtxt availability.
  await persistSessionDocument(llmtxtPath, sessionDoc);

  return { sessionId, llmtxtPath };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Build a deterministic stub session id from agentId + ISO timestamp.
 *
 * Format: `<agentId>-<epoch-ms>` — URL-safe, sortable, unique per agent
 * per millisecond (sufficient for audit trail purposes).
 *
 * @internal
 */
function buildStubSessionId(agentId: string, startedAt: string): string {
  const safeAgent = agentId.replace(/[^a-z0-9_-]/gi, '-').slice(0, 32);
  const epochMs = new Date(startedAt).getTime();
  return `${safeAgent}-${Number.isFinite(epochMs) ? epochMs : Date.now()}`;
}

/**
 * Compute the absolute `.llmtxt` path for a session document.
 *
 * @param projectRoot - Absolute project root.
 * @param sessionId   - Session identifier (URL-safe string).
 * @returns Absolute path `<projectRoot>/.cleo/sessions/<sessionId>.llmtxt`.
 *
 * @internal
 */
function buildSessionPath(projectRoot: string, sessionId: string): string {
  return resolvePath(projectRoot, '.cleo', 'sessions', `${sessionId}.llmtxt`);
}

/**
 * Build the text content of the `.llmtxt` session document.
 *
 * Uses a minimal structured format (YAML-ish frontmatter + JSON body)
 * so the file is both human-readable and machine-parseable. Wave B will
 * replace this with a proper `formatLlmtxt` call once the export-document
 * module is stable.
 *
 * @internal
 */
function buildSessionDocument(opts: RecordAgentSessionOptions): string {
  const lines: string[] = [
    '---',
    `agent: ${opts.agentId}`,
    ...(opts.taskId ? [`task: ${opts.taskId}`] : []),
    `started_at: ${opts.startedAt}`,
    `ended_at: ${opts.endedAt}`,
    `exit_code: ${opts.exitCode}`,
    `tool_call_count: ${opts.toolCalls.length}`,
    '---',
    '',
    '## Prompt',
    '',
    opts.prompt,
    '',
    '## Output',
    '',
    opts.output,
    '',
  ];

  if (opts.toolCalls.length > 0) {
    lines.push('## Tool Calls', '');
    lines.push('```json');
    lines.push(JSON.stringify(opts.toolCalls, null, 2));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Write the session document to disk atomically (tmp → rename).
 *
 * Creates the `.cleo/sessions/` directory on first use. Silently
 * ignores write failures (best-effort, matching the adapter's contract).
 *
 * @internal
 */
async function persistSessionDocument(filePath: string, content: string): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    await writeFile(tmpPath, content, { encoding: 'utf-8' });
    const { rename } = await import('node:fs/promises');
    await rename(tmpPath, filePath);
  } catch {
    /* Best-effort — never fail the caller on a session-write error. */
  }
}
