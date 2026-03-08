import {
  buildSkillsMap,
  getEffectiveSkillsPaths,
  getProvidersBySkillsPrecedence,
  type ProviderSkillsCapability,
  type SkillsPrecedence,
} from '@cleocode/caamp';
import type { ResolvedSkillPath, SkillInstallationContext } from './precedence-types.js';

/**
 * Get effective skill paths for a provider considering precedence
 * @param providerId - The ID of the provider
 * @param scope - The scope ('global' or 'project')
 * @param projectRoot - Optional project root path for project-scoped resolution
 * @returns Array of resolved skill paths with precedence information
 * @throws Error if provider not found
 */
export async function resolveSkillPathsForProvider(
  providerId: string,
  scope: 'global' | 'project',
  projectRoot?: string,
): Promise<ResolvedSkillPath[]> {
  const { getProvider } = await import('@cleocode/caamp');
  const provider = getProvider(providerId);

  if (!provider) {
    throw new Error(`Provider ${providerId} not found`);
  }

  const paths = getEffectiveSkillsPaths(provider, scope, projectRoot);
  const skillsCap = (provider as { skills?: ProviderSkillsCapability }).skills;

  return paths.map((p) => ({
    path: p.path,
    source: p.source as 'vendor' | 'agents' | 'marketplace',
    scope: p.scope as 'global' | 'project',
    precedence: skillsCap?.precedence || 'vendor-only',
    providerId: provider.id,
  }));
}

/**
 * Get all providers that use a specific precedence mode
 * @param precedence - The precedence mode to filter by
 * @returns Array of provider IDs using the specified precedence
 */
export function getProvidersWithPrecedence(precedence: SkillsPrecedence): string[] {
  return getProvidersBySkillsPrecedence(precedence).map((p) => p.id);
}

/**
 * Build complete skills map with precedence information
 * @returns Array of provider skill configurations with precedence data
 */
export function getSkillsMapWithPrecedence(): Array<{
  providerId: string;
  toolName: string;
  precedence: SkillsPrecedence;
  paths: { global: string | null; project: string | null };
}> {
  return buildSkillsMap();
}

/**
 * Determine target installation paths for a skill
 * @param context - The installation context including target providers and project root
 * @returns Array of installation targets with provider ID and path
 */
export async function determineInstallationTargets(
  context: SkillInstallationContext,
): Promise<Array<{ providerId: string; path: string }>> {
  const targets: Array<{ providerId: string; path: string }> = [];

  for (const providerId of context.targetProviders) {
    const paths = await resolveSkillPathsForProvider(
      providerId,
      context.projectRoot ? 'project' : 'global',
      context.projectRoot,
    );

    // Take the first (highest precedence) path
    if (paths.length > 0) {
      targets.push({
        providerId,
        path: paths[0].path,
      });
    }
  }

  return targets;
}

/**
 * Check if provider supports agents path
 * @param providerId - The ID of the provider to check
 * @returns True if provider has agents path configuration
 */
export async function supportsAgentsPath(providerId: string): Promise<boolean> {
  const { getProviderCapabilities } = await import('@cleocode/caamp');
  const caps = getProviderCapabilities(providerId);

  if (!caps?.skills) return false;

  const skills = caps.skills as ProviderSkillsCapability;
  return skills.agentsGlobalPath !== null || skills.agentsProjectPath !== null;
}
