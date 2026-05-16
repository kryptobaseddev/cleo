/**
 * AWS Bedrock Converse API transport.
 *
 * Implements {@link LlmTransport} using the Bedrock Converse API
 * (`ConverseCommand` + `ConverseStreamCommand`) for chat-format message
 * exchange. Supports all models available through Bedrock's Converse surface
 * (Claude, Nova, Mistral, Llama, etc.) without the model-specific invokeModel
 * differences.
 *
 * Key behaviors:
 * - AWS credential chain via `fromNodeProviderChain()` (env → ~/.aws/credentials → IAM → SSO)
 * - Cross-region fallback: retries on `AccessDeniedException`/throttle against
 *   a configured fallback region list
 * - Guardrail integration: `guardrailConfig` from `request.meta`
 * - Tool use (function calling) via Converse `toolConfig`
 *
 * @module llm/transports/bedrock
 * @task T9317
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 5)
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseCommandOutput,
  type ConverseStreamCommandOutput,
  type GuardrailConfiguration,
  type InferenceConfiguration,
  type Message,
  type SystemContentBlock,
  type ToolConfiguration,
  type ToolInputSchema,
} from '@aws-sdk/client-bedrock-runtime';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
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
// Cross-region fallback configuration
// ---------------------------------------------------------------------------

/** Bedrock error codes that signal a region does not support the requested model. */
const CROSS_REGION_RETRY_CODES = new Set([
  'AccessDeniedException',
  'ValidationException',
  'ResourceNotFoundException',
  'ThrottlingException',
]);

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link BedrockTransport}.
 *
 * AWS credentials are resolved via the standard `fromNodeProviderChain()`
 * (env vars → `~/.aws/credentials` → IAM instance metadata → SSO).
 * Explicit profile override available via `awsProfile`.
 *
 * `fallbackRegions` is the cross-region retry list. When the primary region
 * returns a denial or throttle, regions are tried in list order.
 */
export interface BedrockTransportOptions {
  /** AWS region (defaults to `AWS_REGION` then `AWS_DEFAULT_REGION` env vars). */
  region?: string;
  /** Optional AWS credentials profile name (overrides default chain). */
  awsProfile?: string;
  /**
   * Ordered list of fallback regions to try when the primary region returns
   * a model-not-supported or throttle error.
   */
  fallbackRegions?: string[];
}

// ---------------------------------------------------------------------------
// Internal type helpers
// ---------------------------------------------------------------------------

function isCrossRegionCandidate(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name ?? '';
  return CROSS_REGION_RETRY_CODES.has(name);
}

// ---------------------------------------------------------------------------
// Message mapping helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a {@link TransportMessage}'s content.
 *
 * Concatenates text blocks; drops image blocks (Bedrock image support is out
 * of scope for this transport's initial implementation).
 */
function extractText(content: TransportMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { readonly type: 'text'; readonly text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Map provider-neutral {@link TransportMessage}[] to Bedrock `Message[]`.
 *
 * Tool-result messages (`role: 'tool'`) are mapped to `user` role with a
 * `toolResult` content block, as required by the Converse API.
 * System-role messages are extracted separately by {@link extractSystemBlocks}.
 */
function mapMessages(messages: TransportMessage[]): Message[] {
  return messages
    .filter((m) => (m as { role: string }).role !== 'system')
    .map((m): Message => {
      if ((m as { role: string }).role === 'tool') {
        return {
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: m.toolUseId ?? '',
                content: [{ text: extractText(m.content) }],
                status: 'success',
              },
            },
          ],
        };
      }
      return {
        role: (m as { role: 'user' | 'assistant' }).role,
        content: [{ text: extractText(m.content) }],
      };
    });
}

/**
 * Extract system-role messages and any top-level `system` field into Bedrock
 * `SystemContentBlock[]`.
 */
function extractSystemBlocks(messages: TransportMessage[], system?: string): SystemContentBlock[] {
  const blocks: SystemContentBlock[] = [];
  if (system) blocks.push({ text: system });
  for (const m of messages) {
    if ((m as { role: string }).role === 'system') {
      blocks.push({ text: extractText(m.content) });
    }
  }
  return blocks;
}

/**
 * Map provider-neutral {@link TransportTool}[] to Bedrock `ToolConfiguration`.
 */
function mapToolConfig(tools: TransportTool[]): ToolConfiguration {
  return {
    tools: tools.map((t) => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: { json: t.inputSchema } as ToolInputSchema,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Response mapping helpers
// ---------------------------------------------------------------------------

/** Bedrock content block narrowed to the fields we access at runtime. */
type RawContentBlock = Record<string, unknown>;

/**
 * Extract plain text from a Bedrock response's content block array.
 *
 * Uses `unknown → Record` casting via the intermediate `unknown` step to
 * satisfy the SDK's closed discriminated union without needing exhaustive
 * switch arms.
 */
function extractResponseText(blocks: RawContentBlock[]): string | null {
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block['text'] === 'string') parts.push(block['text'] as string);
  }
  return parts.length > 0 ? parts.join('') : null;
}

/**
 * Extract tool-use blocks from a Bedrock response's content block array.
 */
function extractToolCalls(blocks: RawContentBlock[]): NormalizedToolCall[] | null {
  const calls: NormalizedToolCall[] = [];
  for (const block of blocks) {
    const tu = block['toolUse'] as
      | { toolUseId?: string; name?: string; input?: unknown }
      | undefined;
    if (tu != null) {
      calls.push({
        id: tu.toolUseId ?? null,
        name: tu.name ?? '',
        arguments: JSON.stringify(tu.input ?? {}),
      });
    }
  }
  return calls.length > 0 ? calls : null;
}

// ---------------------------------------------------------------------------
// BedrockTransport
// ---------------------------------------------------------------------------

/**
 * AWS Bedrock Converse API transport.
 *
 * Wraps `@aws-sdk/client-bedrock-runtime` and normalizes requests/responses
 * to/from the provider-neutral {@link LlmTransport} interface. Uses the
 * Converse API for a uniform chat-format surface across all Bedrock models.
 *
 * Credential resolution uses `fromNodeProviderChain()` which follows the
 * standard AWS credential chain: env vars → `~/.aws/credentials` (profile)
 * → ECS container metadata → EC2 instance profile → SSO.
 *
 * Cross-region fallback retries against `options.fallbackRegions` when the
 * primary region returns an `AccessDeniedException`, `ValidationException`,
 * `ResourceNotFoundException`, or `ThrottlingException`. This is the primary
 * mechanism for handling cross-region inference profiles.
 *
 * @example
 * ```ts
 * const transport = new BedrockTransport({ region: 'us-east-1' });
 * const response = await transport.complete({
 *   model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
 *   messages: [{ role: 'user', content: 'Hello' }],
 *   maxTokens: 512,
 * });
 * ```
 */
export class BedrockTransport implements LlmTransport {
  /** Provider identifier — always `'bedrock'`. */
  readonly provider = 'bedrock' as const;

  /**
   * Wire protocol spoken by this transport — always `'bedrock_converse'`.
   *
   * @see ADR-072 §Type lock-in
   */
  readonly apiMode: ApiMode = 'bedrock_converse' as const;

  private readonly _primaryRegion: string;
  private readonly _fallbackRegions: string[];
  private readonly _awsProfile: string | undefined;

  /** Lazily-constructed per-region client cache. */
  private readonly _clients: Map<string, BedrockRuntimeClient> = new Map();

  /**
   * Create a `BedrockTransport`.
   *
   * @param options - AWS region, optional credential profile, and fallback region list.
   */
  constructor(options: BedrockTransportOptions = {}) {
    this._primaryRegion =
      options.region ??
      process.env['AWS_REGION'] ??
      process.env['AWS_DEFAULT_REGION'] ??
      'us-east-1';
    this._fallbackRegions = options.fallbackRegions ?? [];
    this._awsProfile = options.awsProfile;
  }

  /**
   * Execute a single completion against the Bedrock Converse API.
   *
   * Supports: tool use (function calling), guardrail passthrough,
   * cross-region fallback, and AWS credential chain resolution.
   *
   * @param request - Provider-neutral request parameters. Guardrail config
   *   can be passed via `(request as BedrockTransportRequest).guardrailConfig`.
   * @param _ctx - Transport context (unused by this transport currently).
   * @returns Normalized response including content, tool calls, usage, and raw SDK object.
   */
  async complete(request: TransportRequest, _ctx?: TransportContext): Promise<NormalizedResponse> {
    const converseInput = this._buildConverseInput(request);
    const regions = [this._primaryRegion, ...this._fallbackRegions];

    let lastErr: unknown;
    for (const region of regions) {
      const client = this._getClient(region);
      try {
        const response: ConverseCommandOutput = await client.send(
          new ConverseCommand(converseInput),
        );
        return this._normalizeResponse(response, request.model);
      } catch (err) {
        lastErr = err;
        if (!isCrossRegionCandidate(err)) throw err;
        // Try next region in fallback list
      }
    }
    throw lastErr;
  }

  /**
   * Stream a completion against the Bedrock Converse Stream API.
   *
   * Yields text deltas as they arrive. Reasoning content (when present) goes
   * to `delta.reasoning`; visible text goes to `delta.text`. Tool-use content
   * blocks are dropped from streaming output (only available on the final
   * message stop event). The final delta carries `stopReason` and `usage`.
   *
   * @invariant stream tool-call yield contract — tool_use blocks are DROPPED
   *   during streaming. Callers needing full tool call arguments MUST use
   *   `complete()` for tool-call scenarios.
   *
   * @param request - Provider-neutral request parameters.
   * @param _ctx - Transport context (unused by this transport currently).
   * @returns An async iterable of normalized delta chunks.
   */
  async *stream(request: TransportRequest, _ctx: TransportContext): AsyncIterable<NormalizedDelta> {
    const streamInput = this._buildConverseStreamInput(request);
    const regions = [this._primaryRegion, ...this._fallbackRegions];

    let lastErr: unknown;
    for (const region of regions) {
      const client = this._getClient(region);
      try {
        const response: ConverseStreamCommandOutput = await client.send(
          new ConverseStreamCommand(streamInput),
        );
        if (!response.stream) return;
        yield* this._readStream(
          response.stream as unknown as AsyncIterable<Record<string, unknown>>,
        );
        return;
      } catch (err) {
        lastErr = err;
        if (!isCrossRegionCandidate(err)) throw err;
        // Try next region in fallback list
      }
    }
    throw lastErr;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Return (or lazily create) a `BedrockRuntimeClient` for the given region.
   *
   * Clients are cached per region to avoid repeated credential resolution
   * overhead on cross-region fallback retries.
   *
   * @param region - AWS region string.
   */
  private _getClient(region: string): BedrockRuntimeClient {
    let client = this._clients.get(region);
    if (!client) {
      client = new BedrockRuntimeClient({
        region,
        credentials: fromNodeProviderChain(
          this._awsProfile ? { profile: this._awsProfile } : undefined,
        ),
      });
      this._clients.set(region, client);
    }
    return client;
  }

  /**
   * Build the Bedrock `ConverseRequest` from a provider-neutral `TransportRequest`.
   */
  private _buildConverseInput(
    request: TransportRequest,
  ): ConstructorParameters<typeof ConverseCommand>[0] {
    const messages = mapMessages(request.messages);
    const systemBlocks = extractSystemBlocks(request.messages, request.system);

    const inferenceConfig: InferenceConfiguration = {
      maxTokens: request.maxTokens,
    };
    if (request.temperature != null) {
      inferenceConfig.temperature = request.temperature;
    }

    const input: ConstructorParameters<typeof ConverseCommand>[0] = {
      modelId: request.model,
      messages,
      inferenceConfig,
    };

    if (systemBlocks.length > 0) input.system = systemBlocks;

    if (request.tools && request.tools.length > 0) {
      input.toolConfig = mapToolConfig(request.tools);
    }

    // Guardrail passthrough from request extended fields or meta
    const ext = request as TransportRequest & {
      guardrailConfig?: GuardrailConfiguration;
      meta?: { guardrailConfig?: GuardrailConfiguration };
    };
    const guardrail = ext.guardrailConfig ?? ext.meta?.guardrailConfig;
    if (guardrail) input.guardrailConfig = guardrail;

    return input;
  }

  /**
   * Build the Bedrock `ConverseStreamRequest` from a provider-neutral `TransportRequest`.
   */
  private _buildConverseStreamInput(
    request: TransportRequest,
  ): ConstructorParameters<typeof ConverseStreamCommand>[0] {
    const base = this._buildConverseInput(request);
    return base as ConstructorParameters<typeof ConverseStreamCommand>[0];
  }

  /**
   * Normalize a raw `ConverseCommandOutput` into a {@link NormalizedResponse}.
   */
  private _normalizeResponse(response: ConverseCommandOutput, modelName: string): NormalizedResponse {
    const r = response as unknown as {
      output?: { message?: { content?: RawContentBlock[] } };
      stopReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number };
      $metadata?: { requestId?: string };
    };

    const blocks = r.output?.message?.content ?? [];
    const content = extractResponseText(blocks);
    const toolCalls = extractToolCalls(blocks);

    const usage: NormalizedUsage = {
      inputTokens: r.usage?.inputTokens ?? 0,
      outputTokens: r.usage?.outputTokens ?? 0,
    };
    if (r.usage?.cacheReadInputTokens) {
      usage.cachedTokens = r.usage.cacheReadInputTokens;
    }

    const id = r.$metadata?.requestId ?? `bedrock-${Date.now().toString(36)}`;

    return {
      id,
      model: modelName,
      content,
      toolCalls,
      stopReason: r.stopReason ?? 'end_turn',
      usage,
      raw: response,
    };
  }

  /**
   * Consume a Bedrock `ConverseStreamOutput` async iterable and yield
   * normalized deltas.
   *
   * @param stream - The async iterable from `ConverseStreamResponse.stream`.
   */
  private async *_readStream(
    stream: AsyncIterable<Record<string, unknown>>,
  ): AsyncIterable<NormalizedDelta> {
    let stopReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens: number | undefined;

    for await (const event of stream) {
      if (event['contentBlockDelta'] != null) {
        const deltaEvent = event['contentBlockDelta'] as { delta?: Record<string, unknown> };
        const delta = deltaEvent.delta;
        if (!delta) continue;

        if (typeof delta['text'] === 'string' && delta['text']) {
          yield { text: delta['text'] as string, reasoning: '', stopReason: null, usage: null };
          continue;
        }

        // reasoning content delta
        const rc = delta['reasoningContent'] as Record<string, unknown> | undefined;
        if (rc != null) {
          if (typeof rc['text'] === 'string' && rc['text']) {
            yield { text: '', reasoning: rc['text'] as string, stopReason: null, usage: null };
          }
          continue;
        }

        // toolUse delta — dropped per @invariant stream tool-call yield contract
      }

      if (event['messageStop'] != null) {
        const stop = event['messageStop'] as { stopReason?: string };
        stopReason = stop.stopReason ?? 'end_turn';
      }

      if (event['metadata'] != null) {
        const meta = event['metadata'] as {
          usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number };
        };
        if (meta.usage) {
          inputTokens = meta.usage.inputTokens ?? 0;
          outputTokens = meta.usage.outputTokens ?? 0;
          if (meta.usage.cacheReadInputTokens) {
            cacheReadTokens = meta.usage.cacheReadInputTokens;
          }
        }
      }
    }

    const finalUsage: NormalizedUsage = { inputTokens, outputTokens };
    if (cacheReadTokens) finalUsage.cachedTokens = cacheReadTokens;

    yield {
      text: '',
      reasoning: '',
      stopReason: stopReason ?? 'end_turn',
      usage: finalUsage,
    };
  }
}
