/**
 * Shared plumbing for System One call sites: the `off | shadow | on` mode,
 * the generative-fallback opt-in, and redact-then-clip for state text.
 *
 * Every site resolves its settings the same way, so the rule that an
 * unconfigured provider means `off` (and therefore zero network) lives here
 * once. Heavy modules (credentials, config registry) load lazily: importing
 * this file costs nothing on a path that never asks a decision.
 *
 * @task T12493
 * @epic T12486
 */

import type { DecideOptions } from './client.js';

/**
 * How a call site uses System One.
 *
 * - `off` — never ask; the heuristic acts.
 * - `shadow` — ask, audit both answers, act on the heuristic.
 * - `on` — ask and act on the decision when it is confident enough.
 */
export type DecisionSiteMode = 'off' | 'shadow' | 'on';

/** Resolved settings for one call-site invocation. */
export interface DecisionSiteSettings {
  /** Effective mode; always `off` when no provider is configured. */
  readonly mode: DecisionSiteMode;
  /** Whether the site's older generative-LLM path runs. */
  readonly llmTier: boolean;
}

/** Inputs to {@link resolveDecisionSiteSettings}. */
export interface ResolveDecisionSiteSettingsInput {
  /** Config key holding the site mode, e.g. `decide.sites.duplicateDetection`. */
  readonly modeKey: string;
  /** Config key holding the generative opt-in, e.g. `decide.generativeFallback.duplicateDetection`. */
  readonly llmTierKey: string;
  /** Explicit mode; wins over config when a provider is configured. */
  readonly mode?: DecisionSiteMode;
  /** Explicit generative opt-in; wins over config. */
  readonly llmTier?: boolean;
  /**
   * Generative default when the config key is absent and System One is NOT
   * configured. Sites whose generative path ran unconditionally before System
   * One set this to keep that behaviour; the default is `false`.
   */
  readonly llmTierWhenUnconfigured?: boolean;
  /** The `decide()` wiring the site will use; an explicit provider or connection decides "configured". */
  readonly wiring?: DecideOptions;
  /** Project root for config lookup. Default: the resolved CLEO project root. */
  readonly projectRoot?: string;
}

/**
 * Type guard for {@link DecisionSiteMode}.
 *
 * @param value - Any config value.
 * @returns Whether `value` is `off`, `shadow` or `on`.
 */
export function isDecisionSiteMode(value: unknown): value is DecisionSiteMode {
  return value === 'off' || value === 'shadow' || value === 'on';
}

/**
 * Redact secrets, THEN clip to `max` characters, marking the cut.
 *
 * The order matters: clipping first can cut a secret in half, and a partial
 * secret no longer matches the redaction patterns — `decide()`'s own redaction
 * would then let the prefix through.
 *
 * @param text - Raw text.
 * @param max - Maximum length of the result, in UTF-16 characters.
 * @param redact - The redaction function (the memory redaction patterns).
 * @returns Redacted text of at most `max` characters.
 */
export function redactThenClip(text: string, max: number, redact: (s: string) => string): string {
  const safe = redact(text);
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}…`;
}

/**
 * Resolve a site's mode and generative opt-in.
 *
 * Unconfigured (no explicit provider/connection and nothing stored by
 * `cleo decide config`) always resolves to `off`, whatever the config says,
 * so an unconfigured site never opens a socket. Never throws: unreadable
 * credentials or config fall back to the defaults.
 *
 * @param input - Config keys, explicit overrides and wiring.
 * @returns The effective settings.
 */
export async function resolveDecisionSiteSettings(
  input: ResolveDecisionSiteSettingsInput,
): Promise<DecisionSiteSettings> {
  const wiring = input.wiring ?? {};
  let configured: boolean;
  if (wiring.provider) {
    configured = true;
  } else if (wiring.connection !== undefined) {
    configured = wiring.connection !== null && wiring.connection.apiKey.trim() !== '';
  } else {
    try {
      const { loadDecideConnection } = await import('./credentials.js');
      configured = loadDecideConnection() !== null;
    } catch {
      configured = false;
    }
  }

  const needConfig = (configured && input.mode === undefined) || input.llmTier === undefined;
  let configMode: unknown;
  let configLlmTier: unknown;
  if (needConfig) {
    try {
      const { getConfigValue } = await import('../config/registry.js');
      const { getProjectRoot } = await import('../paths.js');
      const projectRoot = input.projectRoot ?? getProjectRoot();
      [configMode, configLlmTier] = await Promise.all([
        getConfigValue(input.modeKey, { projectRoot }),
        getConfigValue(input.llmTierKey, { projectRoot }),
      ]);
    } catch {
      // Unreadable config → defaults.
    }
  }

  const mode: DecisionSiteMode = !configured
    ? 'off'
    : (input.mode ?? (isDecisionSiteMode(configMode) ? configMode : 'shadow'));
  const llmTierDefault = !configured && input.llmTierWhenUnconfigured === true;
  const llmTier =
    input.llmTier ?? (typeof configLlmTier === 'boolean' ? configLlmTier : llmTierDefault);
  return { mode, llmTier };
}
