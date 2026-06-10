/**
 * Onboarding login engine — typed result envelope (T11724 · M3).
 *
 * The 3-step onboarding login flow (`runOnboardingLogin` in `@cleocode/core`)
 * walks a provider from a cold start to a usable, validated profile binding:
 *
 *   1. **connect** — resolve the provider (alias → canonical) and land a
 *      credential (Account) in the multi-credential pool (OAuth token or API
 *      key). NO browser interaction in the engine itself: the owner-driven
 *      OAuth code/token is passed in, so the flow is non-interactive and
 *      testable.
 *   2. **select** — pick a model from the catalog (latest by `release_date`,
 *      or an explicit override validated against the catalog).
 *   3. **bind**    — write the `llm.default` / `llm.roles[role]` config binding
 *      that ties the account + model together.
 *   4. **validate** — round-trip the binding through `resolveLLMForSystem` and
 *      confirm the resolved provider/model are consistent. NOT a live LLM call:
 *      no token is materialized, only the resolution metadata is asserted.
 *
 * ## Security — NO secret fields (AC2)
 *
 * This module is **types-only** (Gate 10 contracts-purity). The result
 * envelope carries ONLY non-secret identifiers — provider name, account label,
 * model id, profile/role name, and per-step status. It NEVER carries an access
 * token, API key, refresh token, or any token-derived value beyond a redacted
 * preview. The plaintext secret is materialized only at the wire via the
 * {@link SealedCredential} handle — never on this envelope.
 *
 * @module llm/onboarding
 * @task T11724
 * @epic T11671 (E6-ONBOARDING-FRONT-DOOR)
 */

import type { ProviderId } from './provider-id.js';

/**
 * Discriminant naming each step of the onboarding login flow, in execution
 * order. Surfaced on every {@link OnboardingStepResult} so a UI / CLI can
 * render a deterministic 4-row progress checklist.
 *
 * @task T11724
 */
export type OnboardingStepName = 'connect' | 'select' | 'bind' | 'validate';

/**
 * Outcome of a single onboarding step.
 *
 * - `'ok'`      — the step completed successfully.
 * - `'failed'`  — the step could not complete (e.g. missing credential,
 *   unknown model, config write error). The engine STOPS at the first
 *   `'failed'` step and returns the partial envelope; it does NOT throw.
 * - `'skipped'` — the step was intentionally not run because an earlier step
 *   failed (downstream steps are short-circuited but still reported so the
 *   4-row shape is stable).
 *
 * @task T11724
 */
export type OnboardingStepStatus = 'ok' | 'failed' | 'skipped';

/**
 * Result of one step in the onboarding login flow.
 *
 * `detail` is a short, human-readable, SECRET-FREE summary of what the step
 * did (e.g. `"account 'work' connected (oauth)"`, `"model 'claude-…' selected
 * from catalog"`). `code` carries a stable `E_*` error code on failure so a
 * caller can branch programmatically without string-matching `detail`.
 *
 * @task T11724
 */
export interface OnboardingStepResult {
  /** Which step this result describes. */
  readonly step: OnboardingStepName;
  /** Terminal status of the step. */
  readonly status: OnboardingStepStatus;
  /** Human-readable, secret-free summary of the step outcome. */
  readonly detail: string;
  /**
   * Stable `E_*` error code when `status === 'failed'`; omitted otherwise.
   * Never carries a token or other secret.
   */
  readonly code?: string;
}

/**
 * The auth scheme by which the connect step landed a credential in the pool.
 *
 * - `'oauth'`   — an OAuth access token (PKCE / device-code) was supplied.
 * - `'api_key'` — a raw API key was supplied (OAuth-less providers fall
 *   through to this path — AC4).
 *
 * @task T11724
 */
export type OnboardingAuthMode = 'oauth' | 'api_key';

/**
 * Typed result envelope returned by `runOnboardingLogin` (AC2).
 *
 * Carries NO secret fields — only the per-step trace and the non-secret
 * identifiers needed to render the result and confirm the binding. `validated`
 * is the single boolean a caller checks to know the end-to-end flow succeeded
 * (all four steps `'ok'` AND the round-trip resolution was consistent).
 *
 * @task T11724
 */
export interface OnboardingResult {
  /** The 4 step traces, always length 4, in execution order. */
  readonly steps: ReadonlyArray<OnboardingStepResult>;
  /** Canonical provider id the flow resolved to (alias → canonical). */
  readonly provider: ProviderId;
  /**
   * Human-readable account/credential label the connect step stored in the
   * pool (e.g. `'oauth-login'`, `'work'`). Names *which* credential the
   * binding points at — safe to log/serialize; NOT a secret.
   */
  readonly accountLabel: string;
  /** The auth scheme used by the connect step, or `null` when connect failed. */
  readonly authMode: OnboardingAuthMode | null;
  /** Catalog model id the select step chose, or `null` when select failed. */
  readonly modelId: string | null;
  /**
   * The profile/role name the bind step wrote (e.g. `'default'` for the global
   * binding or a {@link import('../config.js').RoleName} for a per-role
   * binding), or `null` when bind failed.
   */
  readonly profileName: string | null;
  /**
   * `true` only when all four steps succeeded AND the validate round-trip
   * confirmed the binding resolves to the connected provider + selected model.
   */
  readonly validated: boolean;
}
