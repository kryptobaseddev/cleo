/**
 * Decision-provider presets — what each {@link DecisionProviderKind} needs
 * from the user and what it defaults.
 *
 * - `layahost` (recommended): a fixed base URL ({@link LAYAHOST_BASE_URL});
 *   the user brings only an API key. Model defaults to
 *   {@link LAYAHOST_DEFAULT_MODEL}.
 * - `jev`: Jev's own API ({@link JEV_DEFAULT_BASE_URL}) by default, or any
 *   Jev-compatible endpoint as an override URL; the model comes from the
 *   provider's `GET /v1/models` listing.
 *
 * A profile that keeps the preset URL stores the literal `default`
 * (T12733), resolved here at call time.
 *
 * The URL and model literals live in `@cleocode/contracts` (const data); this
 * module only arranges them.
 *
 * @task T12713
 * @task T12733
 * @epic T12486
 */

import type { DecisionProviderKind } from '@cleocode/contracts';
import {
  DECISION_PROVIDER_KINDS,
  JEV_DEFAULT_BASE_URL,
  LAYAHOST_BASE_URL,
  LAYAHOST_DEFAULT_MODEL,
} from '@cleocode/contracts/decide.js';

/** What a provider kind requires and defaults. */
export interface DecisionProviderPreset {
  /** The provider kind. */
  readonly kind: DecisionProviderKind;
  /** Menu label shown by the setup wizard. */
  readonly label: string;
  /** One-line description for help text and the wizard. */
  readonly description: string;
  /** Base URL used when none is given; absent → the user must supply one. */
  readonly defaultBaseUrl?: string;
  /** Model used when none is given and none is stored; absent → the provider listing decides. */
  readonly defaultModel?: string;
  /** Whether the user must supply the base URL. */
  readonly requiresUrl: boolean;
  /** Whether this is the recommended choice (listed first in the wizard). */
  readonly recommended: boolean;
}

/** The preset table, keyed by provider kind. */
export const DECISION_PROVIDER_PRESETS: Readonly<
  Record<DecisionProviderKind, DecisionProviderPreset>
> = {
  layahost: {
    kind: 'layahost',
    label: 'layahost (recommended): bring only an API key',
    description: `Hosted System One at ${LAYAHOST_BASE_URL}; default model ${LAYAHOST_DEFAULT_MODEL}.`,
    defaultBaseUrl: LAYAHOST_BASE_URL,
    defaultModel: LAYAHOST_DEFAULT_MODEL,
    requiresUrl: false,
    recommended: true,
  },
  jev: {
    kind: 'jev',
    label: 'jev: Jev API or any Jev-compatible URL',
    description: `Jev at ${JEV_DEFAULT_BASE_URL} by default, or any Jev-compatible URL; the model comes from /v1/models.`,
    defaultBaseUrl: JEV_DEFAULT_BASE_URL,
    requiresUrl: false,
    recommended: false,
  },
};

/**
 * Every preset, recommended first (the order of {@link DECISION_PROVIDER_KINDS}).
 *
 * @returns The presets in menu order.
 */
export function listDecisionProviderPresets(): readonly DecisionProviderPreset[] {
  return DECISION_PROVIDER_KINDS.map((kind) => DECISION_PROVIDER_PRESETS[kind]);
}

/**
 * Narrow a string to a {@link DecisionProviderKind}.
 *
 * @param value - Candidate, e.g. a `--provider` flag value.
 * @returns The kind, or `undefined` when `value` names no provider.
 */
export function parseDecisionProviderKind(
  value: string | undefined,
): DecisionProviderKind | undefined {
  return DECISION_PROVIDER_KINDS.find((kind) => kind === value?.trim().toLowerCase());
}

/**
 * Infer the provider kind from a base URL: the layahost origin (scheme, host
 * and port of {@link LAYAHOST_BASE_URL}) → `layahost`, anything else → `jev`.
 *
 * @param baseUrl - Provider base URL.
 * @returns The inferred kind.
 */
export function inferDecisionProviderKind(baseUrl: string): DecisionProviderKind {
  try {
    return new URL(baseUrl).origin === new URL(LAYAHOST_BASE_URL).origin ? 'layahost' : 'jev';
  } catch {
    return 'jev';
  }
}

/**
 * The preset base URL of a provider kind, which a profile storing `default`
 * resolves to at call time.
 *
 * @param kind - Provider kind.
 * @returns The preset URL, or `undefined` when the kind has none.
 */
export function presetBaseUrl(kind: DecisionProviderKind): string | undefined {
  return DECISION_PROVIDER_PRESETS[kind].defaultBaseUrl;
}
