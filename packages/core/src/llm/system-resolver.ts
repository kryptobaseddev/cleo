/**
 * `resolveLLMForSystem` — the single DRY chokepoint for all LLM resolution (E9).
 *
 * ## Purpose
 *
 * CLEO previously had a 4-resolver / 3-picker sprawl: `resolveLLMForRole`,
 * `resolveAnthropicForRole`, `resolveCredentials`, and several inline `pickX`
 * helpers each duplicated the implicit fallback model literal or called different
 * tiers of the resolution chain independently.
 *
 * `resolveLLMForSystem` is the ONE chokepoint that:
 *
 *   1. Accepts a semantic "system of use" label (e.g. `'sentient'`, `'memory'`)
 *      instead of raw role names — insulating call-sites from config vocabulary.
 *   2. Maps the system label to the canonical {@link RoleName} via
 *      {@link SYSTEM_ROLE_MAP} (overridable by `opts.roleOverride`).
 *   3. Delegates to `resolveLLMForRole` for the full 5-tier config +
 *      CredentialPool resolution chain — no duplication.
 *   4. When resolution lands on `implicit-fallback`, replaces the hardcoded
 *      haiku literal with the SSoT default model from the provider registry
 *      (`getProviderProfile(provider).defaultModel`) — satisfying the
 *      "not hardcoded" acceptance criterion.
 *
 * ## What this is NOT
 *
 * - A replacement for `resolveLLMForRole`. Existing callers of
 *   `resolveLLMForRole` continue to work unchanged; T11757 will migrate them
 *   to this chokepoint incrementally.
 * - A new credential store or provider registry. All credential I/O goes
 *   through the existing CredentialPool (E3 pool) inside `resolveLLMForRole`.
 *
 * @module llm/system-resolver
 * @task T11749
 * @epic T11745
 */

import type { ResolveLLMForSystemOptions, RoleName, SystemOfUse } from '@cleocode/contracts';
import { SYSTEM_ROLE_MAP } from '@cleocode/contracts';
import { getLogger } from '../logger.js';
import {
  IMPLICIT_FALLBACK_PROVIDER,
  type ResolvedLLM,
  resolveLLMForRole,
} from './role-resolver.js';

const logger = getLogger('llm-system-resolver');

/**
 * Result of {@link resolveLLMForSystem}.
 *
 * Extends {@link ResolvedLLM} with the resolved `system` label so callers
 * can log/audit which system triggered the resolution without passing it
 * separately.
 *
 * @task T11749
 */
export interface ResolvedLLMForSystem extends ResolvedLLM {
  /**
   * The {@link SystemOfUse} label that initiated this resolution.
   *
   * Preserved verbatim from the call argument — not normalised or remapped.
   */
  system: SystemOfUse;

  /**
   * The {@link RoleName} that was actually used for config lookup.
   *
   * `null` when `system === 'default'` and no role override was supplied
   * (the global LLM default path was used instead of a per-role entry).
   */
  resolvedRole: RoleName | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a {@link SystemOfUse} to the {@link RoleName} that `resolveLLMForRole`
 * will use for config lookup.
 *
 * Priority:
 *   1. `opts.roleOverride` — explicit caller override.
 *   2. {@link SYSTEM_ROLE_MAP} — static default for the system label.
 *
 * Returns `null` when the system maps to the global default (no role entry).
 */
function deriveRole(system: SystemOfUse, opts?: ResolveLLMForSystemOptions): RoleName | null {
  if (opts?.roleOverride) return opts.roleOverride;
  return SYSTEM_ROLE_MAP[system] ?? null;
}

/**
 * When `resolveLLMForRole` returns `source === 'implicit-fallback'`, the
 * model is the hardcoded `IMPLICIT_FALLBACK_MODEL` literal. This function
 * replaces it with the SSoT `defaultModel` from the provider registry so
 * the resolved model tracks catalog updates rather than a frozen constant.
 *
 * On any lookup error the original `resolved` envelope is returned unchanged
 * so the caller is never blocked — graceful degradation is preserved.
 *
 * @param resolved - The envelope returned by `resolveLLMForRole`.
 * @returns The same envelope, possibly with `model` replaced from the registry.
 */
async function upgradeCatalogDefault(resolved: ResolvedLLM): Promise<ResolvedLLM> {
  if (resolved.source !== 'implicit-fallback') {
    // Not a fallback — the user explicitly configured a model; respect it.
    return resolved;
  }

  try {
    // Lazy import to avoid pulling the full registry chain at module-init time.
    const { getProviderProfile } = await import('./provider-registry/index.js');
    const profile = await getProviderProfile(resolved.provider);
    if (!profile?.defaultModel) {
      // Registry has no default for this provider — fall back to the existing model.
      return resolved;
    }
    if (profile.defaultModel === resolved.model) {
      // Already the same — no mutation needed.
      return resolved;
    }
    logger.debug(
      { provider: resolved.provider, from: resolved.model, to: profile.defaultModel },
      'system-resolver: upgrading implicit-fallback model to catalog default',
    );
    return { ...resolved, model: profile.defaultModel };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'system-resolver: catalog default lookup failed; keeping existing fallback model',
    );
    return resolved;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the LLM client + credential for a semantic system-of-use label.
 *
 * This is the single DRY chokepoint for all LLM resolution in CLEO (E9 ·
 * T11745). It wraps `resolveLLMForRole` with:
 *
 *   - System label → role mapping (via {@link SYSTEM_ROLE_MAP}).
 *   - SSoT default model from the provider registry when `implicit-fallback`
 *     is reached (the hardcoded haiku literal is NOT used as the final model).
 *   - Full CredentialPool (E3) binding via `resolveLLMForRole` delegation.
 *
 * Like `resolveLLMForRole`, this function **never throws**: when no credential
 * is reachable the caller receives `{ credential: null, client: null, … }` and
 * is responsible for its own graceful-degradation path.
 *
 * @example
 * ```ts
 * const resolved = await resolveLLMForSystem('sentient', { projectRoot });
 * if (!resolved.credential?.apiKey || !resolved.client) {
 *   return null; // graceful no-op — no credential available
 * }
 * // Use resolved.model, resolved.client, resolved.credential
 * ```
 *
 * @param system - Semantic label for the subsystem requesting an LLM client.
 * @param opts   - Optional overrides (project root, role override, skipCatalogDefault).
 * @returns A {@link ResolvedLLMForSystem} envelope; never throws.
 *
 * @task T11749
 * @epic T11745
 */
export async function resolveLLMForSystem(
  system: SystemOfUse,
  opts?: ResolveLLMForSystemOptions,
): Promise<ResolvedLLMForSystem> {
  const resolvedRole = deriveRole(system, opts);

  // When the role is null (system === 'default'), fall back to treating it as
  // the 'consolidation' role — this exercises the same config tiers as all
  // other roles (roles[role] → default → defaultProfile → implicit-fallback)
  // and avoids a special code path. If `config.llm.roles['consolidation']` is
  // not set, resolution cascades to `config.llm.default` and then the catalog
  // default exactly as desired.
  const roleForResolution: RoleName = resolvedRole ?? 'consolidation';

  let base: ResolvedLLM;
  try {
    base = await resolveLLMForRole(roleForResolution, {
      projectRoot: opts?.projectRoot,
    });
  } catch (err) {
    // Mirror role-resolver's never-throw contract: return a null-credential
    // envelope on unexpected failure.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), system, role: roleForResolution },
      'system-resolver: resolveLLMForRole threw unexpectedly; returning null-credential envelope',
    );
    base = {
      provider: IMPLICIT_FALLBACK_PROVIDER,
      model: 'unknown',
      client: null,
      credential: null,
      source: 'implicit-fallback',
    };
  }

  // Upgrade the implicit-fallback model to the SSoT catalog default unless
  // the caller asked to skip the catalog lookup (e.g., in tests).
  const upgraded = opts?.skipCatalogDefault ? base : await upgradeCatalogDefault(base);

  return {
    ...upgraded,
    system,
    resolvedRole,
  };
}
