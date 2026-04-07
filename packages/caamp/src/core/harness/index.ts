/**
 * Harness layer dispatcher.
 *
 * @remarks
 * This module is the single entry point for resolving a concrete
 * {@link Harness} implementation from a provider (or from the registry's
 * primary provider). It owns the switch that maps provider ids to
 * implementations so the rest of CAAMP never needs to construct harness
 * classes directly.
 *
 * Today only Pi has a harness implementation. Future harnesses (Goose,
 * OpenCode, ...) will be added to {@link getHarnessFor} alongside Pi.
 *
 * @packageDocumentation
 */

import type { Provider } from '../../types.js';
import {
  getExclusivityMode,
  hasExplicitNonPiAutoWarned,
  hasPiAbsentAutoWarned,
  markExplicitNonPiAutoWarned,
  markPiAbsentAutoWarned,
  PiRequiredError,
} from '../config/caamp-config.js';
import { getInstalledProviders } from '../registry/detection.js';
import { getAllProviders, getPrimaryProvider } from '../registry/providers.js';
import {
  installSkill as genericInstallSkill,
  removeSkill as genericRemoveSkill,
  type SkillInstallResult,
} from '../skills/installer.js';
import { PiHarness } from './pi.js';
import type {
  ExclusivityMode,
  Harness,
  HarnessScope,
  ResolveDefaultTargetProvidersOptions,
} from './types.js';

/**
 * Return the harness implementation for a provider, or `null` if the
 * provider has no first-class harness.
 *
 * @remarks
 * This is the primary dispatcher. As new harnesses are added, their
 * provider id → implementation mapping lives here.
 *
 * @param provider - Resolved provider to look up.
 * @returns A harness instance, or `null` if the provider is a pure spawn
 * target with no native harness.
 *
 * @example
 * ```typescript
 * const pi = getProvider("pi");
 * if (pi) {
 *   const harness = getHarnessFor(pi);
 *   await harness?.installSkill("/path/to/skill", "my-skill", { kind: "global" });
 * }
 * ```
 *
 * @public
 */
export function getHarnessFor(provider: Provider): Harness | null {
  if (provider.id === 'pi') return new PiHarness(provider);
  return null;
}

/**
 * Return the primary harness declared in the registry, if any.
 *
 * @remarks
 * Resolves the registry's primary provider (via
 * {@link getPrimaryProvider}) and returns its harness implementation.
 * Callers use this to resolve the default `--agent` target when no flag
 * is provided.
 *
 * @returns The primary harness, or `null` if no primary provider exists
 * or the primary provider has no harness implementation.
 *
 * @example
 * ```typescript
 * const primary = getPrimaryHarness();
 * if (primary) {
 *   console.log(`Primary harness: ${primary.provider.toolName}`);
 * }
 * ```
 *
 * @public
 */
export function getPrimaryHarness(): Harness | null {
  const primary = getPrimaryProvider();
  if (primary === undefined) return null;
  return getHarnessFor(primary);
}

/**
 * Return every provider that has a harness implementation.
 *
 * @remarks
 * Iterates all registered providers and collects their harness instances.
 * Useful for diagnostics and for surfaces like
 * `caamp providers list --harnesses`.
 *
 * @returns Array of harness instances, one per provider that implements
 * the {@link Harness} contract.
 *
 * @example
 * ```typescript
 * for (const harness of getAllHarnesses()) {
 *   console.log(harness.provider.id); // "pi", ...
 * }
 * ```
 *
 * @public
 */
export function getAllHarnesses(): Harness[] {
  const result: Harness[] = [];
  for (const provider of getAllProviders()) {
    const harness = getHarnessFor(provider);
    if (harness !== null) result.push(harness);
  }
  return result;
}

/**
 * Resolve the default set of target providers when the user has not passed
 * `--agent`, honouring the active {@link ExclusivityMode}.
 *
 * @remarks
 * Resolution policy is layered. The active {@link ExclusivityMode} (read
 * via {@link getExclusivityMode}) selects which branch of the matrix runs:
 *
 * | Mode | Pi installed | Pi absent |
 * |---|---|---|
 * | `'auto'` (default) | Returns `[piProvider]`. Explicit non-Pi targets emit a one-time deprecation warning per process. | Falls back to installed primary/high-tier providers (legacy v2026.4.5 behaviour) and emits a one-time boot warning. |
 * | `'force-pi'` | Returns `[piProvider]`. | Throws {@link PiRequiredError}. |
 * | `'legacy'` | Returns the full installed provider list in priority order (matches pre-exclusivity behaviour). | Same. |
 *
 * **Install paths are unaffected.** Per ADR-035 §D7, this helper governs
 * RUNTIME INVOCATION dispatch only. Skill and instruction install
 * dispatchers ({@link dispatchInstallSkillAcrossProviders},
 * {@link dispatchRemoveSkillAcrossProviders}) intentionally do not call
 * this function — they target every requested provider directly so that
 * users in `force-pi` mode can still run
 * `caamp skills install foo --agent claude-code` while Pi is being
 * installed.
 *
 * The helper is intentionally defensive: registry/detection exceptions
 * are caught and treated as "Pi unknown" so stubbed test environments
 * that do not wire the full registry still behave sensibly.
 *
 * @param options - Optional explicit provider selection (e.g. from
 *   `--agent`) used by `auto`-mode deprecation warning detection. Omit to
 *   request the implicit default resolution.
 * @returns Ordered list of providers to target by default.
 * @throws {@link PiRequiredError} when mode is `'force-pi'` and Pi is not
 *   installed.
 *
 * @example
 * ```typescript
 * // Implicit default — used by `caamp skills list` and friends.
 * const targets = resolveDefaultTargetProviders();
 *
 * // Explicit user selection — emits a deprecation warning in `auto` mode
 * // when the selection excludes Pi and Pi is installed.
 * const explicit = resolveDefaultTargetProviders({
 *   explicit: [getProvider('claude-code')!],
 * });
 * ```
 *
 * @public
 */
export function resolveDefaultTargetProviders(
  options: ResolveDefaultTargetProvidersOptions = {},
): Provider[] {
  const mode: ExclusivityMode = getExclusivityMode();

  let primary: Harness | null = null;
  try {
    primary = getPrimaryHarness();
  } catch {
    primary = null;
  }

  let installed: Provider[];
  try {
    installed = getInstalledProviders();
  } catch {
    installed = [];
  }

  const primaryId = primary?.provider.id ?? null;
  const primaryInstalled =
    primaryId !== null && installed.some((provider) => provider.id === primaryId);
  const explicit = options.explicit;
  const explicitContainsPrimary =
    explicit !== undefined && primaryId !== null
      ? explicit.some((provider) => provider.id === primaryId)
      : false;

  // Inlined legacy fallback (v2026.4.5 algorithm). Used by `legacy` mode
  // and by the `auto` + Pi-absent branch. Captured as a closure so the
  // exclusivity matrix below has a single call site for both paths
  // without introducing a new top-level symbol.
  const legacyFallback = (): Provider[] => {
    if (primary !== null && primaryInstalled) {
      return [primary.provider];
    }
    const highTier = installed.filter(
      (provider) => provider.priority === 'primary' || provider.priority === 'high',
    );
    if (highTier.length > 0) {
      return highTier;
    }
    return installed;
  };

  // ── force-pi: Pi is mandatory at runtime invocation ─────────────────
  if (mode === 'force-pi') {
    if (primary === null || !primaryInstalled) {
      throw new PiRequiredError();
    }
    return [primary.provider];
  }

  // ── legacy: pre-exclusivity behaviour, no warnings, no requirement ──
  if (mode === 'legacy') {
    if (explicit !== undefined) {
      return explicit;
    }
    return legacyFallback();
  }

  // ── auto (default) ──────────────────────────────────────────────────
  // Emit a one-time deprecation warning when an explicit non-Pi target is
  // supplied while Pi is installed. This is the user-visible nudge that
  // direct provider targeting will be deprecated in a future major.
  if (
    explicit !== undefined &&
    explicit.length > 0 &&
    !explicitContainsPrimary &&
    primaryInstalled &&
    !hasExplicitNonPiAutoWarned()
  ) {
    console.warn(
      'Warning: Targeting a non-Pi provider explicitly is deprecated when Pi is installed. ' +
        "Future versions will route all runtime commands through Pi. To suppress this warning, set caamp.exclusivityMode to 'legacy'.",
    );
    markExplicitNonPiAutoWarned();
  }

  // Honour an explicit selection verbatim once the warning (if any) has
  // been emitted. This preserves the v2026.4.5 contract that explicit
  // `--agent` flags target exactly what the user requested.
  if (explicit !== undefined) {
    return explicit;
  }

  if (primary !== null && primaryInstalled) {
    return [primary.provider];
  }

  // Pi is not installed — fall back to the legacy detected-high-tier set
  // and emit a one-time boot warning so the user knows orchestration is
  // not engaged.
  if (!hasPiAbsentAutoWarned()) {
    console.warn(
      'Warning: Pi is not installed. CAAMP is falling back to direct provider dispatch. ' +
        'Install Pi (https://github.com/mariozechner/pi-coding-agent) to enable orchestration, ' +
        "or set caamp.exclusivityMode to 'legacy' to suppress this warning.",
    );
    markPiAbsentAutoWarned();
  }
  return legacyFallback();
}

/**
 * Install a skill across a mixed set of providers, dispatching each provider
 * to its {@link Harness} implementation when one exists and falling through
 * to the legacy canonical+symlink installer for generic providers.
 *
 * @remarks
 * This is the command-layer bridge introduced in Wave 3. It is the single
 * point where CAAMP decides, per-provider, whether to go through a harness
 * or the generic code path. The merged {@link SkillInstallResult} mirrors
 * the shape the legacy installer returns so downstream envelope builders do
 * not need to branch on dispatch type.
 *
 * Errors from an individual harness are collected into `errors` rather than
 * thrown, matching the legacy installer's tolerant contract.
 *
 * @param sourcePath - Absolute path to the source skill directory.
 * @param skillName - Target skill name.
 * @param providers - Ordered list of target providers.
 * @param isGlobal - Whether to target global or project scope.
 * @param projectDir - Project directory used by the harness project scope
 *   and forwarded to the generic installer when provided. When omitted,
 *   harness project scope falls back to `process.cwd()` and the generic
 *   installer is invoked without a `projectDir` argument so it retains its
 *   legacy default-handling behavior.
 * @returns Merged install result across the harness and generic paths.
 *
 * @example
 * ```typescript
 * const result = await dispatchInstallSkillAcrossProviders(
 *   "/abs/path/to/skill",
 *   "my-skill",
 *   [getProvider("pi")!, getProvider("claude-code")!],
 *   true,
 * );
 * console.log(result.linkedAgents); // e.g. ["pi", "claude-code"]
 * ```
 *
 * @public
 */
export async function dispatchInstallSkillAcrossProviders(
  sourcePath: string,
  skillName: string,
  providers: Provider[],
  isGlobal: boolean,
  projectDir?: string,
): Promise<SkillInstallResult> {
  const harnessTargets: Array<{ provider: Provider; harness: Harness }> = [];
  const genericTargets: Provider[] = [];
  for (const provider of providers) {
    const harness = getHarnessFor(provider);
    if (harness !== null) {
      harnessTargets.push({ provider, harness });
    } else {
      genericTargets.push(provider);
    }
  }

  const linkedAgents: string[] = [];
  const errors: string[] = [];
  const scope: HarnessScope = isGlobal
    ? { kind: 'global' }
    : { kind: 'project', projectDir: projectDir ?? process.cwd() };

  for (const { provider, harness } of harnessTargets) {
    try {
      await harness.installSkill(sourcePath, skillName, scope);
      linkedAgents.push(provider.id);
    } catch (err) {
      errors.push(`${provider.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let canonicalPath = '';
  if (genericTargets.length > 0) {
    // Preserve the legacy installer's default-argument contract when the
    // caller did not supply `projectDir`, so existing tests that assert
    // a 4-argument call shape keep passing.
    const genericResult =
      projectDir !== undefined
        ? await genericInstallSkill(sourcePath, skillName, genericTargets, isGlobal, projectDir)
        : await genericInstallSkill(sourcePath, skillName, genericTargets, isGlobal);
    canonicalPath = genericResult.canonicalPath;
    for (const id of genericResult.linkedAgents) {
      linkedAgents.push(id);
    }
    for (const err of genericResult.errors) {
      errors.push(err);
    }
  } else if (linkedAgents.length > 0) {
    canonicalPath = sourcePath;
  }

  return {
    name: skillName,
    canonicalPath,
    linkedAgents,
    errors,
    success: linkedAgents.length > 0,
  };
}

/**
 * Remove a skill across a mixed set of providers, dispatching each provider
 * to its {@link Harness} implementation when one exists and falling through
 * to the legacy canonical+symlink uninstaller for generic providers.
 *
 * @remarks
 * Harness `removeSkill` is idempotent; missing targets are silently tolerated
 * and reported as successfully removed. Exceptions raised by a harness are
 * captured in the returned `errors` array instead of propagating.
 *
 * @param skillName - Skill name to remove.
 * @param providers - Ordered list of target providers.
 * @param isGlobal - Whether to target global or project scope.
 * @param projectDir - Project directory used by the harness project scope
 *   and forwarded to the generic uninstaller when provided. When omitted,
 *   harness project scope falls back to `process.cwd()` and the generic
 *   uninstaller is invoked without a `projectDir` argument.
 * @returns Merged `{ removed, errors }` result across both dispatch paths.
 *
 * @example
 * ```typescript
 * const result = await dispatchRemoveSkillAcrossProviders(
 *   "my-skill",
 *   [getProvider("pi")!, getProvider("claude-code")!],
 *   true,
 * );
 * console.log(result.removed); // providers the skill was removed from
 * ```
 *
 * @public
 */
export async function dispatchRemoveSkillAcrossProviders(
  skillName: string,
  providers: Provider[],
  isGlobal: boolean,
  projectDir?: string,
): Promise<{ removed: string[]; errors: string[] }> {
  const harnessTargets: Array<{ provider: Provider; harness: Harness }> = [];
  const genericTargets: Provider[] = [];
  for (const provider of providers) {
    const harness = getHarnessFor(provider);
    if (harness !== null) {
      harnessTargets.push({ provider, harness });
    } else {
      genericTargets.push(provider);
    }
  }

  const removed: string[] = [];
  const errors: string[] = [];
  const scope: HarnessScope = isGlobal
    ? { kind: 'global' }
    : { kind: 'project', projectDir: projectDir ?? process.cwd() };

  for (const { provider, harness } of harnessTargets) {
    try {
      await harness.removeSkill(skillName, scope);
      removed.push(provider.id);
    } catch (err) {
      errors.push(`${provider.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Always invoke the generic uninstaller path — even with an empty generic
  // target list — to preserve the legacy contract that `removeSkill` is
  // called once per command invocation. This also ensures canonical-directory
  // cleanup always runs, which is crucial when no matching providers were
  // detected but the canonical copy still needs to be removed.
  const genericResult =
    projectDir !== undefined
      ? await genericRemoveSkill(skillName, genericTargets, isGlobal, projectDir)
      : await genericRemoveSkill(skillName, genericTargets, isGlobal);
  for (const id of genericResult.removed) {
    removed.push(id);
  }
  for (const err of genericResult.errors) {
    errors.push(err);
  }

  return { removed, errors };
}

export { PiHarness } from './pi.js';
export type {
  Harness,
  HarnessScope,
  SubagentHandle,
  SubagentResult,
  SubagentTask,
} from './types.js';
