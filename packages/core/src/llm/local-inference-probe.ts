/**
 * Runtime detection of a reachable local inference server (T12082).
 *
 * ## Why CLEO should find this by itself
 *
 * The auxiliary fallback chain exists so that "context compression, brain dream
 * cycles, hygiene scans" do not fail silently when the primary provider is
 * unavailable. Its default chain is `anthropic → openrouter → groq` — all
 * cloud. When every cloud credential is unusable, the chain is exhausted and
 * the capability simply stops.
 *
 * That is exactly the state this machine was in on 2026-08-06: the anthropic
 * credential was consent-gated, the openai one returned 401 — and an Ollama
 * server was running the whole time with `qwen2.5-coder:3b` loaded. The dream
 * cycle reported "no usable LLM client" while free local inference sat one
 * HTTP request away. Nothing was broken except that nobody looked.
 *
 * A background consolidation pass is precisely the workload that should degrade
 * to a small local model rather than stop: it is not latency-critical, it is
 * not user-facing, and a shallow synthesis is worth more than none. So the
 * chain now ends with a local tier that is included ONLY when a server actually
 * answers.
 *
 * ## Why a probe rather than a config flag
 *
 * A config flag would need the operator to know their own machine's state and
 * keep it current. A 300 ms probe against loopback is cheap, is cached for the
 * process, and is correct by construction — it reports what is true now.
 *
 * @task T12082
 */

/** Loopback endpoints checked, in order. Ollama first — it is the common case. */
const LOCAL_ENDPOINTS: readonly LocalEndpoint[] = [
  {
    name: 'ollama',
    tagsUrl: 'http://127.0.0.1:11434/api/tags',
    baseUrl: 'http://127.0.0.1:11434',
    openAiBaseUrl: 'http://127.0.0.1:11434/v1',
  },
  {
    name: 'lm-studio',
    tagsUrl: 'http://127.0.0.1:1234/v1/models',
    baseUrl: 'http://127.0.0.1:1234',
    openAiBaseUrl: 'http://127.0.0.1:1234/v1',
  },
];

/** A candidate local inference endpoint. */
interface LocalEndpoint {
  /** Short identifier used in diagnostics. */
  readonly name: string;
  /** URL that lists available models — used as the liveness probe. */
  readonly tagsUrl: string;
  /** Server ROOT url — what a NATIVE transport (e.g. `ollama_native`) wants. */
  readonly baseUrl: string;
  /** OpenAI-compatible base URL — what a `chat_completions` transport wants. */
  readonly openAiBaseUrl: string;
}

/** A detected, reachable local inference server. */
export interface LocalInference {
  /** Which server answered (`ollama`, `lm-studio`). */
  readonly name: string;
  /**
   * Server ROOT url, e.g. `http://127.0.0.1:11434`.
   *
   * The two forms are NOT interchangeable and mixing them fails late: the
   * native Ollama transport appends `/api/chat`, so handing it the `/v1`
   * form produces `/v1/api/chat` and a 404 that reads like the daemon is
   * broken. Use {@link LocalInference.openAiBaseUrl} for OpenAI-compatible
   * transports and this for native ones.
   */
  readonly baseUrl: string;
  /** OpenAI-compatible base URL, e.g. `http://127.0.0.1:11434/v1`. */
  readonly openAiBaseUrl: string;
  /** Model ids the server reports, in the order it reported them. */
  readonly models: readonly string[];
}

/** Probe timeout. Loopback either answers immediately or is not there. */
const PROBE_TIMEOUT_MS = 300;

/** Process-lifetime cache — `undefined` = not yet probed, `null` = none found. */
let cached: LocalInference | null | undefined;

/**
 * Extract model ids from either an Ollama `/api/tags` or an OpenAI `/v1/models`
 * payload, whichever shape came back.
 *
 * @param body - parsed JSON response.
 * @returns model ids, possibly empty.
 */
function extractModels(body: unknown): string[] {
  if (body === null || typeof body !== 'object') return [];
  const rec = body as { models?: unknown; data?: unknown };

  // Ollama: { models: [{ name, model, … }] }
  if (Array.isArray(rec.models)) {
    return rec.models
      .map((m) =>
        m !== null && typeof m === 'object'
          ? ((m as { name?: unknown }).name ?? (m as { model?: unknown }).model)
          : undefined,
      )
      .filter((n): n is string => typeof n === 'string');
  }
  // OpenAI-compatible: { data: [{ id }] }
  if (Array.isArray(rec.data)) {
    return rec.data
      .map((m) => (m !== null && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
      .filter((n): n is string => typeof n === 'string');
  }
  return [];
}

/**
 * Detect a reachable local inference server with at least one model loaded.
 *
 * Cached for the process lifetime: a background tick may consult this many
 * times and the answer does not change mid-run in practice.
 *
 * Never throws — a probe failure means "not available", which is a normal
 * result rather than an error.
 *
 * @param opts - `force` re-probes, ignoring the cache (tests).
 * @returns the detected server, or `null` when none answers.
 *
 * @example
 * ```ts
 * const local = await detectLocalInference();
 * if (local) console.log(`${local.name} has ${local.models.length} model(s)`);
 * ```
 *
 * @task T12082
 */
export async function detectLocalInference(
  opts: { force?: boolean } = {},
): Promise<LocalInference | null> {
  // Operator opt-out. Two audiences: someone on a shared or metered box who
  // does not want background work routed to a daemon they run for other
  // purposes, and the test suite — which must produce the same result whether
  // or not the developer happens to have Ollama running.
  if (process.env['CLEO_DISABLE_LOCAL_INFERENCE']?.trim()) return null;

  if (!opts.force && cached !== undefined) return cached;

  for (const endpoint of LOCAL_ENDPOINTS) {
    try {
      const response = await fetch(endpoint.tagsUrl, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const models = extractModels(await response.json());
      // A server with no models loaded cannot serve a completion, so it is not
      // a usable fallback — treat it as absent rather than advertising it.
      if (models.length === 0) continue;
      cached = {
        name: endpoint.name,
        baseUrl: endpoint.baseUrl,
        openAiBaseUrl: endpoint.openAiBaseUrl,
        models,
      };
      return cached;
    } catch {
      // Unreachable / timed out / non-JSON — try the next endpoint.
    }
  }

  cached = null;
  return cached;
}

/**
 * List the models an Ollama daemon actually has pulled.
 *
 * The cross-provider selector picks an Ollama model from a RAM heuristic
 * alone, which answers "what could this machine run", not "what is installed".
 * Those differ constantly — this machine has 62 GB of RAM and therefore scored
 * into the `gemma4:e4b` tier while holding only `qwen2.5-coder:3b` and
 * `qwen2:0.5b`, so the resolved model would have 404'd at the daemon. The fit
 * heuristic is still right; it just has to be intersected with reality.
 *
 * Not cached — the installed set changes whenever the operator pulls a model,
 * and the call is one loopback request.
 *
 * Never throws.
 *
 * @param baseUrl - Ollama root URL, e.g. `http://localhost:11434` (no `/v1`).
 * @returns installed model ids in daemon order, empty when unreachable.
 *
 * @task T12082
 */
export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/api/tags`;
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return [];
    return extractModels(await response.json());
  } catch {
    return [];
  }
}

/**
 * Clear the probe cache. Tests only.
 *
 * @task T12082
 */
export function _resetLocalInferenceCacheForTests(): void {
  cached = undefined;
}
