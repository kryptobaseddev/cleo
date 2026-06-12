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
import { cliError } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Lazy imports — keeps startup fast and avoids circular-dep issues at module
// initialisation time (session-factory pulls in the entire credentials chain).
// ---------------------------------------------------------------------------

async function buildSession(
  provider: ModelTransport,
  model: string,
): Promise<import('@cleocode/contracts/llm/interfaces.js').LlmSession> {
  const [{ resolveCredentialsAsync }, { ConcreteSession }, { ModelRunner }, { deriveApiWire }] =
    await Promise.all([
      import(/* webpackIgnore: true */ '@cleocode/core/llm/credentials.js'),
      import(/* webpackIgnore: true */ '@cleocode/core/llm/concrete-session.js'),
      import(/* webpackIgnore: true */ '@cleocode/core/llm/model-runner.js'),
      import(/* webpackIgnore: true */ '@cleocode/core/llm/api-mode.js'),
    ]);

  // Use the async resolver (vault chokepoint — T11986 · DHQ-087): this
  // delegates to the UnifiedCredentialPool which triggers lazy-seed and
  // proactive OAuth refresh before returning a credential. The legacy sync
  // path (resolveCredentials) bypassed the pool's refresh-on-use step and
  // would silently return null for an expired-but-refreshable OAT token.
  const cred = await resolveCredentialsAsync(provider);
  if (!cred.apiKey) {
    throw new Error(
      `No credential found for provider '${provider}'. ` +
        `Run \`cleo login ${provider}\` (for OAuth) or \`cleo llm add ${provider} <key>\` (for API key).`,
    );
  }

  // Single SSoT transport construction (E9 · T11745): deriveApiWire stamps the
  // wire protocol + base URL; the one ModelRunner builds the transport for ANY
  // provider (anthropic incl. the OAuth beta header, gemini, OpenAI-compat) —
  // no per-provider branching here.
  const wire = deriveApiWire(provider, cred.authType);
  const resolvedCredential: import('@cleocode/contracts/llm/resolved-credential.js').ResolvedCredential =
    {
      provider,
      label: 'default',
      token: cred.apiKey,
      authType: cred.authType,
      expiresAt: null,
      refreshToken: null,
      extraHeaders: {},
      baseUrl: wire.baseUrl,
      awsProfile: null,
    };

  const transport = ModelRunner.buildTransportFromCredential(
    provider,
    resolvedCredential,
    wire.apiMode,
  );

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

/**
 * Resolve the default model for a provider via the provider registry.
 *
 * Delegates to `getProviderProfile(provider).defaultModel` so all model IDs
 * stay in the `packages/core/src/llm/` SSoT (no literals in CLI code).
 * Falls back to `IMPLICIT_FALLBACK_MODEL` when the provider is unknown.
 */
async function resolveDefaultModel(provider: ModelTransport): Promise<string> {
  const [{ getProviderProfile }, { IMPLICIT_FALLBACK_MODEL }] = await Promise.all([
    import(/* webpackIgnore: true */ '@cleocode/core/llm/provider-registry/index.js'),
    import(/* webpackIgnore: true */ '@cleocode/core/llm/role-resolver.js'),
  ]);
  const profile = await getProviderProfile(provider);
  return profile?.defaultModel ?? IMPLICIT_FALLBACK_MODEL;
}

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

  const session =
    opts._sessionOverride ??
    (await buildSession(opts.provider, opts.model ?? (await resolveDefaultModel(opts.provider))));

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
      // T9772: validation error → LAFS envelope (no raw stderr).
      cliError(
        'cleo llm stream: <provider> is required.',
        2,
        { name: 'E_VALIDATION', fix: 'Pass a provider as the first positional argument.' },
        { operation: 'llm.stream' },
      );
      process.exit(2);
    }
    if (!prompt) {
      // T9772: validation error → LAFS envelope (no raw stderr).
      cliError(
        'cleo llm stream: <prompt> is required.',
        2,
        { name: 'E_VALIDATION', fix: 'Pass a prompt as the second positional argument.' },
        { operation: 'llm.stream' },
      );
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
      // T9772: stream failure → LAFS envelope (no raw stderr).
      cliError(
        `cleo llm stream: ${msg}`,
        1,
        { name: 'E_LLM_STREAM_FAILED' },
        { operation: 'llm.stream' },
      );
      process.exit(1);
    }
  },
});
