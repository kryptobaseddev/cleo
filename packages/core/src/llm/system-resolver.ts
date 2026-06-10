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

import type {
  ResolveLLMForSystemOptions,
  RoleName,
  RoleSystem,
  SystemResolverInput,
} from '@cleocode/contracts';
import { SYSTEM_ROLE_MAP } from '@cleocode/contracts';
import { getLogger } from '../logger.js';
import { proposeRoleForPrompt } from './complexity-classifier.js';
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
   * The {@link SystemResolverInput} that initiated this resolution — either the
   * flat {@link SystemOfUseLabel} or the structured {@link RoleSystem}
   * descriptor (`{ kind: 'role', id }`) the caller passed.
   *
   * Preserved verbatim from the call argument — not normalised or remapped.
   */
  system: SystemResolverInput;

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
 * Type guard: is `input` the structured {@link RoleSystem} descriptor form
 * (`{ kind: 'role', id: RoleName }`) rather than a flat {@link SystemOfUseLabel}?
 *
 * A flat label is always a `string`; the descriptor is the only object form the
 * chokepoint accepts — so a single `typeof === 'object'` test is sufficient and
 * narrows `input` to {@link RoleSystem}.
 *
 * @task T11750
 */
function isRoleSystem(input: SystemResolverInput): input is RoleSystem {
  return typeof input === 'object' && input !== null && input.kind === 'role';
}

/**
 * Map a {@link SystemResolverInput} to the {@link RoleName} that
 * `resolveLLMForRole` will use for config lookup.
 *
 * Priority:
 *   1. `opts.roleOverride` — explicit caller override (both input forms).
 *   2. Structured {@link RoleSystem} descriptor → its `id` IS the role (T11750).
 *   3. {@link SYSTEM_ROLE_MAP} — static default for the flat system label.
 *   4. L1 complexity proposer (T11906) — when the label maps to NO role AND a
 *      `complexityPrompt` was supplied, classify it and propose a role from the
 *      resulting tier. This is the "derive a tier from prompt complexity when no
 *      explicit tier/role is given" wiring (AC2): it COMPLEMENTS the resolver,
 *      only filling in a role the input left blank. The classifier returns a
 *      tier and constructs no LLM client.
 *
 * Returns `null` when a flat label maps to the global default (no role entry)
 * and no `complexityPrompt` was supplied. The descriptor form always carries a
 * concrete {@link RoleName}, so it never returns `null`.
 */
function deriveRole(
  input: SystemResolverInput,
  opts?: ResolveLLMForSystemOptions,
): RoleName | null {
  if (opts?.roleOverride) return opts.roleOverride;
  if (isRoleSystem(input)) return input.id;
  const mapped = SYSTEM_ROLE_MAP[input] ?? null;
  if (mapped !== null) return mapped;
  // No role from the label (e.g. flat `'default'`). If the caller handed us a
  // prompt, let the L1 complexity classifier propose a tier → role.
  if (opts?.complexityPrompt !== undefined) {
    const proposed = proposeRoleForPrompt(opts.complexityPrompt);
    logger.debug(
      { system: input, proposedRole: proposed },
      'system-resolver: derived role from L1 complexity classifier (no explicit tier/role)',
    );
    return proposed;
  }
  return null;
}

/**
 * When `resolveLLMForRole` returns `source === 'implicit-fallback'`, the model is
 * the hardcoded `IMPLICIT_FALLBACK_MODEL` literal. This function derives the
 * default from the **`models_catalog` SSoT** (latest `release_date` for the
 * provider) so the resolved model tracks the catalog rather than a frozen
 * constant — the "catalog-driven models, NO hardcoded" North Star (E8 · T11944).
 *
 * ## Resolution order (offline-first degrade — T11944 AC1/AC2)
 *
 *   1. **`models_catalog` table** (via the {@link resolveCatalogEntry} table-first
 *      chokepoint — T11737): newest `release_date` row for the provider. When the
 *      table is seeded this WINS and the static builtin literal is never reached.
 *   2. **provider-registry `defaultModel`** (the static builtin
 *      `ProviderDef.defaultModel`) — reached ONLY when the catalog (table + disk
 *      cache + shipped seed) yields nothing for the provider.
 *   3. **the existing `IMPLICIT_FALLBACK_MODEL` literal** already on `resolved` —
 *      the absolute offline floor, preserved for a fresh/offline install with no
 *      catalog AND no provider profile (degrade does NOT break — AC2).
 *
 * NO network is issued at resolve time (table-or-cache only — AC4). On any lookup
 * error the original `resolved` envelope is returned unchanged so the caller is
 * never blocked.
 *
 * @param resolved - The envelope returned by `resolveLLMForRole`.
 * @returns The same envelope, possibly with `model` replaced from the catalog SSoT.
 */
async function upgradeCatalogDefault(resolved: ResolvedLLM): Promise<ResolvedLLM> {
  if (resolved.source !== 'implicit-fallback') {
    // Not a fallback — the user explicitly configured a model; respect it.
    return resolved;
  }

  try {
    // Lazy imports to avoid pulling the full registry/catalog chain at module-init.
    const { resolveCatalogEntry } = await import('./catalog-resolver.js');
    const { catalogKeyForProvider } = await import('./catalog-model-resolver.js');

    // 1. Table-first catalog SSoT (release_date DESC) — the canonical default.
    const catalogKey = catalogKeyForProvider(resolved.provider);
    const entry = await resolveCatalogEntry(catalogKey);
    if (entry?.id && entry.id !== resolved.model) {
      logger.debug(
        { provider: resolved.provider, from: resolved.model, to: entry.id, source: entry.source },
        'system-resolver: upgrading implicit-fallback model to models_catalog default',
      );
      return { ...resolved, model: entry.id };
    }
    if (entry?.id) {
      // Catalog already agrees with the resolved model — no mutation needed.
      return resolved;
    }

    // 2. OFFLINE FLOOR: catalog empty/unseeded (fresh/offline install). Fall back to
    //    the static builtin provider-registry default so degrade never breaks.
    const { getProviderProfile } = await import('./provider-registry/index.js');
    const profile = await getProviderProfile(resolved.provider);
    if (profile?.defaultModel && profile.defaultModel !== resolved.model) {
      logger.debug(
        { provider: resolved.provider, from: resolved.model, to: profile.defaultModel },
        'system-resolver: catalog empty — degrading to static builtin defaultModel floor',
      );
      return { ...resolved, model: profile.defaultModel };
    }

    // 3. Neither catalog nor profile yielded a model — keep the existing
    //    IMPLICIT_FALLBACK_MODEL literal already on `resolved` (the last floor).
    return resolved;
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
 * Resolve the LLM client + credential for a semantic system-of-use label OR a
 * structured {@link RoleSystem} descriptor.
 *
 * This is the single DRY chokepoint for all LLM resolution in CLEO (E9 ·
 * T11745). It wraps `resolveLLMForRole` with:
 *
 *   - System label → role mapping (via {@link SYSTEM_ROLE_MAP}); OR direct
 *     `{ kind: 'role', id }` descriptor resolution (T11750 · AC1).
 *   - SSoT default model from the provider registry when `implicit-fallback`
 *     is reached (the hardcoded haiku literal is NOT used as the final model).
 *   - Full CredentialPool (E3) binding via `resolveLLMForRole` delegation.
 *
 * ## Role equivalence (T11750 · AC1)
 *
 * `resolveLLMForSystem({ kind: 'role', id })` is the chokepoint expression of a
 * direct role resolution — identical to `resolveLLMForRole(id)` for every
 * resolution-relevant field (`provider` / `model` / `source` / `credential` /
 * `sealedCredential` / `apiMode` / …), differing ONLY by the additive `system`
 * + `resolvedRole` envelope fields. There is exactly ONE resolution
 * implementation (`resolveLLMForRole`); both input forms funnel through it with
 * ZERO duplicated logic. The descriptor form does NOT thread a `systemKey`
 * (there is no flat label to key the `llm.systems[key]` override tier on), so it
 * walks the same tier chain a bare `resolveLLMForRole(id)` call walks.
 *
 * Like `resolveLLMForRole`, this function **never throws**: when no credential
 * is reachable the caller receives `{ credential: null, client: null, … }` and
 * is responsible for its own graceful-degradation path.
 *
 * @example
 * ```ts
 * // Flat label (background subsystem):
 * const a = await resolveLLMForSystem('sentient', { projectRoot });
 * // Structured role descriptor (T11750 · AC1) — equivalent to
 * // resolveLLMForRole('consolidation'):
 * const b = await resolveLLMForSystem({ kind: 'role', id: 'consolidation' }, { projectRoot });
 * if (!a.sealedCredential || !a.client) {
 *   return null; // graceful no-op — no credential available
 * }
 * // Use resolved.model, resolved.client, resolved.credential (metadata only);
 * // materialize the secret at the wire via resolved.sealedCredential.fetch().
 * ```
 *
 * @param system - Flat {@link SystemOfUseLabel} or {@link RoleSystem} descriptor.
 * @param opts   - Optional overrides (project root, role override, skipCatalogDefault).
 * @returns A {@link ResolvedLLMForSystem} envelope; never throws.
 *
 * @task T11749
 * @task T11750
 * @epic T11745
 */
export async function resolveLLMForSystem(
  system: SystemResolverInput,
  opts?: ResolveLLMForSystemOptions,
): Promise<ResolvedLLMForSystem> {
  const resolvedRole = deriveRole(system, opts);

  // When the role is null (flat `system === 'default'`), fall back to treating
  // it as the 'consolidation' role — this exercises the same config tiers as
  // all other roles (roles[role] → default → defaultProfile → implicit-fallback)
  // and avoids a special code path. If `config.llm.roles['consolidation']` is
  // not set, resolution cascades to `config.llm.default` and then the catalog
  // default exactly as desired. The descriptor form always carries a concrete
  // role id, so `resolvedRole` is never null there.
  const roleForResolution: RoleName = resolvedRole ?? 'consolidation';

  // Thread the flat label as the `llm.systems[key]` granular-override key (E9 ·
  // T11748). The structured `{ kind: 'role', id }` descriptor carries NO label
  // to key that tier on, so it omits `systemKey` and walks the same tier chain
  // a bare `resolveLLMForRole(id)` call walks — preserving the AC1 equivalence.
  //
  // T11759 (M4): an explicit `opts.systemKey` OVERRIDES the label-derived key.
  // This lets an OPEN-axis caller (a `.cantbook` node keyed
  // `cantbook:<playbook>#<nodeId>`) drive the `llm.systems[key]` granular tier +
  // audit identity while passing a resolvable background label as `system`.
  const systemKey: string | undefined =
    opts?.systemKey ?? (isRoleSystem(system) ? undefined : system);

  let base: ResolvedLLM;
  try {
    base = await resolveLLMForRole(roleForResolution, {
      projectRoot: opts?.projectRoot,
      systemKey,
      // T11759: pin a named profile (e.g. a `.cantbook` stage's `profile:`) as
      // the highest-priority resolution tier. Absent/incomplete → falls through.
      ...(opts?.profile !== undefined ? { profileOverride: opts.profile } : {}),
    });
  } catch (err) {
    // Mirror role-resolver's never-throw contract: return a null-credential
    // envelope on unexpected failure.
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        system,
        role: roleForResolution,
      },
      'system-resolver: resolveLLMForRole threw unexpectedly; returning null-credential envelope',
    );
    base = {
      provider: IMPLICIT_FALLBACK_PROVIDER,
      model: 'unknown',
      client: null,
      credential: null,
      // E10 (T11753): no credential resolved → null sealed handle, paired with
      // the null `credential` metadata above.
      sealedCredential: null,
      source: 'implicit-fallback',
      // SSoT wire facts (E9 · T11745): the implicit-fallback provider is
      // anthropic and there is no credential, so the descriptor advertises the
      // anthropic_messages protocol with no override / no auth.
      apiMode: 'anthropic_messages',
      baseUrl: null,
      authType: null,
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
