/**
 * Pipeline Stage Definitions and Transitions
 * 
 * Defines the 9-stage RCSD-IVTR pipeline with stage metadata,
 * transition rules, and prerequisite mappings.
 * 
 * Stages (in order):
 *   1. Research    - Information gathering and exploration
 *   2. Consensus   - Multi-agent decisions and validation
 *   3. ADR         - Architecture Decision Records
 *   4. Spec        - Specification and documentation
 *   5. Decompose   - Task breakdown and planning
 *   6. Implement   - Code execution and building
 *   7. Verify      - Validation and quality checks
 *   8. Test        - Test execution and coverage
 *   9. Release     - Version management and publishing
 * 
 * @task T4800 - Implement Canonical SQLite Pipeline State Machine
 * @epic T4798 - Lifecycle persistence improvements
 * @audit T4799 - Unified stage names (replaces scattered definitions)
 * 
 * NOTE: This file provides the canonical stage definitions. All other
 * stage definitions in the codebase should reference these.
 */

// =============================================================================
// STAGE TYPE DEFINITIONS
// =============================================================================

/**
 * Canonical pipeline stages in execution order.
 * 
 * This is the single source of truth for stage names across CLEO.
 * All other stage arrays should be derived from this.
 * 
 * @task T4800
 * @audit T4799 - Consolidates: RCSD_STAGES, EXECUTION_STAGES, ENGINE_LIFECYCLE_STAGES
 */
export const PIPELINE_STAGES = [
  'research',
  'consensus',
  'adr',
  'spec',
  'decompose',
  'implement',
  'verify',
  'test',
  'release',
] as const;

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
export type StageStatus = 
  | 'not_started'   // Stage hasn't begun
  | 'in_progress'   // Stage is currently active
  | 'completed'     // Stage finished successfully
  | 'skipped'       // Stage was intentionally bypassed
  | 'blocked'       // Stage cannot proceed due to dependencies
  | 'failed';       // Stage execution failed

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
 * @audit T4799 - Replaces STAGE_DEFINITIONS from index.ts
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
  adr: {
    stage: 'adr',
    name: 'ADR',
    description: 'Architecture Decision Records - documenting significant technical decisions',
    order: 3,
    category: 'decision',
    skippable: true,
    defaultTimeoutHours: 24,
    requiredGates: ['decisions-documented', 'review-completed'],
    expectedArtifacts: ['adr-document'],
  },
  spec: {
    stage: 'spec',
    name: 'Spec',
    description: 'Specification writing - RFC-style documentation of requirements and design',
    order: 4,
    category: 'planning',
    skippable: false,
    defaultTimeoutHours: 72,
    requiredGates: ['spec-complete', 'spec-reviewed'],
    expectedArtifacts: ['spec-document', 'api-spec', 'design-doc'],
  },
  decompose: {
    stage: 'decompose',
    name: 'Decompose',
    description: 'Task breakdown - splitting work into atomic, executable tasks',
    order: 5,
    category: 'planning',
    skippable: false,
    defaultTimeoutHours: 24,
    requiredGates: ['tasks-created', 'dependencies-mapped'],
    expectedArtifacts: ['task-breakdown', 'dependency-graph'],
  },
  implement: {
    stage: 'implement',
    name: 'Implement',
    description: 'Implementation - writing code and building features',
    order: 6,
    category: 'execution',
    skippable: false,
    defaultTimeoutHours: null, // Varies by task size
    requiredGates: ['code-complete', 'lint-passing'],
    expectedArtifacts: ['source-code', 'implementation-notes'],
  },
  verify: {
    stage: 'verify',
    name: 'Verify',
    description: 'Verification - static analysis, type checking, and quality gates',
    order: 7,
    category: 'validation',
    skippable: false,
    defaultTimeoutHours: 12,
    requiredGates: ['static-analysis-pass', 'type-check-pass'],
    expectedArtifacts: ['verification-report'],
  },
  test: {
    stage: 'test',
    name: 'Test',
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
  adr: 3,
  spec: 4,
  decompose: 5,
  implement: 6,
  verify: 7,
  test: 8,
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
 * @audit T4799 - Replaces STAGE_PREREQUISITES from index.ts
 */
export const STAGE_PREREQUISITES: Record<Stage, Stage[]> = {
  research: [], // No prerequisites
  consensus: ['research'],
  adr: ['research', 'consensus'],
  spec: ['research', 'consensus', 'adr'],
  decompose: ['research', 'spec'],
  implement: ['research', 'spec', 'decompose'],
  verify: ['implement'],
  test: ['implement', 'verify'],
  release: ['implement', 'verify', 'test'],
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
  { from: 'consensus', to: 'adr', allowed: true },
  { from: 'adr', to: 'spec', allowed: true },
  { from: 'spec', to: 'decompose', allowed: true },
  { from: 'decompose', to: 'implement', allowed: true },
  { from: 'implement', to: 'verify', allowed: true },
  { from: 'verify', to: 'test', allowed: true },
  { from: 'test', to: 'release', allowed: true },
  
  // Skip patterns (allowed with force)
  { from: 'research', to: 'spec', allowed: true, requiresForce: true, reason: 'Skipping consensus and ADR' },
  { from: 'spec', to: 'implement', allowed: true, requiresForce: true, reason: 'Skipping decomposition' },
  
  // Backward transitions (allowed with force, for rework)
  { from: 'implement', to: 'spec', allowed: true, requiresForce: true, reason: 'Rework required' },
  { from: 'test', to: 'implement', allowed: true, requiresForce: true, reason: 'Fix test failures' },
  
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
 * Execution stages.
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
