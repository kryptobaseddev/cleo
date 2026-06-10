/**
 * Builtin {@link ProviderDef} set — the SEED SOURCE for the `providers` table.
 *
 * M3 Provider SSoT (epic T11667 · task T11703). The DECLARATIVE provider definitions
 * are DERIVED from the existing runtime {@link ProviderProfile} builtins (the in-process
 * registry SSoT) rather than re-declared — so the two never drift and there is one
 * place to add a provider (the profile). `toProviderDef` projects a `ProviderProfile`
 * (which bundles non-serializable hook closures) down to the serializable `ProviderDef`
 * shape (DATA only): identity + aliases + auth + endpoint(s) + catalog key + headers +
 * env vars + OAuth placeholder + the declarative request quirks.
 *
 * ## Why this lives under `provider-registry/`
 *
 * The builtin profiles are model-data SSoT (the LLM-chokepoint lint exempts this
 * directory for model-id literals). This module reads their declarative DATA and
 * never constructs a transport/client — it carries no model-id literals of its own.
 *
 * @module llm/provider-registry/provider-defs
 * @task T11703
 * @epic T11667
 * @see @cleocode/contracts — {@link ProviderDef} (the declarative contract, T11702)
 * @see ./index.ts — the in-process {@link ProviderProfile} registry (runtime SSoT)
 * @see ./provider-seed.ts — the seeder that upserts these rows into `providers`
 */

import type {
  ProviderDef,
  ProviderEndpoint,
  ProviderProfile,
  ProviderTransport,
  RequestQuirk,
  RequestQuirkKind,
} from '@cleocode/contracts';
import { anthropicProfile } from './builtin/anthropic.js';
import { bedrockProfile } from './builtin/bedrock.js';
import { geminiProfile } from './builtin/gemini.js';
import { kimiCodeProfile } from './builtin/kimi-code.js';
import { moonshotProfile } from './builtin/moonshot.js';
import { ollamaProfile } from './builtin/ollama.js';
import { openaiProfile } from './builtin/openai.js';
import { openrouterProfile } from './builtin/openrouter.js';
import { xaiProfile } from './builtin/xai.js';

/**
 * Declarative per-builtin overlay applied during projection — the bits of a
 * {@link ProviderDef} that are NOT directly carried on a {@link ProviderProfile}:
 * the wire {@link ProviderTransport}, the models.dev catalog key (when it differs
 * from the provider id), any extra (alternate) endpoints, and the declarative
 * {@link RequestQuirk} kinds standing in for the profile's hook closures.
 *
 * Keyed by the profile's canonical `name`. A provider absent from this table
 * projects with the default `openai-completions` transport, `modelsDevId = id`,
 * no alt endpoints, and no quirks.
 *
 * @task T11703
 */
interface ProviderDefOverlay {
  /** Primary wire transport (the declarative analog of the provider's ApiMode). */
  readonly transport: ProviderTransport;
  /** AI-SDK provider-factory key — required iff `transport === 'aisdk'`. */
  readonly aiSdkProvider?: string;
  /** models.dev catalog key when it differs from the provider id (else id). */
  readonly modelsDevId?: string;
  /**
   * Additional wire transports this provider also speaks — collapses the prior
   * per-ApiMode profile duplication into one row (AC4 — xAI completions + responses).
   * Each entry reuses the primary `baseUrl` unless an explicit baseUrl is given.
   */
  readonly altTransports?: ReadonlyArray<{
    readonly transport: ProviderTransport;
    readonly aiSdkProvider?: string;
    readonly baseUrl?: string;
  }>;
  /** Declarative request-quirk kinds standing in for the profile's hook closures. */
  readonly quirks?: ReadonlyArray<RequestQuirkKind>;
}

/**
 * Per-builtin projection overlay (the non-`ProviderProfile` declarative DATA).
 *
 * Transport mapping mirrors `deriveApiMode` (api-mode.ts):
 *  - `anthropic` / `kimi-code` → `anthropic-messages` (kimi speaks Anthropic wire)
 *  - `openai` → `openai-completions` primary + `openai-responses` alt (Codex OAuth)
 *  - `gemini` / `bedrock` / `ollama` → `aisdk` (reached via AI-SDK provider factory)
 *  - `xai` → `openai-completions` primary + `openai-responses` alt (collapses the
 *    prior `xaiProfile` / `xaiResponsesProfile` duplication into ONE row — AC4)
 *  - `openrouter` / `moonshot` → `openai-completions`
 *
 * @task T11703
 */
const OVERLAYS: Readonly<Record<string, ProviderDefOverlay>> = {
  anthropic: { transport: 'anthropic-messages' },
  openai: {
    transport: 'openai-completions',
    altTransports: [{ transport: 'openai-responses' }],
  },
  gemini: { transport: 'aisdk', aiSdkProvider: 'google' },
  moonshot: { transport: 'openai-completions' },
  'kimi-code': {
    transport: 'anthropic-messages',
    modelsDevId: 'moonshot',
    quirks: ['kimi-reasoning-effort'],
  },
  openrouter: { transport: 'openai-completions', quirks: ['openrouter-pareto'] },
  bedrock: { transport: 'aisdk', aiSdkProvider: 'bedrock' },
  xai: {
    transport: 'openai-completions',
    altTransports: [{ transport: 'openai-responses' }],
    quirks: ['grok-conv-id'],
  },
  ollama: { transport: 'aisdk', aiSdkProvider: 'openai-compatible' },
};

/**
 * Build a {@link ProviderEndpoint} from a transport + base URL (+ AI-SDK key).
 *
 * @internal
 */
function makeEndpoint(
  transport: ProviderTransport,
  baseUrl: string,
  aiSdkProvider?: string,
): ProviderEndpoint {
  if (transport === 'aisdk') {
    // The aisdk variant REQUIRES an aiSdkProvider; default to the OpenAI-compatible
    // factory when an overlay omits it (the generic compat path).
    return { transport: 'aisdk', baseUrl, aiSdkProvider: aiSdkProvider ?? 'openai-compatible' };
  }
  return { transport, baseUrl };
}

/**
 * Project a runtime {@link ProviderProfile} down to the serializable
 * {@link ProviderDef} (DATA only — drops the hook closures, keeps their declarative
 * {@link RequestQuirk} kinds). Pure + deterministic.
 *
 * @param profile - The runtime profile (in-process registry SSoT).
 * @returns The declarative provider definition.
 * @task T11703
 */
export function toProviderDef(profile: ProviderProfile): ProviderDef {
  const overlay = OVERLAYS[profile.name.toLowerCase()];
  const transport: ProviderTransport = overlay?.transport ?? 'openai-completions';
  const endpoint = makeEndpoint(transport, profile.baseUrl, overlay?.aiSdkProvider);

  const altEndpoints: ProviderEndpoint[] = (overlay?.altTransports ?? []).map((alt) =>
    makeEndpoint(alt.transport, alt.baseUrl ?? profile.baseUrl, alt.aiSdkProvider),
  );

  const requestQuirks: RequestQuirk[] = (overlay?.quirks ?? []).map((kind) => ({ kind }));

  const def: ProviderDef = {
    id: profile.name,
    displayName: profile.displayName,
    aliases: [...(profile.aliases ?? [])],
    authMethods: [...profile.authTypes],
    endpoint,
    ...(altEndpoints.length > 0 ? { altEndpoints } : {}),
    modelsDevId: overlay?.modelsDevId ?? profile.name,
    ...(profile.defaultHeaders !== undefined
      ? { defaultHeaders: { ...profile.defaultHeaders } }
      : {}),
    ...(profile.envVars !== undefined ? { envVars: [...profile.envVars] } : {}),
    ...(profile.oauth !== undefined ? { oauth: profile.oauth } : {}),
    ...(requestQuirks.length > 0 ? { requestQuirks } : {}),
  };
  return def;
}

/**
 * Runtime profiles that seed the builtin {@link ProviderDef} set.
 *
 * The `xai` Responses profile (`xaiResponsesProfile`) is intentionally OMITTED — its
 * Responses endpoint is folded into the single `xai` row's `altEndpoints` (AC4). The
 * dual-ApiMode duplication collapses to one declarative row per provider id.
 *
 * @task T11703
 */
const SEED_PROFILES: ReadonlyArray<ProviderProfile> = [
  anthropicProfile,
  openaiProfile,
  geminiProfile,
  moonshotProfile,
  kimiCodeProfile,
  openrouterProfile,
  bedrockProfile,
  xaiProfile,
  ollamaProfile,
];

/**
 * The builtin {@link ProviderDef} set — DERIVED from the runtime
 * {@link ProviderProfile} builtins. The SSoT-seed source for the `providers`
 * table (T11703) and the input to the pure alias resolver (T11704).
 *
 * @returns Builtin provider definitions (one per provider id; xai collapsed to one).
 * @task T11703
 */
export function builtinProviderDefs(): ReadonlyArray<ProviderDef> {
  return SEED_PROFILES.map(toProviderDef);
}
