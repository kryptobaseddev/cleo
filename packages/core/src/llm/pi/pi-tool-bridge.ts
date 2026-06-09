/**
 * Pi ↔ dispatch-engine bridge (T1740 · AC6 · epic T11456).
 *
 * Closes the agent tool-call loop for the in-process Pi runner. Pi's agent loop
 * executes a tool the model emits by calling the `execute(toolCallId, params,
 * signal)` method of the matching `AgentTool` it finds on `AgentContext.tools`.
 * Before T1740 the Pi adapter advertised the registry's tool SCHEMAS to the
 * model (`pi-stream-fn.ts` → `SendOptions.tools`) but supplied NO executables —
 * so a model tool-call had nothing to run and the loop could only stream text.
 *
 * {@link buildPiAgentTools} projects the {@link AgentToolRegistry} into the
 * `AgentTool[]` the loop needs, binding each tool's `execute` body to the T1740
 * {@link ToolDispatchEngine}. When the model emits a tool call, Pi invokes the
 * bound `execute`, which runs the call THROUGH the dispatch engine — lookup +
 * Zod-validate + availability + budget + guarded execution + LLM-safe
 * formatting — and returns the classified result as an `AgentToolResult` Pi
 * feeds back to the model as a `tool_result`. That is the closed loop:
 *
 *   model tool-call → Pi AgentTool.execute → ToolDispatchEngine.dispatch →
 *   GuardedToolSurface side effect → formatted result → back to the model.
 *
 * ## Boundary cleanliness
 *
 * - **Gate-11** — this module defines NO atomic tool primitive; it CONSUMES the
 *   frozen registry (`toOpenAITools`-shaped schemas) and the dispatch engine.
 * - **Gate-13** — no LLM resolution / transport / client construction here; the
 *   only LLM route stays in {@link createPiStreamFn}. Tool execution is pure
 *   side-effect dispatch through the guard.
 * - **Gate-10** — the Pi `AgentTool.parameters` is a TypeBox `TSchema`; the
 *   registry carries Zod. We convert via the shared {@link zodSchemaToOpenAITool}
 *   generator (Zod v4 native `z.toJSONSchema`) and pass the resulting JSON-Schema
 *   object through as the (structurally-compatible) `parameters` WITHOUT a
 *   typebox value-import, matching `pi-stream-fn.ts`'s quarantine.
 *
 * @task T1740
 * @epic T11456
 * @see ../../tools/dispatch.js — the dispatch engine this binds the loop to
 * @see ./pi-stream-fn.js — the sibling that advertises the same tools' schemas
 */

import { getLogger } from '../../logger.js';
import type { AgentToolRegistry } from '../../tools/agent-registry.js';
import type { ToolCall, ToolDispatchEngine, ToolDispatchResult } from '../../tools/dispatch.js';
import { zodSchemaToOpenAITool } from '../../tools/schema-gen.js';

const logger = getLogger('pi-tool-bridge');

/**
 * The minimal `AgentTool` shape `pi-agent-core` requires on
 * `AgentContext.tools`. Declared structurally here (NOT a type-only import of
 * `@earendil-works/pi-agent-core`'s `AgentTool`) so the bridge stays decoupled
 * from the loop package's generic `TSchema`/`TDetails` parameterization and so a
 * `pi-agent-core` minor cannot silently widen the contract we satisfy. The
 * fields mirror `AgentTool` member-for-member; the loop reads exactly these.
 */
export interface PiBridgeAgentTool {
  /** Model-visible tool name. */
  readonly name: string;
  /** Human-readable description shown to the model. */
  readonly description: string;
  /** JSON-Schema (TypeBox-structural) parameter schema for the model. */
  readonly parameters: Record<string, unknown>;
  /** UI label (Pi requires it; we reuse the name). */
  readonly label: string;
  /**
   * Execute the tool call. Pi calls this when the model emits a matching
   * tool-call; it routes THROUGH the dispatch engine and returns the formatted
   * result content. Never throws — a dispatch failure becomes an error-flagged
   * `AgentToolResult` so the loop can feed it back and continue.
   */
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<PiBridgeToolResult>;
}

/**
 * The `AgentToolResult` subset the loop reads back from {@link
 * PiBridgeAgentTool.execute}. `content` is the model-facing `tool_result` body;
 * `details` carries the structured {@link ToolDispatchResult} for logs/UI; a
 * dispatch failure is reported via the content + the `isError`-style detail.
 */
export interface PiBridgeToolResult {
  /** Text content blocks fed back to the model (one text block in v0). */
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  /** Structured dispatch result for logs / UI rendering. */
  readonly details: ToolDispatchResult;
}

/**
 * Project an {@link AgentToolRegistry} into the `AgentTool[]` the Pi loop
 * executes, binding every tool's `execute` to the shared {@link
 * ToolDispatchEngine} (AC6).
 *
 * One {@link ToolDispatchEngine} instance is shared across all returned tools so
 * the run-scoped budget (call count / time ceilings) is enforced ACROSS the
 * whole turn, not per tool. Each `execute`:
 *   1. wraps Pi's `(toolCallId, params)` into a {@link ToolCall};
 *   2. dispatches it through the engine (validate → availability → budget →
 *      guarded execution → format);
 *   3. returns the formatted content as an `AgentToolResult` Pi feeds back.
 *
 * @param engine - The dispatch engine (carries registry + guard + budget).
 * @returns The `AgentTool[]` to assign to `AgentContext.tools`.
 */
export function buildPiAgentTools(
  engine: ToolDispatchEngine,
  registry: AgentToolRegistry,
): PiBridgeAgentTool[] {
  return registry.list().map((descriptor) => {
    // Reuse the SINGLE shared schema generator so the bridge's advertised schema
    // is byte-identical to what `pi-stream-fn.ts` puts on the wire (DRY, Gate-10
    // — Zod → JSON-Schema, no typebox value-import).
    const { inputSchema } = zodSchemaToOpenAITool({
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters,
    });
    return {
      name: descriptor.name,
      description: descriptor.description,
      parameters: inputSchema,
      label: descriptor.name,
      async execute(
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<PiBridgeToolResult> {
        const call: ToolCall = {
          id: toolCallId,
          name: descriptor.name,
          // Pi passes the schema-validated params object; normalize a non-object
          // to an empty record so the engine's own re-validation runs cleanly.
          arguments: isRecord(params) ? params : {},
        };
        const result = await engine.dispatch(call, signal);
        if (!result.ok) {
          logger.debug(
            { tool: descriptor.name, kind: result.kind, code: result.code },
            'pi tool dispatch failed (contained)',
          );
        }
        return toAgentToolResult(result);
      },
    };
  });
}

/**
 * Convert a {@link ToolDispatchResult} into the {@link PiBridgeToolResult} the
 * loop reads. Success → the `display` body; failure → the redacted, classified
 * `[CODE] message` body. Either way it is a normal (non-throwing) result so the
 * loop continues — Pi's contract is that a tool encodes failure in its result,
 * not by throwing.
 *
 * @param result - The dispatch outcome.
 * @returns The Pi-shaped tool result.
 */
function toAgentToolResult(result: ToolDispatchResult): PiBridgeToolResult {
  const text = result.ok
    ? result.display
    : `[${result.code}] ${result.message}${formatIssues(result)}`;
  return { content: [{ type: 'text', text }], details: result };
}

/** Append flattened arg-validation issues to a failure body, when present. */
function formatIssues(result: Extract<ToolDispatchResult, { ok: false }>): string {
  if (!result.issues || result.issues.length === 0) return '';
  return `\n${result.issues.map((i) => `- ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n')}`;
}

/** Narrow an unknown to a plain record (Pi may hand a non-object on edge cases). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
