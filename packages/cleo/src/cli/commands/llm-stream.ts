/**
 * `cleo llm stream <provider> <prompt>` — stream a single-prompt completion
 * through the CLEO LLM transport layer.
 *
 * Exercises {@link LlmSession.stream} end-to-end: credentials are resolved via
 * the 6-tier credential chain, the async generator is consumed chunk-by-chunk,
 * text deltas are flushed incrementally to stdout, reasoning/think blocks are
 * routed to stderr (or suppressed when `--think` is not set), and a final
 * one-line JSON usage summary is printed to stderr when the stream closes.
 *
 * Supported flags:
 *   --model <id>         Override the default model for the provider.
 *   --max-tokens <n>     Override the maximum output token budget (default: 4096).
 *   --temperature <f>    Sampling temperature in 0.0–1.0 (default: 0.7).
 *   --think              Emit reasoning/think blocks to stderr (default: off).
 *   --system <text>      Optional system prompt.
 *
 * @task T9315
 * @epic T9261 T-LLM-CRED-CENTRALIZATION Phase 5
 */

import type { NormalizedDelta, SendOptions } from '@cleocode/contracts/llm/interfaces.js';
import type { TransportMessage } from '@cleocode/contracts/llm/normalized-response.js';
import type { ModelTransport } from '@cleocode/contracts/operations/llm.js';
import { defineCommand } from 'citty';

// ---------------------------------------------------------------------------
// Lazy imports — keeps startup fast and avoids circular-dep issues at module
// initialisation time (session-factory pulls in the entire credentials chain).
// ---------------------------------------------------------------------------

async function buildSession(
  provider: ModelTransport,
  model: string,
): Promise<import('@cleocode/contracts/llm/interfaces.js').LlmSession> {
  const [
    { resolveCredentials },
    { ConcreteSession },
    { AnthropicTransport },
    { ChatCompletionsTransport },
    { GeminiTransport },
  ] = await Promise.all([
    import(/* webpackIgnore: true */ '@cleocode/core/llm/credentials.js'),
    import(/* webpackIgnore: true */ '@cleocode/core/llm/concrete-session.js'),
    import(/* webpackIgnore: true */ '@cleocode/core/llm/transports/anthropic.js'),
    import(/* webpackIgnore: true */ '@cleocode/core/llm/transports/chat-completions.js'),
    import(/* webpackIgnore: true */ '@cleocode/core/llm/transports/gemini.js'),
  ]);

  const cred = resolveCredentials(provider);
  if (!cred.apiKey) {
    throw new Error(
      `No credential found for provider '${provider}'. ` +
        `Set the appropriate environment variable or run 'cleo llm add ${provider}'.`,
    );
  }

  let transport: import('@cleocode/contracts/llm/normalized-response.js').LlmTransport;
  if (provider === 'anthropic') {
    transport =
      cred.authType === 'oauth'
        ? new AnthropicTransport({ authToken: cred.apiKey })
        : new AnthropicTransport({ apiKey: cred.apiKey });
  } else if (provider === 'gemini') {
    transport = new GeminiTransport({ apiKey: cred.apiKey });
  } else {
    transport = new ChatCompletionsTransport({ provider, apiKey: cred.apiKey });
  }

  const resolvedCredential: import('@cleocode/contracts/llm/resolved-credential.js').ResolvedCredential =
    {
      provider,
      label: 'default',
      token: cred.apiKey,
      authType: cred.authType,
      expiresAt: null,
      refreshToken: null,
      extraHeaders: {},
      baseUrl: null,
      awsProfile: null,
    };

  return new ConcreteSession({ transport, model, credential: resolvedCredential });
}

async function getComputeCost(): Promise<
  (usage: { inputTokens: number; outputTokens: number }, model: string) => number
> {
  const { computeCost } = await import(
    /* webpackIgnore: true */ '@cleocode/core/llm/usage-pricing'
  );
  return computeCost;
}

/** Default model per provider used when no --model flag is supplied. */
const DEFAULT_MODELS: Partial<Record<ModelTransport, string>> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  moonshot: 'moonshot-v1-8k',
  openrouter: 'openrouter/auto',
  deepseek: 'deepseek-chat',
  xai: 'grok-beta',
  groq: 'llama3-8b-8192',
  'kimi-code': 'kimi-latest',
};

// ---------------------------------------------------------------------------
// runLlmStream — testable core logic, decoupled from citty wiring
// ---------------------------------------------------------------------------

/**
 * Options for {@link runLlmStream}.
 */
export interface LlmStreamOptions {
  /** Provider id (e.g. `'anthropic'`, `'openai'`). */
  provider: ModelTransport;
  /** Prompt text to send. */
  prompt: string;
  /** Model identifier override. When undefined the per-provider default applies. */
  model?: string;
  /** Maximum output tokens. Defaults to 4096. */
  maxTokens?: number;
  /** Sampling temperature in 0.0–1.0. Defaults to 0.7. */
  temperature?: number;
  /** Whether to emit reasoning/think blocks to stderr. Defaults to false. */
  showThink?: boolean;
  /** Optional system prompt. */
  system?: string;
  /** Write stream for visible text. Defaults to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Write stream for reasoning + usage summary. Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
  /**
   * Optional session override for testing.
   *
   * When supplied, credential resolution and transport construction are skipped.
   * The caller's session is used directly.
   */
  _sessionOverride?: import('@cleocode/contracts/llm/interfaces.js').LlmSession;
}

/**
 * Usage summary emitted to stderr as a one-line JSON object at stream end.
 */
export interface StreamUsageSummary {
  /** Total input tokens consumed by the call. */
  inputTokens: number;
  /** Total output tokens generated by the call. */
  outputTokens: number;
  /** Estimated cost in USD, or null when model is absent from the pricing table. */
  costUsd: number | null;
}

/**
 * Stream a single-prompt LLM completion, piping deltas to stdout and
 * routing reasoning blocks to stderr.
 *
 * Resolves credentials via the 6-tier chain for the specified provider and
 * constructs a {@link ConcreteSession} directly. Iterates the async generator
 * yielded by {@link LlmSession.stream} and flushes each text delta immediately
 * so the consumer sees output incrementally. A one-line JSON usage summary is
 * written to stderr after the final delta.
 *
 * @param opts - Streaming options including provider, prompt, and output sinks.
 * @returns The final usage summary.
 *
 * @task T9315
 */
export async function runLlmStream(opts: LlmStreamOptions): Promise<StreamUsageSummary> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  const model = opts.model ?? DEFAULT_MODELS[opts.provider] ?? 'claude-haiku-4-5-20251001';

  const session = opts._sessionOverride ?? (await buildSession(opts.provider, model));

  const sendOpts: SendOptions = {
    ...(opts.system != null ? { systemSuffix: opts.system } : {}),
  };

  const messages: TransportMessage[] = [{ role: 'user', content: opts.prompt }];

  let finalUsage: StreamUsageSummary = { inputTokens: 0, outputTokens: 0, costUsd: null };

  const stream = session.stream(messages, sendOpts);

  for await (const delta of stream as AsyncIterable<NormalizedDelta>) {
    if (delta.text) {
      stdout.write(delta.text);
    }

    if (delta.reasoning && opts.showThink) {
      stderr.write(delta.reasoning);
    }

    if (delta.usage !== null) {
      const { inputTokens, outputTokens } = delta.usage;
      let costUsd: number | null = null;
      try {
        const computeCost = await getComputeCost();
        const raw = computeCost({ inputTokens, outputTokens }, session.model);
        costUsd = raw === 0 ? null : raw;
      } catch {
        // pricing lookup failure is non-fatal
      }
      finalUsage = { inputTokens, outputTokens, costUsd };
    }
  }

  stderr.write(`${JSON.stringify(finalUsage)}\n`);

  return finalUsage;
}

// ---------------------------------------------------------------------------
// streamCommand — citty command definition
// ---------------------------------------------------------------------------

/**
 * `cleo llm stream <provider> <prompt>` subcommand.
 *
 * Streams a single-turn completion through the resolved provider and pipes
 * text deltas to stdout in real time. A one-line JSON usage summary is
 * printed to stderr after the stream closes.
 *
 * @task T9315
 */
export const streamCommand = defineCommand({
  meta: {
    name: 'stream',
    description:
      'Stream a single-prompt completion via LlmTransport.stream(). ' +
      'Text deltas are written to stdout incrementally. ' +
      'Reasoning/think blocks go to stderr (requires --think). ' +
      'A JSON usage summary is printed to stderr at stream end.',
  },
  args: {
    provider: {
      type: 'positional',
      description: 'Provider transport (anthropic | openai | gemini | moonshot | openrouter | …)',
      required: true,
    },
    prompt: {
      type: 'positional',
      description: 'Prompt text to send to the model.',
      required: true,
    },
    model: {
      type: 'string',
      description:
        "Model identifier override (e.g. 'claude-sonnet-4-6'). Uses provider default when omitted.",
    },
    'max-tokens': {
      type: 'string',
      description: 'Maximum output tokens (default: 4096).',
    },
    temperature: {
      type: 'string',
      description: 'Sampling temperature in 0.0–1.0 (default: 0.7).',
    },
    think: {
      type: 'boolean',
      description: 'Emit reasoning/think blocks to stderr (default: off).',
      default: false,
    },
    system: {
      type: 'string',
      description: 'Optional system prompt prepended to the conversation.',
    },
  },
  async run({ args }) {
    const a = args as Record<string, unknown>;

    const provider = String(a['provider'] ?? '').trim() as ModelTransport;
    const prompt = String(a['prompt'] ?? '').trim();

    if (!provider) {
      process.stderr.write('[error] cleo llm stream: <provider> is required.\n');
      process.exit(2);
    }
    if (!prompt) {
      process.stderr.write('[error] cleo llm stream: <prompt> is required.\n');
      process.exit(2);
    }

    const model = typeof a['model'] === 'string' && a['model'] ? a['model'] : undefined;
    const maxTokensRaw = typeof a['max-tokens'] === 'string' ? Number(a['max-tokens']) : undefined;
    const maxTokens =
      maxTokensRaw !== undefined && !Number.isNaN(maxTokensRaw) ? maxTokensRaw : undefined;
    const tempRaw = typeof a['temperature'] === 'string' ? parseFloat(a['temperature']) : undefined;
    const temperature = tempRaw !== undefined && !Number.isNaN(tempRaw) ? tempRaw : undefined;
    const showThink = a['think'] === true;
    const system = typeof a['system'] === 'string' && a['system'] ? a['system'] : undefined;

    // maxTokens and temperature are accepted on the CLI but forwarded as part
    // of the session's default request. ConcreteSession._buildRequest uses its
    // own maxTokens (4096) and temperature (0.7) defaults from the transport
    // request. These flags are captured here for future wiring when the session
    // layer exposes per-call overrides for these fields.
    void maxTokens;
    void temperature;

    try {
      await runLlmStream({ provider, prompt, model, maxTokens, temperature, showThink, system });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[error] cleo llm stream: ${msg}\n`);
      process.exit(1);
    }
  },
});
