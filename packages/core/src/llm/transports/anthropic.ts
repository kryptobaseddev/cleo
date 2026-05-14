/**
 * Anthropic LLM transport — real implementation.
 *
 * Maps {@link TransportRequest} / {@link TransportMessage} / {@link TransportTool}
 * to the `@anthropic-ai/sdk` `messages.create` call and normalizes the SDK
 * response into a {@link NormalizedResponse}.
 *
 * Construction: `new AnthropicTransport({ apiKey, baseUrl?, defaultHeaders? })`
 * where `defaultHeaders` carries OAuth `Authorization: Bearer …` headers when
 * the credential was resolved as `authType: 'oauth'`.
 *
 * W0c adds stub `stream()` + `apiMode` for compile parity with the extended
 * `LlmTransport` interface. Wave 1c migration (T-llm-p4-1c) replaces the stub
 * with a real streaming implementation backed by the Anthropic SDK event stream.
 *
 * @module llm/transports/anthropic
 * @task T9263
 * @task T9282 (W0c — stub stream() + apiMode)
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  Message,
  MessageParam,
  TextBlock,
  ThinkingBlock,
  Tool,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages/messages.js';

import type { NormalizedDelta, TransportContext } from '@cleocode/contracts/llm/interfaces.js';
import type {
  LlmTransport,
  NormalizedResponse,
  NormalizedToolCall,
  NormalizedUsage,
  TransportMessage,
  TransportRequest,
  TransportTool,
} from '@cleocode/contracts/llm/normalized-response.js';
import type { ApiMode } from '@cleocode/contracts/llm/provider-id.js';

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link AnthropicTransport}.
 *
 * `baseUrl` is used to route requests through proxy providers or internal
 * gateways. `defaultHeaders` carries extra HTTP headers — typically the
 * `Authorization: Bearer …` header when using OAuth credentials and the
 * `anthropic-beta` header for extended-thinking enablement.
 */
export interface AnthropicTransportOptions {
  /** API key or OAuth bearer token. */
  apiKey: string;
  /** Override base URL (e.g. for proxies or on-prem deployments). */
  baseUrl?: string;
  /** Extra headers merged into every SDK request. */
  defaultHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Type guards (narrows ContentBlock discriminated union)
// ---------------------------------------------------------------------------

/** Checks if a content block is a plain text block. */
function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}

/** Checks if a content block is a tool-use block. */
function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

/** Checks if a content block is a thinking block. */
function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === 'thinking';
}

// ---------------------------------------------------------------------------
// Message mapping helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain-text content from a message's `content` field.
 *
 * Handles the W0c multimodal union: when `content` is a string, returns it
 * directly. When it is a block array, concatenates text blocks and drops image
 * blocks. The Anthropic native multimodal path (sending actual image blocks in
 * the API request) is wired in Wave 1c / Wave 4d.
 *
 * @param content - Message content field (string or block array).
 * @returns Plain-text string for Anthropic SDK message params.
 */
function extractPlainText(content: TransportMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter(
      (block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text',
    )
    .map((block) => block.text)
    .join('');
}

/**
 * Maps a provider-neutral {@link TransportMessage} array to the Anthropic
 * `MessageParam[]` format.
 *
 * Tool-result messages (`role: 'tool'`) are mapped to `role: 'user'` with a
 * `tool_result` content block, as required by the Anthropic Messages API.
 *
 * Multimodal content blocks (W0c extension): text blocks are concatenated;
 * image blocks are dropped until Wave 1c wires native Anthropic image support.
 */
function mapMessages(messages: TransportMessage[]): MessageParam[] {
  return messages.map((msg): MessageParam => {
    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.toolUseId ?? '',
            content: extractPlainText(msg.content),
          },
        ],
      };
    }
    return {
      role: msg.role,
      content: extractPlainText(msg.content),
    };
  });
}

/**
 * Maps a {@link TransportTool} array to the Anthropic `Tool[]` format.
 *
 * The Anthropic API expects tools in the `{ name, description, input_schema }`
 * shape where `input_schema` is a JSON Schema object with `type: "object"`.
 */
function mapTools(tools: TransportTool[]): Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Tool['input_schema'],
  }));
}

// ---------------------------------------------------------------------------
// Response mapping helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the joined text content from the Anthropic content block array.
 * Returns `null` when no text blocks are present (pure tool-call response).
 */
function extractTextContent(blocks: ContentBlock[]): string | null {
  const textParts = blocks.filter(isTextBlock).map((b) => b.text);
  return textParts.length > 0 ? textParts.join('') : null;
}

/**
 * Extracts the joined thinking text from the Anthropic content block array.
 * Returns `null` when no thinking blocks are present.
 */
function extractReasoning(blocks: ContentBlock[]): string | null {
  const thinkingParts = blocks.filter(isThinkingBlock).map((b) => b.thinking);
  return thinkingParts.length > 0 ? thinkingParts.join('') : null;
}

/**
 * Extracts normalized tool calls from the Anthropic content block array.
 * Returns `null` when no tool-use blocks are present.
 */
function extractToolCalls(blocks: ContentBlock[]): NormalizedToolCall[] | null {
  const toolBlocks = blocks.filter(isToolUseBlock);
  if (toolBlocks.length === 0) return null;
  return toolBlocks.map((b) => ({
    id: b.id,
    name: b.name,
    arguments: JSON.stringify(b.input),
  }));
}

/**
 * Maps the Anthropic `Usage` object to {@link NormalizedUsage}.
 *
 * `cache_read_input_tokens` is `null` when caching was not used; we map
 * `null → undefined` to keep the optional field absent in the output.
 */
function mapUsage(usage: Message['usage']): NormalizedUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedTokens: usage.cache_read_input_tokens ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// AnthropicTransport
// ---------------------------------------------------------------------------

/**
 * Real Anthropic transport.
 *
 * Wraps `@anthropic-ai/sdk` and normalizes requests/responses to/from the
 * provider-neutral {@link LlmTransport} interface. Supports both API-key and
 * OAuth credentials via `defaultHeaders`.
 *
 * @example
 * ```ts
 * const transport = new AnthropicTransport({ apiKey: process.env.ANTHROPIC_API_KEY! });
 * const response = await transport.complete({
 *   model: 'claude-sonnet-4-6',
 *   messages: [{ role: 'user', content: 'Hello' }],
 *   maxTokens: 1024,
 * });
 * ```
 */
export class AnthropicTransport implements LlmTransport {
  /** Provider identifier — always `'anthropic'`. */
  readonly provider = 'anthropic' as const;

  /**
   * Wire protocol spoken by this transport — always `'anthropic_messages'`.
   *
   * @see ADR-072 §Type lock-in
   */
  readonly apiMode: ApiMode = 'anthropic_messages' as const;

  private readonly _client: Anthropic;

  /**
   * Create an `AnthropicTransport`.
   *
   * @param options - API key, optional base URL, and optional extra headers.
   */
  constructor(options: AnthropicTransportOptions) {
    this._client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      defaultHeaders: options.defaultHeaders,
    });
  }

  /**
   * Execute a single completion call against the Anthropic Messages API.
   *
   * Maps provider-neutral {@link TransportRequest} fields to the Anthropic
   * SDK params, invokes `messages.create`, then maps the response back to a
   * {@link NormalizedResponse}.
   *
   * @param request - Provider-neutral request parameters.
   * @param _ctx - Transport context (request ID, abort signal). Currently unused
   *   by this implementation; `request.signal` takes precedence for abort support.
   *   Wave 1c wires `ctx.requestId` into provider telemetry.
   * @returns Normalized response including content, tool calls, usage, and raw SDK object.
   */
  async complete(request: TransportRequest, _ctx?: TransportContext): Promise<NormalizedResponse> {
    const { model, messages, maxTokens, system, tools, temperature, signal } = request;

    const anthropicMessages = mapMessages(messages);
    const anthropicTools = tools != null && tools.length > 0 ? mapTools(tools) : undefined;

    const response = await this._client.messages.create(
      {
        model,
        max_tokens: maxTokens,
        messages: anthropicMessages,
        ...(system != null ? { system } : {}),
        ...(anthropicTools != null ? { tools: anthropicTools } : {}),
        ...(temperature != null ? { temperature } : {}),
      },
      signal != null ? { signal } : undefined,
    );

    const content = extractTextContent(response.content);
    const toolCalls = extractToolCalls(response.content);
    const reasoning = extractReasoning(response.content);
    const usage = mapUsage(response.usage);

    return {
      id: response.id,
      model: response.model,
      content,
      toolCalls,
      stopReason: response.stop_reason ?? 'end_turn',
      usage,
      ...(reasoning != null ? { reasoning } : {}),
      raw: response,
    };
  }

  /**
   * Stream a completion against the Anthropic Messages API.
   *
   * STUB: W1 migration will implement stream() for anthropic.
   *
   * Wave 1c (T-llm-p4-1c) replaces this stub with a real implementation
   * backed by the Anthropic SDK's streaming event source. The real
   * implementation will run deltas through `StreamingThinkScrubber` before
   * yielding, routing reasoning blocks to `delta.reasoning` and visible text
   * to `delta.text`.
   *
   * @param _request - Ignored until Wave 1c implementation lands.
   * @param _ctx - Ignored until Wave 1c implementation lands.
   * @throws {Error} Always, until the real implementation lands in Wave 1c.
   */
  // biome-ignore lint/correctness/useYield: stub — Wave 1c replaces with real streaming impl
  async *stream(
    _request: TransportRequest,
    _ctx: TransportContext,
  ): AsyncIterable<NormalizedDelta> {
    // STUB: W1 migration will implement stream() for anthropic
    throw new Error('STUB: W1 migration will implement stream() for anthropic');
  }
}
