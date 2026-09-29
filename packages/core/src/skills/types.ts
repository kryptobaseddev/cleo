/**
 * Type definitions for the skills system.
 *
 * ## Dual Type System: CAAMP vs CLEO Skills
 *
 * The skill type system has two layers reflecting the CAAMP/CLEO split:
 *
 * ### CAAMP types (re-exported as `CaampSkillMetadata`, `CtSkillEntry`, etc.)
 * - Defined in `@cleocode/caamp` -- the cross-agent skill standard.
 * - **`CaampSkillMetadata`**: Minimal metadata parsed from SKILL.md YAML header
 *   by CAAMP's `parseSkillFile()`. Contains: name, description, version, license,
 *   compatibility, metadata, allowedTools.
 * - **`CtSkillEntry`**: A discovered skill with location + metadata. Used by CAAMP's
 *   discovery and install pipeline.
 * - Use CAAMP types when interacting with CAAMP APIs (skill discovery, install,
 *   provider lock files, skill precedence resolution).
 *
 * ### CLEO types (`Skill`, `SkillFrontmatter`, `SkillSummary`, `SkillManifest`)
 * - Defined here -- CLEO's extended skill domain model.
 * - **`SkillFrontmatter`**: Superset of CaampSkillMetadata. Adds CLEO-specific
 *   fields: tags, triggers, dispatchPriority, model, invocable, command, protocol.
 *   Parsed by CLEO's own SKILL.md reader with richer YAML support.
 * - **`Skill`**: Full in-memory skill object with filesystem paths and parsed content.
 * - **`SkillSummary`**: Lightweight projection for listings (cached in SkillManifest).
 * - Use CLEO types for skill dispatch, orchestration, CLI display, and manifest caching.
 *
 * ### Relationship
 * - `SkillFrontmatter` is a functional superset of `CaampSkillMetadata`:
 *   every field in CaampSkillMetadata exists in SkillFrontmatter (name, description,
 *   version, allowedTools). SkillFrontmatter adds CLEO-specific extension fields.
 * - A `Skill` (CLEO) wraps a `SkillFrontmatter` with filesystem context, whereas
 *   a `CtSkillEntry` (CAAMP) wraps a `CaampSkillMetadata` with install metadata.
 * - When converting between layers, map `CaampSkillMetadata` -> `SkillFrontmatter`
 *   (all CAAMP fields carry over; CLEO-specific fields default to undefined).
 *
 * @epic T4454
 * @task T4516
 */

import type { TaskRef, TaskRefPriority } from '@cleocode/contracts';

// Re-export CAAMP types where they overlap with CLEO's domain.
// See module JSDoc above for guidance on which type to use where.
export type {
  CtDispatchMatrix,
  CtManifest,
  CtManifestSkill,
  CtProfileDefinition,
  CtSkillEntry,
  CtValidationIssue,
  CtValidationResult,
  McpServerConfig,
  Provider,
  SkillMetadata as CaampSkillMetadata,
} from '@cleocode/caamp';

// ============================================================================
// Skill Types
// ============================================================================

/**
 * Skill frontmatter parsed from SKILL.md YAML header.
 *
 * This is CLEO's extended skill metadata -- a functional superset of CAAMP's
 * `SkillMetadata`. All fields from `CaampSkillMetadata` (name, description,
 * version, allowedTools) are present here. CLEO adds: tags, triggers,
 * dispatchPriority, model, invocable, command, protocol.
 *
 * Use this type when working with CLEO's skill loading, dispatch, and
 * orchestration systems. Use `CaampSkillMetadata` when interfacing directly
 * with CAAMP's discovery/install APIs.
 */
export interface SkillFrontmatter {
  /** Skill name (lowercase, hyphens). Maps to CaampSkillMetadata.name. */
  name: string;
  /** Human-readable description. Maps to CaampSkillMetadata.description. */
  description: string;
  /** Semantic version string. Maps to CaampSkillMetadata.version. */
  version?: string;
  /** Skill author (CLEO extension). */
  author?: string;
  /** Classification tags for search/filter (CLEO extension). */
  tags?: string[];
  /** Trigger patterns for auto-dispatch (CLEO extension). */
  triggers?: string[];
  /** Priority for dispatch selection (CLEO extension). */
  dispatchPriority?: number;
  /** Preferred LLM model (CLEO extension). */
  model?: string;
  /** Allowed tool names. Maps to CaampSkillMetadata.allowedTools. */
  allowedTools?: string[];
  /** Whether the skill can be invoked directly (CLEO extension). */
  invocable?: boolean;
  /** CLI command for direct invocation (CLEO extension). */
  command?: string;
  /** RCASD-IVTR+C protocol type (CLEO extension). */
  protocol?: SkillProtocolType;
}

/**
 * Skill definition loaded from disk.
 *
 * CLEO-specific type that wraps a {@link SkillFrontmatter} with filesystem
 * context. For CAAMP's equivalent, see `CtSkillEntry` which wraps
 * `CaampSkillMetadata` with install/discovery metadata instead.
 */
export interface Skill {
  name: string;
  dirName: string;
  path: string;
  skillMdPath: string;
  frontmatter: SkillFrontmatter;
  content?: string;
  /**
   * `bundled` when the skill is not installed and was read from the
   * `@cleocode/skills` package (only via `findSkill(..., { includeBundled })`).
   * Absent for installed skills.
   *
   * @task T12646
   */
  source?: 'bundled';
}

/**
 * Options for `findSkill`.
 *
 * @task T12646
 */
export interface FindSkillOptions {
  /**
   * Fall back to the copy bundled in `@cleocode/skills` when no search path
   * holds the skill (honoured only in the default `CLEO_SKILL_SOURCE=auto`
   * mode). Off by default: callers that ROUTE on "is this skill installed?"
   * — playbook skill nodes, the skill executor — keep their meaning. Prompt
   * builders that only need the protocol text opt in.
   */
  includeBundled?: boolean;
}

/**
 * Lightweight skill summary for manifest/listing.
 *
 * Projected from {@link Skill} for efficient caching in {@link SkillManifest}.
 * Contains only the fields needed for CLI display and dispatch selection.
 */
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

/** RCASD-IVTR+C protocol types. */
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
  | 'cleo-home' // ~/.cleo/skills/
  | 'agent-skills' // ~/.claude/skills/ (Claude Code native)
  | 'app-embedded' // <project>/skills/
  | 'marketplace' // Remote marketplace cache
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
  completedTasks: Array<Pick<TaskRef, 'id' | 'title'>>;
  remainingTasks: Array<TaskRef & { priority?: string }>;
  readyToSpawn: TaskRefPriority[];
  handoff: {
    resumeCommand: string;
    nextSteps: string[];
  };
}

// ============================================================================
// Manifest Types
// ============================================================================

/** Research manifest entry (pipeline_manifest table; see ADR-027). */
export interface ManifestEntry {
  id: string;
  file: string;
  title: string;
  date: string;
  status: 'completed' | 'partial' | 'blocked' | 'archived';
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

/**
 * Canonical skill name mapping (user-friendly to ct-prefixed).
 *
 * Every value MUST be a harness-installed skill (`metadata.install: harness`
 * under packages/skills/skills) — scripts/lint-emitted-skills.mjs (gate 30)
 * fails otherwise. T12653 removed three targets that never existed
 * (ct-test-writer-bats, ct-library-implementer-bash, ct-skill-lookup) and the
 * internal ct-skill-creator, which no harness receives (D11157).
 */
export const SKILL_NAME_MAP: Record<string, string> = {
  // Task execution
  'TASK-EXECUTOR': 'ct-task-executor',
  'task-executor': 'ct-task-executor',
  'ct-task-executor': 'ct-task-executor',
  EXECUTOR: 'ct-task-executor',
  executor: 'ct-task-executor',

  // Research
  'RESEARCH-AGENT': 'ct-research-agent',
  'research-agent': 'ct-research-agent',
  'ct-research-agent': 'ct-research-agent',
  RESEARCH: 'ct-research-agent',
  research: 'ct-research-agent',

  // Epic architect
  'EPIC-ARCHITECT': 'ct-epic-architect',
  'epic-architect': 'ct-epic-architect',
  'ct-epic-architect': 'ct-epic-architect',
  ARCHITECT: 'ct-epic-architect',
  architect: 'ct-epic-architect',

  // Spec writer
  'SPEC-WRITER': 'ct-spec-writer',
  'spec-writer': 'ct-spec-writer',
  'ct-spec-writer': 'ct-spec-writer',
  SPEC: 'ct-spec-writer',
  spec: 'ct-spec-writer',

  // Validator
  VALIDATOR: 'ct-validator',
  validator: 'ct-validator',
  'ct-validator': 'ct-validator',
  VALIDATE: 'ct-validator',
  validate: 'ct-validator',

  // Documentor
  DOCUMENTOR: 'ct-documentor',
  documentor: 'ct-documentor',
  'ct-documentor': 'ct-documentor',
  DOCS: 'ct-documentor',
  docs: 'ct-documentor',

  // Docs writing/review guides live in ct-documentor since T12649 (D11157);
  // ct-docs-lookup was retired (use the Context7 MCP).
  'DOCS-WRITE': 'ct-documentor',
  'docs-write': 'ct-documentor',
  'ct-docs-write': 'ct-documentor',
  'DOCS-REVIEW': 'ct-documentor',
  'docs-review': 'ct-documentor',
  'ct-docs-review': 'ct-documentor',

  // Orchestrator
  ORCHESTRATOR: 'ct-orchestrator',
  orchestrator: 'ct-orchestrator',
  'ct-orchestrator': 'ct-orchestrator',
};
