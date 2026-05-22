/**
 * defineSdkTool — factory for schema-annotated SDK tool registration.
 *
 * Wraps a tool function with identity metadata and JSON Schema annotations so
 * external consumers (Studio, MCP adapter, agent registries) can discover and
 * invoke the tool programmatically.
 *
 * @arch SDK Tool (Category B) infrastructure helper
 * @task T10068
 * @epic T9835
 */

import type { SdkToolIdentity } from '@cleocode/contracts';

/** JSON Schema (draft-07 subset) for input/output type annotation. */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  [key: string]: unknown;
}

/** Full specification for a schema-annotated SDK tool. */
export interface SdkToolSpec<TInput, TOutput> {
  /** Stable identity metadata. */
  identity: SdkToolIdentity;
  /** JSON Schema describing the input shape. */
  inputSchema: JsonSchema;
  /** JSON Schema describing the output shape. */
  outputSchema: JsonSchema;
  /** The tool implementation — MUST be pure functional (no I/O). */
  fn: (input: TInput) => TOutput;
}

/** A fully registered SDK tool ready for discovery and invocation. */
export interface RegisteredSdkTool<TInput, TOutput> {
  /** Stable identity metadata (name, description, version). */
  readonly identity: SdkToolIdentity;
  /** JSON Schema for the tool's input. */
  readonly inputSchema: JsonSchema;
  /** JSON Schema for the tool's output. */
  readonly outputSchema: JsonSchema;
  /** Invoke the tool with the given input. */
  readonly invoke: (input: TInput) => TOutput;
}

/**
 * Wrap a pure tool function with schema annotations for external discovery.
 *
 * The returned object satisfies the SDK Tool (Category B) contract and can be
 * registered in any agent tool registry or MCP adapter without modification.
 *
 * @param spec - Tool identity, schemas, and implementation
 * @returns Annotated, immutable tool descriptor
 *
 * @example
 * ```typescript
 * const myTool = defineSdkTool({
 *   identity: { name: 'my-tool', description: 'Does X', version: '1.0.0' },
 *   inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
 *   outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
 *   fn: ({ id }) => ({ result: `processed-${id}` }),
 * });
 * const out = myTool.invoke({ id: 'T1' });
 * ```
 */
export function defineSdkTool<TInput, TOutput>(
  spec: SdkToolSpec<TInput, TOutput>,
): RegisteredSdkTool<TInput, TOutput> {
  return Object.freeze({
    identity: spec.identity,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    invoke: spec.fn,
  });
}
