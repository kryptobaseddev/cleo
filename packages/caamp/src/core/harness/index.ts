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
import { getInstalledProviders } from '../registry/detection.js';
import { getAllProviders, getPrimaryProvider } from '../registry/providers.js';
import {
  installSkill as genericInstallSkill,
  removeSkill as genericRemoveSkill,
  type SkillInstallResult,
} from '../skills/installer.js';
import { PiHarness } from './pi.js';
import type { Harness, HarnessScope } from './types.js';

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
 * `--agent`.
 *
 * @remarks
 * Resolution policy:
 *
 * 1. If the registry's primary harness (the provider with
 *    `priority === "primary"`) is installed on the current system,
 *    return `[primaryProvider]` so that commands dispatch to the
 *    primary harness by default.
 * 2. Otherwise, return the set of installed providers at priority
 *    `"primary"` or `"high"`. This restores the legacy "detected high-tier
 *    providers" fallback that CAAMP has always used when no primary
 *    harness is available.
 * 3. If the priority filter yields an empty list (e.g. in tests that stub
 *    providers without a `priority` field, or in fresh installs with only
 *    medium/low-tier providers detected), fall back to the full installed
 *    provider list so that commands retain a valid target.
 *
 * This helper is intentionally defensive: it swallows registry-related
 * exceptions (returning an empty-primary-harness result) so stubbed test
 * environments that do not wire the full provider registry still behave
 * sensibly.
 *
 * @returns Ordered list of providers to target by default.
 *
 * @example
 * ```typescript
 * const targets = resolveDefaultTargetProviders();
 * if (targets.length === 0) {
 *   console.error("No target providers found. Use --agent or --all.");
 * }
 * ```
 *
 * @public
 */
export function resolveDefaultTargetProviders(): Provider[] {
  let primary: Harness | null = null;
  try {
    primary = getPrimaryHarness();
  } catch {
    primary = null;
  }

  const installed = getInstalledProviders();

  if (primary !== null) {
    const primaryId = primary.provider.id;
    const primaryInstalled = installed.some((p) => p.id === primaryId);
    if (primaryInstalled) {
      return [primary.provider];
    }
  }

  const highTier = installed.filter(
    (provider) => provider.priority === 'primary' || provider.priority === 'high',
  );
  if (highTier.length > 0) {
    return highTier;
  }
  return installed;
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
