/**
 * Pipeline Stage Definitions and Transitions
 *
 * Defines the 9-stage RCASD-IVTR pipeline with stage metadata,
 * transition rules, and prerequisite mappings.
 *
 * Stages (in order):
 *   1. Research              - Information gathering and exploration
 *   2. Consensus             - Multi-agent decisions and validation
 *   3. Architecture Decision - Architecture Decision Records
 *   4. Specification         - Specification and documentation
 *   5. Decomposition         - Task breakdown and planning
 *   6. Implementation        - Code execution and building
 *   7. Validation            - Static analysis, type checking, quality gates
 *   8. Testing               - Test execution and coverage
 *   9. Release               - Version management and publishing
 *
 * @task T4800 - Implement Canonical SQLite Pipeline State Machine
 * @epic T4798 - Lifecycle persistence improvements
 * @audit T4799 - Unified stage names (replaces scattered definitions)
 *
 * NOTE: This file provides the canonical stage definitions. All other
 * stage definitions in the codebase should reference these.
 * Stage names MUST match the DB CHECK constraint in lifecycle_stages.stage_name.
 */

// =============================================================================
// STAGE TYPE DEFINITIONS
// =============================================================================

/**
 * Canonical pipeline stages in execution order.
 *
 * This is the single source of truth for stage names across CLEO.
 * All other stage arrays should be derived from this.
 * Names match the SQLite CHECK constraint on lifecycle_stages.stage_name.
 *
 * @task T4800
 * @audit T4799 - Consolidates: RCSD_STAGES, EXECUTION_STAGES, ENGINE_LIFECYCLE_STAGES
 */
import type { StageStatus } from '../../store/status-registry.js';

export const PIPELINE_STAGES = [
  'research',
  'consensus',
  'architecture_decision',
  'specification',
  'decomposition',
  'implementation',
  'validation',
  'testing',
  'release',
] as const;

/**
 * Cross-cutting contribution stage.
 * Not part of the pipeline execution order, but tracked in the schema
 * for attribution and provenance recording.
 *
 * @task T4800
 */
export const CONTRIBUTION_STAGE = 'contribution' as const;

/**
 * Stage type derived from canonical stage list.
 *
 * @task T4800
 */
export type Stage = typeof PIPELINE_STAGES[number];

/**
 * Stage status values.
 *
 * @task T4800
 * @audit T4799 - Unifies: StageStatus, EngineStageStatus
 */
// ADR-018: StageStatus is the canonical type from the status registry.
export type { StageStatus };

/**
 * Stage category for grouping related stages.
 *
 * @task T4800
 */
export type StageCategory = 'planning' | 'decision' | 'execution' | 'validation' | 'delivery';

/**
 * Stage metadata with descriptive information.
 *
 * @task T4800
 */
export interface StageDefinition {
  /** Stage identifier */
  stage: Stage;

  /** Display name for the stage */
  name: string;

  /** Detailed description of what happens in this stage */
  description: string;

  /** Execution order (1-based) */
  order: number;

  /** Category for grouping */
  category: StageCategory;

  /** Whether this stage can be skipped */
  skippable: boolean;

  /** Default timeout in hours (null = no timeout) */
  defaultTimeoutHours: number | null;

  /** Required gate checks before completing this stage */
  requiredGates: string[];

  /** Expected artifacts produced by this stage */
  expectedArtifacts: string[];
}

// =============================================================================
// CANONICAL STAGE DEFINITIONS
// =============================================================================

/**
 * Canonical stage definitions with complete metadata.
 *
 * @task T4800
 * @audit T4799 - Replaces legacy STAGE_DEFINITIONS from index.ts
 */
export const STAGE_DEFINITIONS: Record<Stage, StageDefinition> = {
  research: {
    stage: 'research',
    name: 'Research',
    description: 'Information gathering, exploration, and knowledge acquisition',
    order: 1,
    category: 'planning',
    skippable: false,
    defaultTimeoutHours: 48,
    requiredGates: ['prerequisites-met'],
    expectedArtifacts: ['research-report', 'findings-document'],
  },
  consensus: {
    stage: 'consensus',
    name: 'Consensus',
    description: 'Multi-agent decision making and validation of research findings',
    order: 2,
    category: 'decision',
    skippable: true,
    defaultTimeoutHours: 24,
    requiredGates: ['research-complete', 'agreement-reached'],
    expectedArtifacts: ['consensus-record', 'decision-log'],
  },
  architecture_decision: {
    stage: 'architecture_decision',
    name: 'Architecture Decision',
    description: 'Architecture Decision Records - documenting significant technical decisions',
    order: 3,
    category: 'decision',
    skippable: true,
    defaultTimeoutHours: 24,
    requiredGates: ['decisions-documented', 'review-completed'],
    expectedArtifacts: ['adr-document'],
  },
  specification: {
    stage: 'specification',
    name: 'Specification',
    description: 'Specification writing - RFC-style documentation of requirements and design',
    order: 4,
    category: 'planning',
    skippable: false,
    defaultTimeoutHours: 72,
    requiredGates: ['spec-complete', 'spec-reviewed'],
    expectedArtifacts: ['spec-document', 'api-spec', 'design-doc'],
  },
  decomposition: {
    stage: 'decomposition',
    name: 'Decomposition',
    description: 'Task breakdown - splitting work into atomic, executable tasks',
    order: 5,
    category: 'planning',
    skippable: false,
    defaultTimeoutHours: 24,
    requiredGates: ['tasks-created', 'dependencies-mapped'],
    expectedArtifacts: ['task-breakdown', 'dependency-graph'],
  },
  implementation: {
    stage: 'implementation',
    name: 'Implementation',
    description: 'Implementation - writing code and building features',
    order: 6,
    category: 'execution',
    skippable: false,
    defaultTimeoutHours: null, // Varies by task size
    requiredGates: ['code-complete', 'lint-passing'],
    expectedArtifacts: ['source-code', 'implementation-notes'],
  },
  validation: {
    stage: 'validation',
    name: 'Validation',
    description: 'Verification - static analysis, type checking, and quality gates',
    order: 7,
    category: 'validation',
    skippable: false,
    defaultTimeoutHours: 12,
    requiredGates: ['static-analysis-pass', 'type-check-pass'],
    expectedArtifacts: ['verification-report'],
  },
  testing: {
    stage: 'testing',
    name: 'Testing',
    description: 'Testing - running test suites and ensuring coverage',
    order: 8,
    category: 'validation',
    skippable: false,
    defaultTimeoutHours: 24,
    requiredGates: ['tests-pass', 'coverage-met'],
    expectedArtifacts: ['test-results', 'coverage-report'],
  },
  release: {
    stage: 'release',
    name: 'Release',
    description: 'Release - versioning, publishing, and deployment',
    order: 9,
    category: 'delivery',
    skippable: true,
    defaultTimeoutHours: 4,
    requiredGates: ['version-bumped', 'changelog-updated', 'artifacts-published'],
    expectedArtifacts: ['version-tag', 'release-notes', 'published-package'],
  },
};

// =============================================================================
// STAGE ORDER AND INDEXING
// =============================================================================

/**
 * Stage order mapping for quick lookups.
 *
 * @task T4800
 */
export const STAGE_ORDER: Record<Stage, number> = {
  research: 1,
  consensus: 2,
  architecture_decision: 3,
  specification: 4,
  decomposition: 5,
  implementation: 6,
  validation: 7,
  testing: 8,
  release: 9,
};

/**
 * Get the order/index of a stage (1-based).
 *
 * @param stage - The stage to look up
 * @returns The stage order (1-9)
 *
 * @task T4800
 */
export function getStageOrder(stage: Stage): number {
  return STAGE_ORDER[stage];
}

/**
 * Check if stage A comes before stage B in the pipeline.
 *
 * @param stageA - First stage to compare
 * @param stageB - Second stage to compare
 * @returns True if stageA comes before stageB
 *
 * @task T4800
 */
export function isStageBefore(stageA: Stage, stageB: Stage): boolean {
  return STAGE_ORDER[stageA] < STAGE_ORDER[stageB];
}

/**
 * Check if stage A comes after stage B in the pipeline.
 *
 * @param stageA - First stage to compare
 * @param stageB - Second stage to compare
 * @returns True if stageA comes after stageB
 *
 * @task T4800
 */
export function isStageAfter(stageA: Stage, stageB: Stage): boolean {
  return STAGE_ORDER[stageA] > STAGE_ORDER[stageB];
}

/**
 * Get the next stage in the pipeline.
 *
 * @param stage - Current stage
 * @returns The next stage, or null if at the end
 *
 * @task T4800
 */
export function getNextStage(stage: Stage): Stage | null {
  const order = STAGE_ORDER[stage];
  if (order >= 9) return null;

  return PIPELINE_STAGES[order]; // order is 1-based, array is 0-based
}

/**
 * Get the previous stage in the pipeline.
 *
 * @param stage - Current stage
 * @returns The previous stage, or null if at the start
 *
 * @task T4800
 */
export function getPreviousStage(stage: Stage): Stage | null {
  const order = STAGE_ORDER[stage];
  if (order <= 1) return null;

  return PIPELINE_STAGES[order - 2]; // order is 1-based, array is 0-based
}

/**
 * Get all stages between two stages (inclusive).
 *
 * @param from - Starting stage
 * @param to - Ending stage
 * @returns Array of stages between from and to
 *
 * @task T4800
 */
export function getStagesBetween(from: Stage, to: Stage): Stage[] {
  const fromOrder = STAGE_ORDER[from];
  const toOrder = STAGE_ORDER[to];

  const start = Math.min(fromOrder, toOrder);
  const end = Math.max(fromOrder, toOrder);

  return PIPELINE_STAGES.slice(start - 1, end);
}

// =============================================================================
// PREREQUISITE MAPPINGS
// =============================================================================

/**
 * Prerequisites for each stage - which stages must be completed before entering.
 *
 * @task T4800
 * @audit T4799 - Canonical prerequisite map
 */
export const STAGE_PREREQUISITES: Record<Stage, Stage[]> = {
  research: [], // No prerequisites
  consensus: ['research'],
  architecture_decision: ['research', 'consensus'],
  specification: ['research', 'consensus', 'architecture_decision'],
  decomposition: ['research', 'specification'],
  implementation: ['research', 'specification', 'decomposition'],
  validation: ['implementation'],
  testing: ['implementation', 'validation'],
  release: ['implementation', 'validation', 'testing'],
};

/**
 * Get prerequisites for a stage.
 *
 * @param stage - The stage to get prerequisites for
 * @returns Array of prerequisite stages
 *
 * @task T4800
 */
export function getPrerequisites(stage: Stage): Stage[] {
  return [...STAGE_PREREQUISITES[stage]];
}

/**
 * Check if one stage is a prerequisite of another.
 *
 * @param potentialPrereq - Stage that might be a prerequisite
 * @param stage - Stage to check against
 * @returns True if potentialPrereq is required before stage
 *
 * @task T4800
 */
export function isPrerequisite(potentialPrereq: Stage, stage: Stage): boolean {
  return STAGE_PREREQUISITES[stage].includes(potentialPrereq);
}

/**
 * Get all stages that depend on a given stage.
 *
 * @param stage - The stage to find dependents for
 * @returns Array of stages that require this stage
 *
 * @task T4800
 */
export function getDependents(stage: Stage): Stage[] {
  return PIPELINE_STAGES.filter(s => STAGE_PREREQUISITES[s].includes(stage));
}

// =============================================================================
// STAGE VALIDATION
// =============================================================================

/**
 * Check if a stage name is valid.
 *
 * @param stage - Stage name to validate
 * @returns True if valid stage name
 *
 * @task T4800
 */
export function isValidStage(stage: string): stage is Stage {
  return PIPELINE_STAGES.includes(stage as Stage);
}

/**
 * Validate a stage name and throw if invalid.
 *
 * @param stage - Stage name to validate
 * @throws {Error} If stage is invalid
 * @returns The validated Stage
 *
 * @task T4800
 */
export function validateStage(stage: string): Stage {
  if (!isValidStage(stage)) {
    throw new Error(
      `Invalid stage: "${stage}". ` +
      `Valid stages: ${PIPELINE_STAGES.join(', ')}`
    );
  }
  return stage;
}

/**
 * Check if a stage status is valid.
 *
 * @param status - Status to validate
 * @returns True if valid status
 *
 * @task T4800
 */
export function isValidStageStatus(status: string): status is StageStatus {
  const validStatuses: StageStatus[] = [
    'not_started',
    'in_progress',
    'completed',
    'skipped',
    'blocked',
    'failed',
  ];
  return validStatuses.includes(status as StageStatus);
}

/**
 * Get stages by category.
 *
 * @param category - Category to filter by
 * @returns Array of stages in that category
 *
 * @task T4800
 */
export function getStagesByCategory(category: StageCategory): Stage[] {
  return PIPELINE_STAGES.filter(
    stage => STAGE_DEFINITIONS[stage].category === category
  );
}

/**
 * Get skippable stages.
 *
 * @returns Array of stages that can be skipped
 *
 * @task T4800
 */
export function getSkippableStages(): Stage[] {
  return PIPELINE_STAGES.filter(
    stage => STAGE_DEFINITIONS[stage].skippable
  );
}

// =============================================================================
// STAGE TRANSITION RULES
// =============================================================================

/**
 * Transition rule - defines if a transition is allowed.
 *
 * @task T4800
 */
export interface TransitionRule {
  from: Stage | 'any';
  to: Stage | 'any';
  allowed: boolean;
  requiresForce?: boolean;
  reason?: string;
}

/**
 * Allowed transitions between stages.
 *
 * By default, stages progress linearly. These rules define exceptions.
 *
 * @task T4800
 */
export const TRANSITION_RULES: TransitionRule[] = [
  // Forward progressions (always allowed)
  { from: 'research', to: 'consensus', allowed: true },
  { from: 'consensus', to: 'architecture_decision', allowed: true },
  { from: 'architecture_decision', to: 'specification', allowed: true },
  { from: 'specification', to: 'decomposition', allowed: true },
  { from: 'decomposition', to: 'implementation', allowed: true },
  { from: 'implementation', to: 'validation', allowed: true },
  { from: 'validation', to: 'testing', allowed: true },
  { from: 'testing', to: 'release', allowed: true },

  // Skip patterns (allowed with force)
  { from: 'research', to: 'specification', allowed: true, requiresForce: true, reason: 'Skipping consensus and architecture_decision' },
  { from: 'specification', to: 'implementation', allowed: true, requiresForce: true, reason: 'Skipping decomposition' },

  // Backward transitions (allowed with force, for rework)
  { from: 'implementation', to: 'specification', allowed: true, requiresForce: true, reason: 'Rework required' },
  { from: 'testing', to: 'implementation', allowed: true, requiresForce: true, reason: 'Fix test failures' },

  // Disallowed transitions
  { from: 'release', to: 'any', allowed: false, reason: 'Pipeline completed' },
];

/**
 * Check if a transition is allowed.
 *
 * @param from - Source stage
 * @param to - Target stage
 * @param force - Whether to allow forced transitions
 * @returns Object with allowed flag and reason
 *
 * @task T4800
 */
export function checkTransition(
  from: Stage,
  to: Stage,
  force: boolean = false
): { allowed: boolean; requiresForce: boolean; reason?: string } {
  // Same stage - no transition needed
  if (from === to) {
    return { allowed: true, requiresForce: false };
  }

  // Find explicit rule
  const rule = TRANSITION_RULES.find(
    r => (r.from === from || r.from === 'any') &&
         (r.to === to || r.to === 'any')
  );

  if (rule) {
    if (!rule.allowed) {
      return {
        allowed: false,
        requiresForce: false,
        reason: rule.reason || 'Transition not allowed'
      };
    }

    if (rule.requiresForce && !force) {
      return {
        allowed: false,
        requiresForce: true,
        reason: rule.reason || 'Transition requires force flag'
      };
    }

    return { allowed: true, requiresForce: rule.requiresForce || false };
  }

  // Linear forward progression is always allowed
  if (isStageBefore(from, to) && !isStageAfter(from, to)) {
    // Check if skipping any non-skippable stages
    const between = getStagesBetween(from, to);
    const nonSkippableSkipped = between
      .filter(s => s !== from && s !== to)
      .filter(s => !STAGE_DEFINITIONS[s].skippable);

    if (nonSkippableSkipped.length > 0) {
      return {
        allowed: false,
        requiresForce: true,
        reason: `Would skip non-skippable stages: ${nonSkippableSkipped.join(', ')}`,
      };
    }

    return { allowed: true, requiresForce: false };
  }

  // Backward progression requires force
  return {
    allowed: force,
    requiresForce: true,
    reason: 'Backward transition requires force flag',
  };
}

// =============================================================================
// UTILITY EXPORTS
// =============================================================================

/**
 * Total number of stages in the pipeline.
 *
 * @task T4800
 */
export const STAGE_COUNT = PIPELINE_STAGES.length;

/**
 * First stage in the pipeline.
 *
 * @task T4800
 */
export const FIRST_STAGE: Stage = 'research';

/**
 * Last stage in the pipeline.
 *
 * @task T4800
 */
export const LAST_STAGE: Stage = 'release';

/**
 * Planning stages.
 *
 * @task T4800
 */
export const PLANNING_STAGES: Stage[] = getStagesByCategory('planning');

/**
 * Decision stages.
 *
 * @task T4800
 */
export const DECISION_STAGES: Stage[] = getStagesByCategory('decision');

/**
 * Execution stages (canonical).
 *
 * @task T4800
 */
export const EXECUTION_STAGES: Stage[] = getStagesByCategory('execution');

/**
 * Validation stages.
 *
 * @task T4800
 */
export const VALIDATION_STAGES: Stage[] = getStagesByCategory('validation');

/**
 * Delivery stages.
 *
 * @task T4800
 */
export const DELIVERY_STAGES: Stage[] = getStagesByCategory('delivery');
