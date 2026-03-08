/**
 * Skills Precedence Types - Phase 3B of T5238
 * Re-exports CAAMP precedence types and adds CLEO-specific wrapper types.
 * @task T5238
 */

// Re-export all CAAMP precedence types
export type {
  ProviderSkillsCapability,
  SkillsPrecedence,
} from '@cleocode/caamp';

// Import CAAMP functions that CLEO will use
export {
  buildSkillsMap,
  getEffectiveSkillsPaths,
  getProvidersBySkillsPrecedence,
} from '@cleocode/caamp';

// CLEO-specific types for skills operations with precedence

import type { SkillsPrecedence } from '@cleocode/caamp';

export interface SkillsPrecedenceConfig {
  defaultPrecedence?: SkillsPrecedence;
  providerOverrides?: Record<string, SkillsPrecedence>;
}

export interface ResolvedSkillPath {
  path: string;
  source: 'vendor' | 'agents' | 'marketplace';
  scope: 'global' | 'project';
  precedence: SkillsPrecedence;
  providerId: string;
}

export interface SkillInstallationContext {
  skillName: string;
  source: string;
  targetProviders: string[];
  precedenceMode?: SkillsPrecedence;
  projectRoot?: string;
}
