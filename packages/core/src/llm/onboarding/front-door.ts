/**
 * `runFrontDoorLogin` — the shared onboarding front-door orchestrator (T11725 · M3).
 *
 * This is the ONE function every front-door entry point (`cleo login`,
 * `cleo auth login`, `cleo llm login`) dispatches to. It owns the small amount
 * of orchestration that sits ABOVE the 3-step onboarding engine
 * ({@link runOnboardingLogin}):
 *
 *   1. **resolve provider** — alias → canonical via {@link getProviderProfile}.
 *   2. **resolve auth method** — caller-supplied, else inferred from the
 *      provider profile (OAuth when the profile advertises an `oauth` config,
 *      else `api_key`).
 *   3. **acquire the credential secret**:
 *        - `api_key` → the caller passes the raw key in {@link FrontDoorLoginOptions.token}.
 *        - `oauth`   → the caller's injected {@link OAuthTokenAcquirer} runs the
 *          interactive browser / device-code dance and RETURNS the token. The
 *          interactive step lives in the CLI (so this module stays
 *          non-interactive and unit-testable); the acquirer is a seam, not a hard
 *          dependency.
 *   4. **run the engine** — hand the acquired token to {@link runOnboardingLogin},
 *      which performs connect → select → bind → validate and returns the typed,
 *      secret-free {@link OnboardingResult} envelope.
 *
 * ## Why a core orchestrator (and not CLI glue)
 *
 * Keeping this in `@cleocode/core` means the CLI handlers for all three entry
 * points are THIN — they parse flags, build a {@link ReadlineWizardIO}, supply
 * the OAuth acquirer, and call THIS function. No entry point re-implements the
 * picker, the auth-method inference, or the engine call (AC2: no duplicated
 * handler logic). Studio / the future API surface reuse the same orchestrator.
 *
 * ## Security
 *
 * The returned {@link OnboardingResult} carries NO secret fields (inherited from
 * the engine contract). The raw token flows only from the acquirer into the
 * engine's connect step; it is never logged or surfaced on the envelope.
 *
 * @module llm/onboarding/front-door
 * @task T11725
 * @epic T11671 (E6-ONBOARDING-FRONT-DOOR)
 */

import type {
  OnboardingAuthMode,
  OnboardingResult,
  ProviderProfile,
  RoleName,
} from '@cleocode/contracts';
import { getProviderProfile } from '../provider-registry/index.js';
import {
  type OnboardingDeps,
  type OnboardingLoginOptions,
  runOnboardingLogin,
} from './login-engine.js';

// ---------------------------------------------------------------------------
// Acquired-token shape
// ---------------------------------------------------------------------------

/**
 * Outcome of an interactive OAuth acquisition. The acquirer performs the
 * browser / device-code exchange and lands the credential in the pool itself
 * (reusing the existing, battle-tested `cleo llm login` flow), then returns the
 * non-secret metadata the front door surfaces. Because the credential is
 * already stored, the engine's connect step is told to skip its own write
 * (`credentialAlreadyStored`) so the OAuth token is persisted exactly once.
 *
 * @task T11725
 */
export interface AcquiredOAuthToken {
  /** The credential label the acquirer stored the OAuth credential under. */
  readonly label: string;
  /** Seconds until the access token expires (surfaced in the summary), if known. */
  readonly expiresIn?: number;
}

/**
 * Injectable seam that performs the interactive OAuth flow for a provider AND
 * lands the resulting credential in the pool, returning its non-secret label +
 * metadata.
 *
 * The CLI front-door handler supplies the real implementation (wrapping the
 * existing PKCE / device-code browser dance in `cleo llm login`). Unit tests
 * pass a stub that records the call and returns a fixed label so the
 * orchestrator is exercised without a live browser.
 *
 * @param provider - Canonical provider name (alias already resolved).
 * @returns The stored credential label + non-secret metadata.
 * @task T11725
 */
export type OAuthTokenAcquirer = (provider: string) => Promise<AcquiredOAuthToken>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for {@link runFrontDoorLogin}.
 *
 * @task T11725
 */
export interface FrontDoorLoginOptions {
  /**
   * Explicit auth method. When omitted it is inferred from the resolved
   * provider profile: `oauth` when the profile advertises an `oauth` config,
   * else `api_key`.
   */
  authMode?: OnboardingAuthMode;
  /**
   * Pre-supplied credential secret for the `api_key` path (the raw API key).
   * Ignored on the `oauth` path — that token comes from the acquirer.
   */
  token?: string;
  /** Human-readable label stored alongside the credential. */
  label?: string;
  /** Explicit model id to bind; defaults to the latest catalog model. */
  model?: string;
  /** Bind to a specific role instead of the global default. */
  role?: RoleName;
  /** Project root threaded through the engine's validate step. */
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Dependency seam (testability)
// ---------------------------------------------------------------------------

/**
 * Injectable accessors for {@link runFrontDoorLogin}.
 *
 * Defaults to the real core accessors; tests override individual members to
 * drive the orchestrator without a live provider registry / engine.
 *
 * @task T11725
 */
export interface FrontDoorDeps {
  /** Resolve a provider profile by name/alias (alias → canonical). */
  getProviderProfile: (name: string) => Promise<ProviderProfile | undefined>;
  /** The 3-step onboarding engine. */
  runOnboardingLogin: (
    provider: string,
    opts?: OnboardingLoginOptions,
    deps?: OnboardingDeps,
  ) => Promise<OnboardingResult>;
}

/**
 * The default front-door dependency set — the real, merged core accessors.
 *
 * @internal
 */
function defaultFrontDoorDeps(): FrontDoorDeps {
  return {
    getProviderProfile,
    runOnboardingLogin: (provider, opts, deps) => runOnboardingLogin(provider, opts, deps),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the auth method for a provider profile: caller override wins, else
 * `oauth` when the profile advertises an OAuth config, else `api_key`.
 *
 * @param profile - The resolved provider profile.
 * @param override - Optional explicit auth mode from the caller.
 * @returns The effective {@link OnboardingAuthMode}.
 * @task T11725
 */
export function resolveAuthMode(
  profile: ProviderProfile,
  override?: OnboardingAuthMode,
): OnboardingAuthMode {
  if (override) return override;
  return profile.oauth ? 'oauth' : 'api_key';
}

/**
 * Run the shared onboarding front-door flow for a provider (T11725 · M3).
 *
 * Resolves the provider + auth method, acquires the credential secret (raw API
 * key from `opts.token`, or via the injected {@link OAuthTokenAcquirer} for the
 * OAuth path), then delegates the heavy lifting to {@link runOnboardingLogin}.
 *
 * Mirrors the engine's never-throw-on-expected-failure contract: an unknown
 * provider or a missing api-key secret returns a failed {@link OnboardingResult}
 * envelope rather than throwing. The OAuth acquirer's own errors DO propagate —
 * an aborted browser flow is a hard, caller-visible failure.
 *
 * @param provider     - Provider name or alias (e.g. `'anthropic'`, `'codex'`).
 * @param opts         - {@link FrontDoorLoginOptions}.
 * @param acquireOAuth - Interactive OAuth token acquirer (the CLI's browser flow).
 *   Only invoked on the `oauth` path; may be omitted when the flow is `api_key`.
 * @param deps         - Injectable accessor seam; defaults to real core accessors.
 * @returns The typed onboarding result envelope.
 * @task T11725
 */
export async function runFrontDoorLogin(
  provider: string,
  opts: FrontDoorLoginOptions = {},
  acquireOAuth?: OAuthTokenAcquirer,
  deps: FrontDoorDeps = defaultFrontDoorDeps(),
): Promise<OnboardingResult> {
  // --- Resolve provider (alias → canonical) -------------------------------
  const profile = await deps.getProviderProfile(provider);
  if (!profile) {
    // Defer the canonical "unknown provider" envelope to the engine so the
    // failure shape is produced in exactly one place (DRY).
    return deps.runOnboardingLogin(provider, buildEngineOptions(opts, opts.token, false));
  }
  const canonicalProvider = profile.name;

  // --- Resolve auth method ------------------------------------------------
  const authMode = resolveAuthMode(profile, opts.authMode);

  // --- Acquire the credential ---------------------------------------------
  // api_key: the raw key is already in `opts.token` — the engine's connect step
  //          performs the single write.
  // oauth:   the acquirer runs the interactive browser flow AND stores the
  //          credential, so the engine connect step skips its own write.
  let token = opts.token;
  let credentialAlreadyStored = false;
  let label = opts.label;
  if (authMode === 'oauth') {
    if (!acquireOAuth) {
      throw new Error(
        `OAuth login for '${canonicalProvider}' requires an interactive token acquirer. ` +
          'This entry point cannot complete an OAuth flow non-interactively — ' +
          `supply an API key with --api-key/--token, or run on a terminal.`,
      );
    }
    const acquired = await acquireOAuth(canonicalProvider);
    credentialAlreadyStored = true;
    // Prefer the acquirer-reported label so the engine binds to the credential
    // the OAuth flow actually stored.
    label = label ?? acquired.label;
    token = undefined;
  }

  // --- Run the engine (connect → select → bind → validate) ----------------
  return deps.runOnboardingLogin(
    canonicalProvider,
    buildEngineOptions({ ...opts, authMode, label }, token, credentialAlreadyStored),
  );
}

/**
 * Map the front-door options + resolved token to the engine's option shape.
 *
 * Centralised so the unknown-provider deferral path and the happy path build
 * identical engine options.
 *
 * @internal
 */
function buildEngineOptions(
  opts: FrontDoorLoginOptions,
  token: string | undefined,
  credentialAlreadyStored: boolean,
): OnboardingLoginOptions {
  const engineOpts: OnboardingLoginOptions = {};
  if (token !== undefined) engineOpts.token = token;
  if (opts.authMode !== undefined) engineOpts.authMode = opts.authMode;
  if (opts.label !== undefined) engineOpts.label = opts.label;
  if (opts.model !== undefined) engineOpts.model = opts.model;
  if (opts.role !== undefined) engineOpts.role = opts.role;
  if (opts.projectRoot !== undefined) engineOpts.projectRoot = opts.projectRoot;
  if (credentialAlreadyStored) engineOpts.credentialAlreadyStored = true;
  return engineOpts;
}
