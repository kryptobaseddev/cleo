/**
 * OpenAI-format tool-schema generation (T1739 · AC3 · epic T11456).
 *
 * The SINGLE generator that turns a Cleo Zod parameter schema into the
 * OpenAI / JSON-Schema {@link TransportTool} shape the ModelRunner + transport
 * wire layer (and the Pi adapter) consume. Both the agent-facing
 * {@link ./agent-registry.js | AgentToolRegistry} (AC3) and the Pi streamFn
 * bridge (`core/src/llm/pi/pi-stream-fn.ts`) call THIS function, so there is one
 * conversion doctrine and no drift (DRY).
 *
 * Uses Zod v4's native `z.toJSONSchema` — NO `zod-to-json-schema` dependency and
 * NO typebox value-import, so the cleo↔Pi tool surface carries zero typebox
 * (Gate 10). The resulting `inputSchema` is a plain JSON-Schema object the
 * transport passes through verbatim after any provider-specific adaptation.
 *
 * @task T1739
 * @epic T11456
 */

import type { TransportTool } from '@cleocode/contracts/llm/normalized-response.js';
import { z } from 'zod';

/**
 * A name + description + Zod-schema tool definition, in the shape the schema
 * generator consumes. Both the agent registry's {@link
 * ./agent-registry.js | AgentToolDescriptor} and the Pi streamFn's `PiZodTool`
 * structurally satisfy this, so one generator serves both.
 */
export interface ZodSchemaTool {
  /** Tool name as the provider / model will see it. */
  readonly name: string;
  /** Human-readable description for the model. */
  readonly description: string;
  /** Zod schema for the tool's input parameters. */
  readonly parameters: z.ZodType;
}

/**
 * Convert a Cleo Zod-schema tool into the OpenAI-format JSON-Schema
 * {@link TransportTool}.
 *
 * The conversion is purely a function of its input (no I/O, no global state), so
 * it is safe to call at any time, including during a lazy
 * {@link ./agent-registry.js | AgentToolRegistry} discovery pass.
 *
 * @param tool - The Cleo Zod tool ({@link ZodSchemaTool}).
 * @returns The transport-shaped JSON-Schema tool (OpenAI function format).
 *
 * @example
 * ```ts
 * const t = zodSchemaToOpenAITool({
 *   name: 'read_file',
 *   description: 'Read a file as text',
 *   parameters: z.object({ path: z.string() }),
 * });
 * // t.inputSchema === { type: 'object', properties: { path: { type: 'string' } }, ... }
 * ```
 */
export function zodSchemaToOpenAITool(tool: ZodSchemaTool): TransportTool {
  // Zod v4's native `z.toJSONSchema` renders a plain JSON-Schema object — NO
  // `zod-to-json-schema` dep and NO typebox value-import at this boundary, so
  // every tool surface (registry + Pi bridge) carries zero typebox (Gate 10).
  const inputSchema = z.toJSONSchema(tool.parameters) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
  };
}
