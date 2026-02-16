/**
 * Skills Domain Operations (12 operations)
 *
 * Query operations: 6 (list, show, search, dispatch, verify, dependencies)
 * Mutate operations: 6 (install, uninstall, enable, disable, configure, refresh)
 *
 * @task T4387
 */

/**
 * Common skill types
 */
export type SkillCategory = 'core' | 'recommended' | 'specialist' | 'composition' | 'meta';
export type SkillStatus = 'active' | 'disabled' | 'deprecated' | 'missing';
export type DispatchStrategy = 'label' | 'type' | 'keyword' | 'fallback';

export interface SkillSummary {
  name: string;
  version: string;
  description: string;
  category: SkillCategory;
  core: boolean;
  tier: number;
  status: SkillStatus;
  protocol: string | null;
}

export interface SkillDetail extends SkillSummary {
  path: string;
  references: string[];
  dependencies: string[];
  sharedResources: string[];
  compatibility: string[];
  license: string;
  metadata: Record<string, unknown>;
  capabilities?: {
    inputs: string[];
    outputs: string[];
    dispatch_triggers: string[];
    compatible_subagent_types: string[];
    chains_to: string[];
    dispatch_keywords: {
      primary: string[];
      secondary: string[];
    };
  };
  constraints?: {
    max_context_tokens: number;
    requires_session: boolean;
    requires_epic: boolean;
  };
}

export interface DispatchCandidate {
  skill: string;
  score: number;
  strategy: DispatchStrategy;
  reason: string;
}

export interface DependencyNode {
  name: string;
  version: string;
  direct: boolean;
  depth: number;
}

export interface ValidationIssue {
  level: 'error' | 'warn';
  field: string;
  message: string;
}

/**
 * Query Operations
 */

// skills.list
export interface SkillsListParams {
  category?: SkillCategory;
  core?: boolean;
  filter?: string;
}
export type SkillsListResult = SkillSummary[];

// skills.show
export interface SkillsShowParams {
  name: string;
}
export type SkillsShowResult = SkillDetail;

// skills.search
export interface SkillsSearchParams {
  query: string;
  limit?: number;
}
export interface SkillsSearchResult {
  query: string;
  results: Array<SkillSummary & { score: number; matchReason: string }>;
}

// skills.dispatch
export interface SkillsDispatchParams {
  taskId?: string;
  taskType?: string;
  labels?: string[];
  title?: string;
  description?: string;
}
export interface SkillsDispatchResult {
  selectedSkill: string;
  reason: string;
  strategy: DispatchStrategy;
  candidates: DispatchCandidate[];
}

// skills.verify
export interface SkillsVerifyParams {
  name?: string;
}
export interface SkillsVerifyResult {
  valid: boolean;
  total: number;
  passed: number;
  failed: number;
  results: Array<{
    name: string;
    valid: boolean;
    issues: ValidationIssue[];
  }>;
}

// skills.dependencies
export interface SkillsDependenciesParams {
  name: string;
  transitive?: boolean;
}
export interface SkillsDependenciesResult {
  name: string;
  dependencies: DependencyNode[];
  resolved: string[];
}

/**
 * Mutate Operations
 */

// skills.install
export interface SkillsInstallParams {
  name: string;
  source?: string;
}
export interface SkillsInstallResult {
  name: string;
  installed: boolean;
  version: string;
  path: string;
}

// skills.uninstall
export interface SkillsUninstallParams {
  name: string;
  force?: boolean;
}
export interface SkillsUninstallResult {
  name: string;
  uninstalled: boolean;
}

// skills.enable
export interface SkillsEnableParams {
  name: string;
}
export interface SkillsEnableResult {
  name: string;
  enabled: boolean;
  status: SkillStatus;
}

// skills.disable
export interface SkillsDisableParams {
  name: string;
  reason?: string;
}
export interface SkillsDisableResult {
  name: string;
  disabled: boolean;
  status: SkillStatus;
}

// skills.configure
export interface SkillsConfigureParams {
  name: string;
  config: Record<string, unknown>;
}
export interface SkillsConfigureResult {
  name: string;
  configured: boolean;
  config: Record<string, unknown>;
}

// skills.refresh
export interface SkillsRefreshParams {
  force?: boolean;
}
export interface SkillsRefreshResult {
  refreshed: boolean;
  skillCount: number;
  timestamp: string;
}
