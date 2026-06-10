/**
 * `runOnboardingLogin` — the 3-step onboarding login engine (T11724 · M3).
 *
 * The imperative front-door flow that takes a provider from a cold start to a
 * usable, validated profile binding. It ORCHESTRATES the already-merged
 * credential / catalog / config / resolver accessors — it does NOT reimplement
 * OAuth, construct a transport, or open an LLM client (Gate-13: chokepoint only).
 *
 * ## The four steps
 *
 *   1. **connect**  — resolve the provider (alias → canonical via
 *      {@link getProviderProfile}) and land a credential (Account) in the
 *      multi-credential pool via {@link addCredential}. The OAuth token / API
 *      key is supplied by the caller (`opts.token`): the owner-driven browser
 *      step (PKCE / device-code) runs in `cleo llm login` BEFORE this engine,
 *      so the engine itself is non-interactive and testable. OAuth-less
 *      providers pass the same `opts.token` as an API key (AC4).
 *   2. **select**   — choose a model from the catalog: `opts.model` when given
 *      (validated against the catalog), else the latest by `release_date` via
 *      {@link resolveProviderDefaultModel}.
 *   3. **bind**     — write the `llm.default` (or `llm.roles[role]`) config
 *      binding tying the account + model together via {@link setConfigValue}.
 *   4. **validate** — round-trip the binding through {@link resolveLLMForSystem}
 *      and confirm the resolved provider/model are consistent. NOT a live LLM
 *      call: no token is materialized; only resolution metadata is asserted,
 *      and the secret stays behind the sealed handle.
 *
 * ## Security (AC2)
 *
 * The {@link OnboardingResult} envelope carries NO secret fields — never an
 * access token, API key, or refresh token. The plaintext is materialized only
 * at the wire via the sealed handle, never on this envelope.
 *
 * ## Testability (AC3)
 *
 * Every step depends only on the injectable {@link OnboardingDeps} seam, which
 * defaults to the real core accessors. Tests pass a {@link StubOnboardingDeps}
 * (stub catalog + in-memory pool/config + stub resolver) to exercise each step
 * in isolation without a live browser, network, or disk.
 *
 * @module llm/onboarding/login-engine
 * @task T11724
 * @epic T11671 (E6-ONBOARDING-FRONT-DOOR)
 */

import type {
  ModelTransport,
  OnboardingAuthMode,
  OnboardingResult,
  OnboardingStepName,
  OnboardingStepResult,
  ProviderProfile,
  RoleName,
} from '@cleocode/contracts';
import { WHOAMI_ROLE_IDS } from '@cleocode/contracts';
import { setConfigValue } from '../../config.js';
import { getLogger } from '../../logger.js';
import {
  catalogKeyForProvider,
  resolveProviderDefaultModel,
  validateModelForProvider,
} from '../catalog-model-resolver.js';
import { addCredential, type StoredAuthType } from '../credentials-store.js';
import { getProviderProfile } from '../provider-registry/index.js';
import { resolveLLMForSystem } from '../system-resolver.js';

const logger = getLogger('llm-onboarding');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for {@link runOnboardingLogin}.
 *
 * @task T11724
 */
export interface OnboardingLoginOptions {
  /**
   * The credential secret to store — an OAuth access token (when
   * `authMode: 'oauth'`) or a raw API key (when `authMode: 'api_key'`).
   *
   * The interactive OAuth browser/device-code exchange runs in
   * `cleo llm login` BEFORE this engine; the resulting token is passed here so
   * the engine is non-interactive and testable. When omitted, the connect step
   * fails cleanly with `E_ONBOARDING_NO_CREDENTIAL` (no throw).
   */
  token?: string;
  /**
   * Auth scheme for the supplied `token`. Defaults to `'oauth'` when the
   * resolved provider profile exposes an OAuth config, else `'api_key'` (AC4).
   */
  authMode?: OnboardingAuthMode;
  /** Human-readable label stored alongside the credential. Defaults to `'oauth-login'`. */
  label?: string;
  /**
   * Explicit model id to bind. When omitted, the latest catalog model for the
   * provider (by `release_date`) is selected. When given, it is validated
   * against the catalog and rejected with `E_MODEL_NOT_IN_CATALOG` on a miss.
   */
  model?: string;
  /**
   * Bind the model to a specific role (`llm.roles[role]`) instead of the
   * global default (`llm.default`). The bound name surfaces as
   * {@link OnboardingResult.profileName}.
   */
  role?: RoleName;
  /** Project root passed through to the resolver during the validate step. */
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Dependency seam (AC3 — each step independently testable)
// ---------------------------------------------------------------------------

/**
 * Minimal resolver result the validate step asserts against — a structural
 * subset of `ResolvedLLMForSystem` so a stub resolver need not construct a full
 * client/credential graph.
 *
 * @task T11724
 */
export interface OnboardingResolution {
  /** Provider the binding resolved to. */
  provider: ModelTransport;
  /** Model the binding resolved to. */
  model: string;
  /**
   * Sealed credential handle (or `null`). The validate step reads only its
   * presence + `tokenPreview` — it NEVER calls `fetch()`, so no secret is
   * materialized during onboarding.
   */
  sealedCredential: { tokenPreview: string } | null;
}

/**
 * Injectable accessor seam. Defaults to the real `@cleocode/core` accessors;
 * tests override individual members to exercise each step in isolation.
 *
 * @task T11724
 */
export interface OnboardingDeps {
  /** Resolve a provider profile by name/alias (alias → canonical). */
  getProviderProfile: (name: string) => Promise<ProviderProfile | undefined>;
  /** Persist a credential (Account) into the multi-credential pool. */
  addCredential: (input: {
    provider: ModelTransport;
    label: string;
    authType: StoredAuthType;
    accessToken: string;
    source: string;
  }) => Promise<unknown>;
  /** Map a CLEO provider name to its models.dev catalog key. */
  catalogKeyForProvider: (providerName: string) => string;
  /** Resolve the latest catalog model for a provider, or `null`. */
  resolveProviderDefaultModel: (catalogKey: string) => string | null;
  /** Validate a model id against the catalog for a provider. */
  validateModelForProvider: (
    model: string,
    catalogKey: string,
  ) => { valid: boolean; reason: string };
  /** Write a global config value (the `llm.default` / `llm.roles[role]` binding). */
  setConfigValue: (key: string, value: unknown) => Promise<unknown>;
  /** Round-trip resolve the binding for the validate step. */
  resolve: (provider: ModelTransport, projectRoot?: string) => Promise<OnboardingResolution>;
}

/**
 * The default dependency set — the real, merged core accessors.
 *
 * @task T11724
 */
function defaultDeps(): OnboardingDeps {
  return {
    getProviderProfile,
    addCredential: (input) => addCredential(input),
    catalogKeyForProvider,
    resolveProviderDefaultModel: (catalogKey) => resolveProviderDefaultModel(catalogKey),
    validateModelForProvider: (model, catalogKey) => validateModelForProvider(model, catalogKey),
    setConfigValue: (key, value) => setConfigValue(key, value, undefined, { global: true }),
    resolve: async (_provider, projectRoot) => {
      const resolved = await resolveLLMForSystem(
        { kind: 'role', id: 'consolidation' },
        projectRoot !== undefined ? { projectRoot } : undefined,
      );
      // Map the full resolver envelope down to the structural subset the
      // validate step needs. NOTE: we never read or materialize the secret.
      return {
        provider: resolved.provider,
        model: resolved.model,
        sealedCredential: resolved.sealedCredential
          ? { tokenPreview: resolved.sealedCredential.tokenPreview }
          : null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal step-trace helpers
// ---------------------------------------------------------------------------

/** Build an `ok` step trace. @internal */
function ok(step: OnboardingStepName, detail: string): OnboardingStepResult {
  return { step, status: 'ok', detail };
}

/** Build a `failed` step trace carrying a stable `E_*` code. @internal */
function fail(step: OnboardingStepName, code: string, detail: string): OnboardingStepResult {
  return { step, status: 'failed', detail, code };
}

/** Build a `skipped` step trace (downstream of a failure). @internal */
function skipped(step: OnboardingStepName, detail: string): OnboardingStepResult {
  return { step, status: 'skipped', detail };
}

/**
 * Compose the partial envelope returned when a step fails: the failed step's
 * trace plus a `skipped` trace for every remaining step, so the 4-row shape is
 * always stable.
 *
 * @internal
 */
function withSkips(
  done: OnboardingStepResult[],
  failedAt: OnboardingStepResult,
): OnboardingStepResult[] {
  const order: OnboardingStepName[] = ['connect', 'select', 'bind', 'validate'];
  const steps = [...done, failedAt];
  const seen = new Set(steps.map((s) => s.step));
  for (const name of order) {
    if (!seen.has(name)) steps.push(skipped(name, 'skipped — earlier step failed'));
  }
  // Re-sort into canonical execution order.
  return order.map((name) => steps.find((s) => s.step === name)!);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the 3-step onboarding login flow for a provider (T11724 · M3).
 *
 * Walks **connect → select → bind → validate**, reusing the merged credential /
 * catalog / config / resolver accessors. Returns a typed {@link OnboardingResult}
 * envelope with the per-step trace and the non-secret binding identifiers.
 *
 * Like the resolver chokepoint, this engine **never throws** for an expected
 * failure (missing credential, unknown model, config write error): it returns
 * an envelope whose failing step carries `status: 'failed'` and a stable `E_*`
 * `code`, with `validated: false`. Unexpected accessor errors are caught and
 * mapped to a failed step trace as well.
 *
 * @param provider - Provider name or alias (e.g. `'anthropic'`, `'codex'`).
 * @param opts     - {@link OnboardingLoginOptions} (token, model, role, …).
 * @param deps     - Injectable accessor seam (AC3); defaults to real core accessors.
 * @returns The typed onboarding result envelope; never throws on expected failure.
 *
 * @task T11724
 */
export async function runOnboardingLogin(
  provider: string,
  opts: OnboardingLoginOptions = {},
  deps: OnboardingDeps = defaultDeps(),
): Promise<OnboardingResult> {
  const label = opts.label?.trim() ? opts.label.trim() : 'oauth-login';
  const done: OnboardingStepResult[] = [];

  // --- Step 1: connect ----------------------------------------------------
  let canonicalProvider: ModelTransport;
  let authMode: OnboardingAuthMode;
  try {
    const profile = await deps.getProviderProfile(provider);
    if (!profile) {
      const step = fail(
        'connect',
        'E_UNKNOWN_PROVIDER',
        `Unknown provider '${provider}'. Run \`cleo llm list-providers\` to see supported providers.`,
      );
      return envelope(withSkips(done, step), provider, label, null, null, null, false);
    }
    canonicalProvider = profile.name as ModelTransport;

    if (!opts.token) {
      const step = fail(
        'connect',
        'E_ONBOARDING_NO_CREDENTIAL',
        `No credential supplied for '${canonicalProvider}'. ` +
          `Complete \`cleo llm login ${canonicalProvider}\` (OAuth) or pass an API key.`,
      );
      return envelope(withSkips(done, step), canonicalProvider, label, null, null, null, false);
    }

    // OAuth when the provider profile advertises an OAuth config; else API key (AC4).
    authMode = opts.authMode ?? (profile.oauth ? 'oauth' : 'api_key');
    const storedAuthType: StoredAuthType = authMode === 'oauth' ? 'oauth' : 'api_key';

    await deps.addCredential({
      provider: canonicalProvider,
      label,
      authType: storedAuthType,
      accessToken: opts.token,
      source: 'onboarding-login',
    });
    done.push(ok('connect', `account '${label}' connected (${authMode})`));
  } catch (err) {
    const step = fail('connect', 'E_ONBOARDING_CONNECT_FAILED', errMsg(err));
    return envelope(withSkips(done, step), provider, label, null, null, null, false);
  }

  // --- Step 2: select -----------------------------------------------------
  let modelId: string;
  try {
    const catalogKey = deps.catalogKeyForProvider(canonicalProvider);
    if (opts.model) {
      const validation = deps.validateModelForProvider(opts.model, catalogKey);
      if (!validation.valid && validation.reason === 'not-found') {
        const step = fail(
          'select',
          'E_MODEL_NOT_IN_CATALOG',
          `Model '${opts.model}' is not in the catalog for provider '${canonicalProvider}'. ` +
            `Run \`cleo llm refresh-catalog\` to update the catalog.`,
        );
        return envelope(
          withSkips(done, step),
          canonicalProvider,
          label,
          authMode,
          null,
          null,
          false,
        );
      }
      modelId = opts.model;
      done.push(ok('select', `model '${modelId}' selected (explicit, validated)`));
    } else {
      const latest = deps.resolveProviderDefaultModel(catalogKey);
      if (!latest) {
        const step = fail(
          'select',
          'E_NO_CATALOG_MODEL',
          `No catalog model available for '${canonicalProvider}'. ` +
            `Run \`cleo llm refresh-catalog\`, or pass an explicit \`--model\`.`,
        );
        return envelope(
          withSkips(done, step),
          canonicalProvider,
          label,
          authMode,
          null,
          null,
          false,
        );
      }
      modelId = latest;
      done.push(ok('select', `model '${modelId}' selected (catalog default, latest release_date)`));
    }
  } catch (err) {
    const step = fail('select', 'E_ONBOARDING_SELECT_FAILED', errMsg(err));
    return envelope(withSkips(done, step), canonicalProvider, label, authMode, null, null, false);
  }

  // --- Step 3: bind -------------------------------------------------------
  let profileName: string;
  try {
    if (opts.role) {
      if (!(WHOAMI_ROLE_IDS as readonly string[]).includes(opts.role)) {
        const step = fail(
          'bind',
          'E_INVALID_ROLE',
          `Invalid role '${opts.role}'. Valid roles: ${WHOAMI_ROLE_IDS.join(', ')}.`,
        );
        return envelope(
          withSkips(done, step),
          canonicalProvider,
          label,
          authMode,
          modelId,
          null,
          false,
        );
      }
      await deps.setConfigValue(`llm.roles.${opts.role}.provider`, canonicalProvider);
      await deps.setConfigValue(`llm.roles.${opts.role}.model`, modelId);
      await deps.setConfigValue(`llm.roles.${opts.role}.credentialLabel`, label);
      profileName = opts.role;
      done.push(ok('bind', `profile '${profileName}' bound → ${canonicalProvider}/${modelId}`));
    } else {
      await deps.setConfigValue('llm.default.provider', canonicalProvider);
      await deps.setConfigValue('llm.default.model', modelId);
      profileName = 'default';
      done.push(ok('bind', `default binding → ${canonicalProvider}/${modelId}`));
    }
  } catch (err) {
    const step = fail('bind', 'E_ONBOARDING_BIND_FAILED', errMsg(err));
    return envelope(
      withSkips(done, step),
      canonicalProvider,
      label,
      authMode,
      modelId,
      null,
      false,
    );
  }

  // --- Step 4: validate ---------------------------------------------------
  try {
    const resolved = await deps.resolve(canonicalProvider, opts.projectRoot);
    const providerMatch = resolved.provider === canonicalProvider;
    const modelMatch = resolved.model === modelId;
    const hasHandle = resolved.sealedCredential !== null;

    if (providerMatch && modelMatch && hasHandle) {
      done.push(
        ok(
          'validate',
          `round-trip ok — resolves to ${resolved.provider}/${resolved.model} ` +
            `(sealed handle ${resolved.sealedCredential?.tokenPreview ?? '…'})`,
        ),
      );
      return envelope(done, canonicalProvider, label, authMode, modelId, profileName, true);
    }

    const reason = !hasHandle
      ? 'no credential handle resolved'
      : `resolved ${resolved.provider}/${resolved.model}, expected ${canonicalProvider}/${modelId}`;
    const step = fail(
      'validate',
      'E_ONBOARDING_VALIDATION_FAILED',
      `binding inconsistent — ${reason}`,
    );
    return envelope(
      [...done, step],
      canonicalProvider,
      label,
      authMode,
      modelId,
      profileName,
      false,
    );
  } catch (err) {
    const step = fail('validate', 'E_ONBOARDING_VALIDATION_FAILED', errMsg(err));
    return envelope(
      [...done, step],
      canonicalProvider,
      label,
      authMode,
      modelId,
      profileName,
      false,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Assemble the {@link OnboardingResult} envelope. Centralised so every return
 * path produces an identically-shaped, secret-free result.
 *
 * @internal
 */
function envelope(
  steps: OnboardingStepResult[],
  provider: string,
  accountLabel: string,
  authMode: OnboardingAuthMode | null,
  modelId: string | null,
  profileName: string | null,
  validated: boolean,
): OnboardingResult {
  return {
    steps,
    provider,
    accountLabel,
    authMode,
    modelId,
    profileName,
    validated,
  };
}

/**
 * Extract a short, secret-free message from an unknown thrown value. The
 * onboarding accessors already redact their own error strings; this is a final
 * defensive narrow so the envelope never carries a raw stack.
 *
 * @internal
 */
function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  logger.debug({ err: raw }, 'onboarding: step accessor error');
  return raw;
}
