/**
 * SkillsMP (Skills Marketplace) integration.
 * Delegates to @cleocode/caamp MarketplaceClient for core marketplace operations.
 *
 * @epic T4454
 * @task T4521
 */

import {
  MarketplaceClient,
  searchSkills as caampSearchSkills,
} from '@cleocode/caamp';
import type { MarketplaceResult } from '@cleocode/caamp';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../paths.js';

// ============================================================================
// Configuration
// ============================================================================

/** SkillsMP configuration. */
export interface SkillsMpConfig {
  enabled: boolean;
  cacheDir: string;
}

/** Marketplace skill result (CLEO-specific shape). */
export interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  downloadUrl?: string;
}

/**
 * Load SkillsMP configuration from skillsmp.json.
 * @task T4521
 */
export function loadConfig(cwd?: string): SkillsMpConfig | null {
  const projectRoot = getProjectRoot(cwd);
  const configFile = join(projectRoot, '.cleo', 'skillsmp.json');

  if (!existsSync(configFile)) return null;

  try {
    const data = JSON.parse(readFileSync(configFile, 'utf-8'));
    if (data.enabled !== true) return null;

    return {
      enabled: true,
      cacheDir: (data.cacheDir as string) ?? '',
    };
  } catch {
    return null;
  }
}

// ============================================================================
// API Operations (delegated to CAAMP)
// ============================================================================

/**
 * Convert a CAAMP MarketplaceResult to CLEO's MarketplaceSkill interface.
 */
function toMarketplaceSkill(result: MarketplaceResult): MarketplaceSkill {
  return {
    id: result.scopedName,
    name: result.name,
    description: result.description,
    version: '0.0.0', // MarketplaceResult does not carry version
    author: result.author,
    tags: result.source ? [result.source] : [],
    downloadUrl: result.githubUrl,
  };
}

/**
 * Search the skills marketplace.
 * Delegates to CAAMP's searchSkills for the actual API call.
 * @task T4521
 */
export async function searchSkills(
  query: string,
  _config?: SkillsMpConfig,
): Promise<MarketplaceSkill[]> {
  try {
    const results: MarketplaceResult[] = await caampSearchSkills(query);
    return results.map(toMarketplaceSkill);
  } catch {
    return [];
  }
}

/**
 * Get a specific skill from the marketplace.
 * Uses CAAMP's MarketplaceClient for retrieval.
 * @task T4521
 */
export async function getSkill(
  skillId: string,
  _config?: SkillsMpConfig,
): Promise<MarketplaceSkill | null> {
  try {
    const client = new MarketplaceClient();
    const result = await client.getSkill(skillId);
    if (!result) return null;
    return toMarketplaceSkill(result);
  } catch {
    return null;
  }
}

/**
 * Check if the marketplace is enabled and reachable.
 * @task T4521
 */
export function isEnabled(cwd?: string): boolean {
  const config = loadConfig(cwd);
  return config?.enabled === true;
}
