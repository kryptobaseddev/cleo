/**
 * Type definitions for the skills system.
 * Re-exports overlapping CAAMP types for downstream consumers.
 * @epic T4454
 * @task T4516
 */

// Re-export CAAMP types where they overlap with CLEO's domain
export type {
  Provider,
  SkillMetadata as CaampSkillMetadata,
  McpServerConfig,
  CtSkillEntry,
  CtDispatchMatrix,
  CtManifest,
  CtManifestSkill,
  CtProfileDefinition,
  CtValidationResult,
  CtValidationIssue,
} from '@cleocode/caamp';

// ============================================================================
// Skill Types
// ============================================================================

/** Skill frontmatter parsed from SKILL.md YAML header. */
export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  triggers?: string[];
  dispatchPriority?: number;
  model?: string;
  allowedTools?: string[];
  invocable?: boolean;
  command?: string;
  protocol?: SkillProtocolType;
}

/** Skill definition loaded from disk. */
export interface Skill {
  name: string;
  dirName: string;
  path: string;
  skillMdPath: string;
  frontmatter: SkillFrontmatter;
  content?: string;
}

/** Lightweight skill summary for manifest/listing. */
export interface SkillSummary {
  name: string;
  dirName: string;
  description: string;
  tags: string[];
  version: string;
  invocable: boolean;
  command?: string;
  protocol?: SkillProtocolType;
}

/** Skill manifest (cached aggregate of all discovered skills). */
export interface SkillManifest {
  _meta: {
    generatedAt: string;
    ttlSeconds: number;
    skillCount: number;
    searchPaths: string[];
  };
  skills: SkillSummary[];
}

// ============================================================================
// Protocol Types
// ============================================================================

/** RCSD-IVTR protocol types. */
export type SkillProtocolType =
  | 'research'
  | 'consensus'
  | 'specification'
  | 'decomposition'
  | 'implementation'
  | 'contribution'
  | 'release'
  | 'artifact-publish'
  | 'provenance';

// ============================================================================
// Agent Types
// ============================================================================

/** Agent configuration from AGENT.md or agent definition. */
export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  allowedTools?: string[];
  customInstructions?: string;
}

/** Agent registry entry. */
export interface AgentRegistryEntry {
  name: string;
  path: string;
  config: AgentConfig;
  installedAt: string;
}

/** Agent registry (persisted). */
export interface AgentRegistry {
  _meta: {
    version: string;
    lastUpdated: string;
  };
  agents: AgentRegistryEntry[];
}

// ============================================================================
// Skill Search Path Types
// ============================================================================

/** CAAMP search order for skill discovery. */
export type SkillSearchScope =
  | 'cleo-home'       // ~/.cleo/skills/
  | 'agent-skills'    // ~/.claude/skills/ (Claude Code native)
  | 'app-embedded'    // <project>/skills/
  | 'marketplace'     // Remote marketplace cache
  | 'project-custom'; // <project>/.cleo/skills/

/** Ordered search path entry. */
export interface SkillSearchPath {
  scope: SkillSearchScope;
  path: string;
  priority: number;
}

// ============================================================================
// Dispatch Types
// ============================================================================

/** Dispatch strategy for skill selection. */
export type DispatchStrategy = 'label' | 'type' | 'keyword' | 'fallback';

/** Dispatch result from skill_auto_dispatch. */
export interface DispatchResult {
  skill: string;
  strategy: DispatchStrategy;
  confidence: number;
  protocol?: SkillProtocolType;
}

// ============================================================================
// Token Injection Types
// ============================================================================

/** Token definition from placeholders.json. */
export interface TokenDefinition {
  token: string;
  description?: string;
  required?: boolean;
  default?: string;
  pattern?: string;
}

/** Token validation result. */
export interface TokenValidationResult {
  valid: boolean;
  token: string;
  value?: string;
  error?: string;
}

/** Token injection context. */
export interface TokenContext {
  taskId: string;
  date: string;
  topicSlug: string;
  epicId?: string;
  sessionId?: string;
  outputDir?: string;
  manifestPath?: string;
  [key: string]: string | undefined;
}

// ============================================================================
// Orchestrator Types
// ============================================================================

/** Orchestrator context thresholds. */
export interface OrchestratorThresholds {
  warning: number;
  critical: number;
}

/** Pre-spawn check result. */
export interface PreSpawnCheckResult {
  canSpawn: boolean;
  spawnStatus: 'ok' | 'warning' | 'stale' | 'blocked';
  recommendation: 'continue' | 'wrap_up' | 'stop' | 'verify_compliance';
  context: {
    percentage: number;
    currentTokens: number;
    maxTokens: number;
    warningThreshold: number;
    criticalThreshold: number;
    status: string;
    stale: boolean;
  };
  reasons: Array<{ code: string; message: string }>;
  taskValidation?: {
    exists: boolean;
    taskId: string;
    status?: string;
    title?: string;
    spawnable: boolean;
  } | null;
  complianceValidation?: Record<string, unknown> | null;
}

/** Spawn prompt result. */
export interface SpawnPromptResult {
  taskId: string;
  template: string;
  topicSlug: string;
  date: string;
  outputDir: string;
  outputFile: string;
  prompt: string;
}

/** Dependency wave for parallel execution. */
export interface DependencyWave {
  wave: number;
  tasks: Array<{
    id: string;
    title: string;
    priority?: string;
    status: string;
    depends: string[];
  }>;
}

/** Dependency analysis result. */
export interface DependencyAnalysis {
  epicId: string;
  totalTasks: number;
  completedTasks: number;
  pendingTasks: number;
  activeTasks: number;
  waves: DependencyWave[];
  readyToSpawn: Array<{
    id: string;
    title: string;
    priority?: string;
    wave: number;
  }>;
  blockedTasks: Array<{
    id: string;
    title: string;
    depends: string[];
    wave: number;
  }>;
}

/** HITL summary for session handoff. */
export interface HitlSummary {
  timestamp: string;
  stopReason: string;
  session: {
    id: string | null;
    epicId: string | null;
    focusedTask: string | null;
    progressNote: string | null;
  };
  progress: {
    completed: number;
    pending: number;
    active: number;
    blocked: number;
    total: number;
    percentComplete: number;
  };
  completedTasks: Array<{ id: string; title: string }>;
  remainingTasks: Array<{ id: string; title: string; status: string; priority?: string }>;
  readyToSpawn: Array<{ id: string; title: string; priority?: string }>;
  handoff: {
    resumeCommand: string;
    nextSteps: string[];
  };
}

// ============================================================================
// Manifest Types
// ============================================================================

/** Research manifest entry (MANIFEST.jsonl). */
export interface ManifestEntry {
  id: string;
  file: string;
  title: string;
  date: string;
  status: 'complete' | 'partial' | 'blocked' | 'archived';
  agent_type?: string;
  topics: string[];
  key_findings: string[];
  actionable: boolean;
  needs_followup: string[];
  linked_tasks?: string[];
  audit?: Record<string, unknown>;
}

/** Manifest validation result. */
export interface ManifestValidationResult {
  exists: boolean;
  passed: boolean;
  stats?: {
    totalLines: number;
    validEntries: number;
    invalidEntries: number;
  };
  issues: string[];
}

// ============================================================================
// Compliance Types
// ============================================================================

/** Compliance verification result. */
export interface ComplianceResult {
  previousTaskId: string;
  researchId: string | null;
  checks: {
    manifestEntryExists: boolean;
    researchLinkedToTask: boolean;
    returnStatusValid: boolean | null;
  };
  canSpawnNext: boolean;
  violations: string[];
  warnings: string[];
}

// ============================================================================
// Skill Install Types
// ============================================================================

/** Installed skill tracking. */
export interface InstalledSkill {
  name: string;
  version: string;
  installedAt: string;
  sourcePath: string;
  symlinkPath: string;
}

/** Installed skills file. */
export interface InstalledSkillsFile {
  _meta: {
    version: string;
    lastUpdated: string;
  };
  skills: Record<string, InstalledSkill>;
}

// ============================================================================
// Skill Name Mapping
// ============================================================================

/** Canonical skill name mapping (user-friendly to ct-prefixed). */
export const SKILL_NAME_MAP: Record<string, string> = {
  // Task execution
  'TASK-EXECUTOR': 'ct-task-executor',
  'task-executor': 'ct-task-executor',
  'ct-task-executor': 'ct-task-executor',
  'EXECUTOR': 'ct-task-executor',
  'executor': 'ct-task-executor',

  // Research
  'RESEARCH-AGENT': 'ct-research-agent',
  'research-agent': 'ct-research-agent',
  'ct-research-agent': 'ct-research-agent',
  'RESEARCH': 'ct-research-agent',
  'research': 'ct-research-agent',

  // Epic architect
  'EPIC-ARCHITECT': 'ct-epic-architect',
  'epic-architect': 'ct-epic-architect',
  'ct-epic-architect': 'ct-epic-architect',
  'ARCHITECT': 'ct-epic-architect',
  'architect': 'ct-epic-architect',

  // Spec writer
  'SPEC-WRITER': 'ct-spec-writer',
  'spec-writer': 'ct-spec-writer',
  'ct-spec-writer': 'ct-spec-writer',
  'SPEC': 'ct-spec-writer',
  'spec': 'ct-spec-writer',

  // Test writer
  'TEST-WRITER-BATS': 'ct-test-writer-bats',
  'test-writer-bats': 'ct-test-writer-bats',
  'ct-test-writer-bats': 'ct-test-writer-bats',
  'TEST-WRITER': 'ct-test-writer-bats',
  'test-writer': 'ct-test-writer-bats',
  'BATS': 'ct-test-writer-bats',
  'bats': 'ct-test-writer-bats',

  // Library implementer
  'LIBRARY-IMPLEMENTER-BASH': 'ct-library-implementer-bash',
  'library-implementer-bash': 'ct-library-implementer-bash',
  'ct-library-implementer-bash': 'ct-library-implementer-bash',
  'LIB-IMPLEMENTER': 'ct-library-implementer-bash',
  'lib-implementer': 'ct-library-implementer-bash',
  'BASH-LIB': 'ct-library-implementer-bash',
  'bash-lib': 'ct-library-implementer-bash',

  // Validator
  'VALIDATOR': 'ct-validator',
  'validator': 'ct-validator',
  'ct-validator': 'ct-validator',
  'VALIDATE': 'ct-validator',
  'validate': 'ct-validator',

  // Documentor
  'DOCUMENTOR': 'ct-documentor',
  'documentor': 'ct-documentor',
  'ct-documentor': 'ct-documentor',
  'DOCS': 'ct-documentor',
  'docs': 'ct-documentor',

  // Docs sub-skills
  'DOCS-LOOKUP': 'ct-docs-lookup',
  'docs-lookup': 'ct-docs-lookup',
  'ct-docs-lookup': 'ct-docs-lookup',
  'DOCS-WRITE': 'ct-docs-write',
  'docs-write': 'ct-docs-write',
  'ct-docs-write': 'ct-docs-write',
  'DOCS-REVIEW': 'ct-docs-review',
  'docs-review': 'ct-docs-review',
  'ct-docs-review': 'ct-docs-review',

  // Skill management
  'SKILL-CREATOR': 'ct-skill-creator',
  'skill-creator': 'ct-skill-creator',
  'ct-skill-creator': 'ct-skill-creator',
  'SKILL-LOOKUP': 'ct-skill-lookup',
  'skill-lookup': 'ct-skill-lookup',
  'ct-skill-lookup': 'ct-skill-lookup',

  // Orchestrator
  'ORCHESTRATOR': 'ct-orchestrator',
  'orchestrator': 'ct-orchestrator',
  'ct-orchestrator': 'ct-orchestrator',
};
