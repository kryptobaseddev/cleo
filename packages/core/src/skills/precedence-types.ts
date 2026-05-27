/**
 * Skills Precedence Types - Phase 3B of T5238
 *
 * Re-exports CAAMP precedence types and adds CLEO-specific wrapper types
 * for skill path resolution and installation context.
 *
 * These types complement the skill types in `./types.ts`:
 * - `./types.ts` defines the CLEO skill domain model (Skill, SkillFrontmatter, etc.)
 * - This file defines CAAMP precedence integration types used when resolving
 *   which skill version takes priority across providers and scopes.
 *
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

/** Configuration for skill precedence resolution across providers. */
export interface SkillsPrecedenceConfig {
  /** Default precedence mode when no provider-specific override exists. */
  defaultPrecedence?: SkillsPrecedence;
  /** Per-provider precedence overrides (provider ID -> precedence). */
  providerOverrides?: Record<string, SkillsPrecedence>;
}

/** A resolved skill path with full provenance metadata. */
export interface ResolvedSkillPath {
  /** Absolute filesystem path to the skill directory. */
  path: string;
  /** Where the skill was sourced from. */
  source: 'vendor' | 'agents' | 'marketplace';
  /** Whether this is a global or project-scoped skill. */
  scope: 'global' | 'project';
  /** The precedence mode that selected this path. */
  precedence: SkillsPrecedence;
  /** The provider that owns this skill path. */
  providerId: string;
}

/** Context for a skill installation operation. */
export interface SkillInstallationContext {
  /** Name of the skill being installed. */
  skillName: string;
  /** Source URL or path to install from. */
  source: string;
  /** Provider IDs to install the skill for. */
  targetProviders: string[];
  /** Precedence mode for the installation. */
  precedenceMode?: SkillsPrecedence;
  /** Project root for project-scoped installations. */
  projectRoot?: string;
}
