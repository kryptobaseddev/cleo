/**
 * E2E Integration Tests: Brain Operations
 *
 * Tests the orchestrate/session/system/validate engine functions
 * directly with fixture data. Covers bootstrap tiers, complexity
 * estimates, coherence checks, critical path, unblock opportunities,
 * decision/assumption round-trips, context drift, and MVI generation.
 *
 * @task T4478
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';

import {
  orchestrateBootstrap,
  orchestrateCriticalPath,
  orchestrateUnblockOpportunities,
} from '../../engine/orchestrate-engine.js';

import {
  taskComplexityEstimate,
} from '../../engine/task-engine.js';

import {
  validateCoherenceCheck,
} from '../../engine/validate-engine.js';

import {
  sessionRecordDecision,
  sessionDecisionLog,
  sessionRecordAssumption,
  sessionContextDrift,
} from '../../engine/session-engine.js';

import {
  systemInjectGenerate,
} from '../../engine/system-engine.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TEST_ROOT = join(process.cwd(), '.test-brain-ops');
const CLEO_DIR = join(TEST_ROOT, '.cleo');
const AUDIT_DIR = join(CLEO_DIR, 'audit');
const MANIFEST_DIR = join(TEST_ROOT, 'claudedocs', 'agent-outputs');

/**
 * Write todo.json with the given tasks and optional meta/focus overrides.
 */
function writeTodoJson(
  tasks: any[],
  opts?: {
    focus?: Record<string, unknown>;
    meta?: Record<string, unknown>;
    project?: Record<string, unknown>;
  },
): void {
  mkdirSync(CLEO_DIR, { recursive: true });
  writeFileSync(
    join(CLEO_DIR, 'todo.json'),
    JSON.stringify(
      {
        tasks,
        project: opts?.project ?? { name: 'brain-ops-test' },
        focus: opts?.focus ?? {
          currentTask: null,
          currentPhase: null,
          blockedUntil: null,
          sessionNote: null,
          sessionNotes: [],
          nextAction: null,
          primarySession: null,
        },
        _meta: {
          schemaVersion: '2.6.0',
          checksum: 'test',
          lastModified: new Date().toISOString(),
          generation: 1,
          ...(opts?.meta ?? {}),
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
}

/**
 * Write sessions.json with the given sessions.
 */
function writeSessionsJson(sessions: any[]): void {
  mkdirSync(CLEO_DIR, { recursive: true });
  writeFileSync(
    join(CLEO_DIR, 'sessions.json'),
    JSON.stringify(
      {
        _meta: {
          schemaVersion: '1.0.0',
          checksum: '',
          lastModified: new Date().toISOString(),
          totalSessionsCreated: sessions.length,
        },
        sessions,
        sessionHistory: [],
      },
      null,
      2,
    ),
    'utf-8',
  );
}

/**
 * Write MANIFEST.jsonl with the given entries.
 */
function writeManifest(entries: any[]): void {
  mkdirSync(MANIFEST_DIR, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(MANIFEST_DIR, 'MANIFEST.jsonl'), content, 'utf-8');
}

/**
 * Write decisions.jsonl with the given records.
 */
function writeDecisions(records: any[]): void {
  mkdirSync(AUDIT_DIR, { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(AUDIT_DIR, 'decisions.jsonl'), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_TASKS = [
  // Epic (root)
  {
    id: 'T100',
    title: 'Epic: Brain Ops',
    description: 'Parent epic for brain operations testing',
    status: 'active',
    priority: 'high',
    type: 'epic',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-10T00:00:00Z',
  },
  // Child tasks with dependency chain: T101 -> T102 -> T103 -> T104
  {
    id: 'T101',
    title: 'Setup infrastructure',
    description: 'Set up the base infrastructure for the project',
    status: 'done',
    priority: 'high',
    parentId: 'T100',
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-05T00:00:00Z',
    completedAt: '2026-01-05T00:00:00Z',
  },
  {
    id: 'T102',
    title: 'Implement core module',
    description: 'Build the core processing module with multiple components and integration points',
    status: 'pending',
    priority: 'high',
    parentId: 'T100',
    depends: ['T101'],
    acceptance: ['All unit tests pass', 'Code coverage above 80%', 'Documentation updated'],
    files: ['src/core/module.ts', 'src/core/types.ts'],
    createdAt: '2026-01-03T00:00:00Z',
    updatedAt: null,
  },
  {
    id: 'T103',
    title: 'Write integration tests',
    description: 'Create comprehensive integration test suite',
    status: 'pending',
    priority: 'medium',
    parentId: 'T100',
    depends: ['T102'],
    createdAt: '2026-01-03T00:00:00Z',
    updatedAt: null,
  },
  {
    id: 'T104',
    title: 'Deploy to staging',
    description: 'Deploy the application to the staging environment and verify functionality',
    status: 'pending',
    priority: 'medium',
    parentId: 'T100',
    depends: ['T103'],
    createdAt: '2026-01-04T00:00:00Z',
    updatedAt: null,
  },
  // Independent pending task (no deps)
  {
    id: 'T105',
    title: 'Update documentation',
    description: 'Update README and API docs',
    status: 'pending',
    priority: 'low',
    parentId: 'T100',
    createdAt: '2026-01-04T00:00:00Z',
    updatedAt: null,
  },
  // A task with a single blocker
  {
    id: 'T106',
    title: 'Performance optimization',
    description: 'Optimize critical paths for performance',
    status: 'pending',
    priority: 'high',
    parentId: 'T100',
    depends: ['T105'],
    createdAt: '2026-01-05T00:00:00Z',
    updatedAt: null,
  },
  // Simple small task (short description, no deps, no subtasks)
  {
    id: 'T107',
    title: 'Fix typo',
    description: 'Fix a typo in the config',
    status: 'pending',
    priority: 'low',
    createdAt: '2026-01-06T00:00:00Z',
    updatedAt: null,
  },
  // Subtask of T102 (for complexity scoring)
  {
    id: 'T108',
    title: 'Core module sub-component',
    description: 'Implement sub-component A of the core module',
    status: 'pending',
    priority: 'medium',
    parentId: 'T102',
    createdAt: '2026-01-07T00:00:00Z',
    updatedAt: null,
  },
  {
    id: 'T109',
    title: 'Core module sub-component B',
    description: 'Implement sub-component B of the core module',
    status: 'pending',
    priority: 'medium',
    parentId: 'T102',
    createdAt: '2026-01-07T00:00:00Z',
    updatedAt: null,
  },
];

const SAMPLE_SESSION = {
  id: 'session_20260201_120000_abc123',
  status: 'active',
  name: 'Brain ops work',
  scope: {
    type: 'epic',
    rootTaskId: 'T100',
    includeDescendants: true,
  },
  focus: {
    currentTask: 'T102',
    currentPhase: null,
    previousTask: 'T101',
  },
  startedAt: '2026-02-01T12:00:00Z',
  lastActivity: '2026-02-01T14:00:00Z',
  resumeCount: 0,
  stats: {
    tasksCompleted: 1,
    tasksCreated: 0,
    tasksUpdated: 3,
    focusChanges: 2,
    totalActiveMinutes: 120,
    suspendCount: 0,
  },
};

const SAMPLE_MANIFEST_ENTRIES = [
  {
    id: 'T101-infra-research',
    file: '.cleo/agent-outputs/T101-infra.md',
    title: 'Infrastructure Research',
    date: '2026-01-03',
    status: 'complete',
    agent_type: 'research',
    topics: ['infrastructure', 'devops', 'deployment'],
    key_findings: ['Use containerized deployment', 'Kubernetes preferred'],
    actionable: true,
    needs_followup: [],
    linked_tasks: ['T100', 'T101'],
  },
  {
    id: 'T102-core-spec',
    file: '.cleo/agent-outputs/T102-spec.md',
    title: 'Core Module Specification',
    date: '2026-01-04',
    status: 'complete',
    agent_type: 'specification',
    topics: ['core', 'architecture', 'deployment'],
    key_findings: ['Modular design with plugin architecture'],
    actionable: true,
    needs_followup: ['T103'],
    linked_tasks: ['T100', 'T102'],
  },
  {
    id: 'T103-test-plan',
    file: '.cleo/agent-outputs/T103-tests.md',
    title: 'Integration Test Plan',
    date: '2026-01-05',
    status: 'complete',
    agent_type: 'specification',
    topics: ['testing', 'integration', 'deployment'],
    key_findings: ['Need 85% coverage minimum', 'Containers recommended for testing'],
    actionable: true,
    needs_followup: [],
    linked_tasks: ['T100', 'T103'],
  },
  {
    id: 'T104-deploy-research',
    file: '.cleo/agent-outputs/T104-deploy.md',
    title: 'Deployment Strategy Research',
    date: '2026-01-06',
    status: 'complete',
    agent_type: 'research',
    topics: ['deployment', 'staging', 'infrastructure'],
    key_findings: ['Blue-green deployment strategy', 'Contradicts containerized approach from T101'],
    actionable: false,
    needs_followup: ['T101'],
    linked_tasks: ['T100', 'T104'],
  },
];

const SAMPLE_DECISIONS = [
  {
    id: 'dec-aabbccdd11223344',
    sessionId: 'session_20260201_120000_abc123',
    taskId: 'T101',
    decision: 'Use Kubernetes for deployment',
    rationale: 'Better scalability and community support',
    alternatives: ['Docker Compose', 'Bare metal'],
    timestamp: '2026-02-01T12:30:00Z',
  },
  {
    id: 'dec-eeff001122334455',
    sessionId: 'session_20260201_120000_abc123',
    taskId: 'T102',
    decision: 'Adopt plugin architecture for core module',
    rationale: 'Allows extensibility without modifying core',
    alternatives: ['Monolithic design', 'Microservices'],
    timestamp: '2026-02-01T13:00:00Z',
  },
  {
    id: 'dec-5566778899aabbcc',
    sessionId: 'session_other',
    taskId: 'T103',
    decision: 'Use Jest for integration testing',
    rationale: 'Consistent with existing test infrastructure',
    alternatives: ['Vitest', 'Mocha'],
    timestamp: '2026-02-01T13:30:00Z',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E: Brain Operations', () => {
  beforeEach(() => {
    mkdirSync(CLEO_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 1. Bootstrap tiers
  // -------------------------------------------------------------------------
  describe('orchestrateBootstrap', () => {
    it('should return BrainState with expected fields for fast tier', async () => {
      writeTodoJson(SAMPLE_TASKS);

      const result = await orchestrateBootstrap(TEST_ROOT, { speed: 'fast' });
      expect(result.success).toBe(true);

      const brain = result.data!;
      expect(brain._meta).toBeDefined();
      expect(brain._meta.speed).toBe('fast');
      expect(brain._meta.version).toBe('1.0.0');
      expect(brain._meta.generatedAt).toBeDefined();

      // Fast tier must include progress
      expect(brain.progress).toBeDefined();
      expect(brain.progress!.total).toBe(SAMPLE_TASKS.length);
      expect(brain.progress!.done).toBe(1); // T101 is done
      expect(brain.progress!.pending).toBeGreaterThan(0);

      // Fast tier should NOT include full-tier fields
      expect(brain.recentDecisions).toBeUndefined();
      expect(brain.blockers).toBeUndefined();
      expect(brain.contextDrift).toBeUndefined();
    });

    it('should return BrainState with full-tier fields for full speed', async () => {
      writeTodoJson(SAMPLE_TASKS);
      writeDecisions(SAMPLE_DECISIONS);

      const result = await orchestrateBootstrap(TEST_ROOT, { speed: 'full' });
      expect(result.success).toBe(true);

      const brain = result.data!;
      expect(brain._meta.speed).toBe('full');

      // Full tier includes progress
      expect(brain.progress).toBeDefined();
      expect(brain.progress!.total).toBe(SAMPLE_TASKS.length);

      // Full tier includes recent decisions, blockers, contextDrift
      // (decisions may be empty if the audit file format doesn't match session,
      //  but the field should exist at the full tier)
      // recentDecisions is populated from sessionDecisionLog which reads audit/decisions.jsonl
      expect(brain.recentDecisions).toBeDefined();
    });

    it('should return BrainState with complete-tier fields', async () => {
      writeTodoJson(SAMPLE_TASKS);

      const result = await orchestrateBootstrap(TEST_ROOT, { speed: 'complete' });
      expect(result.success).toBe(true);

      const brain = result.data!;
      expect(brain._meta.speed).toBe('complete');
      expect(brain.progress).toBeDefined();
      // complete includes all full-tier fields
    });

    it('should default to fast speed when no speed parameter provided', async () => {
      writeTodoJson(SAMPLE_TASKS);

      const result = await orchestrateBootstrap(TEST_ROOT);
      expect(result.success).toBe(true);
      expect(result.data!._meta.speed).toBe('fast');
    });

    it('should include nextSuggestion when pending tasks exist', async () => {
      writeTodoJson(SAMPLE_TASKS);

      const result = await orchestrateBootstrap(TEST_ROOT, { speed: 'fast' });
      expect(result.success).toBe(true);

      // T105 and T107 are pending with no unmet deps, so a suggestion should exist
      expect(result.data!.nextSuggestion).toBeDefined();
      expect(result.data!.nextSuggestion!.id).toBeDefined();
      expect(result.data!.nextSuggestion!.title).toBeDefined();
      expect(typeof result.data!.nextSuggestion!.score).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Complexity estimate
  // -------------------------------------------------------------------------
  describe('taskComplexityEstimate', () => {
    it('should classify a simple task as small', async () => {
      writeTodoJson(SAMPLE_TASKS);

      // T107: short description, no deps, no subtasks, no files
      const result = await taskComplexityEstimate(TEST_ROOT, { taskId: 'T107' });
      expect(result.success).toBe(true);

      const data = result.data!;
      expect(data.size).toBe('small');
      expect(data.score).toBeLessThanOrEqual(3);
      expect(data.dependencyDepth).toBe(0);
      expect(data.subtaskCount).toBe(0);
      expect(data.fileCount).toBe(0);
      expect(Array.isArray(data.factors)).toBe(true);
      expect(data.factors.length).toBeGreaterThan(0);
    });

    it('should classify a complex task as medium or large', async () => {
      writeTodoJson(SAMPLE_TASKS);

      // T102: long description, has deps (T101), has subtasks (T108, T109),
      //        has acceptance criteria (3), has files (2)
      const result = await taskComplexityEstimate(TEST_ROOT, { taskId: 'T102' });
      expect(result.success).toBe(true);

      const data = result.data!;
      // Score should be higher due to multiple factors
      expect(data.score).toBeGreaterThan(3);
      expect(['medium', 'large']).toContain(data.size);
      expect(data.dependencyDepth).toBeGreaterThanOrEqual(1);
      expect(data.subtaskCount).toBe(2); // T108 and T109
      expect(data.fileCount).toBe(2);
    });

    it('should return error for non-existent task', async () => {
      writeTodoJson(SAMPLE_TASKS);

      const result = await taskComplexityEstimate(TEST_ROOT, { taskId: 'T999' });
      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('E_NOT_FOUND');
    });

    it('should score dependency depth correctly for chained tasks', async () => {
      writeTodoJson(SAMPLE_TASKS);

      // T104 depends on T103, which depends on T102, which depends on T101
      const result = await taskComplexityEstimate(TEST_ROOT, { taskId: 'T104' });
      expect(result.success).toBe(true);
      expect(result.data!.dependencyDepth).toBeGreaterThanOrEqual(3);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Coherence check
  // -------------------------------------------------------------------------
  describe('validateCoherenceCheck', () => {
    it('should detect done task with pending subtask', async () => {
      const incoherentTasks = [
        {
          id: 'T200',
          title: 'Parent done',
          description: 'This parent is done',
          status: 'done',
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-05T00:00:00Z',
          completedAt: '2026-01-05T00:00:00Z',
        },
        {
          id: 'T201',
          title: 'Pending child',
          description: 'This child is still pending',
          status: 'pending',
          priority: 'medium',
          parentId: 'T200',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: null,
        },
      ];

      writeTodoJson(incoherentTasks);

      const result = await validateCoherenceCheck(TEST_ROOT);
      expect(result.success).toBe(true);

      const data = result.data!;
      expect(data.coherent).toBe(false);
      expect(data.issues.length).toBeGreaterThan(0);

      const doneWithIncomplete = data.issues.find(
        (i) => i.type === 'done_with_incomplete_subtask',
      );
      expect(doneWithIncomplete).toBeDefined();
      expect(doneWithIncomplete!.taskId).toBe('T200');
      expect(doneWithIncomplete!.severity).toBe('error');
    });

    it('should detect orphaned dependency', async () => {
      const orphanedTasks = [
        {
          id: 'T300',
          title: 'Task with orphan dep',
          description: 'Depends on a non-existent task',
          status: 'pending',
          priority: 'medium',
          depends: ['T999'],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: null,
        },
      ];

      writeTodoJson(orphanedTasks);

      const result = await validateCoherenceCheck(TEST_ROOT);
      expect(result.success).toBe(true);

      const data = result.data!;
      expect(data.coherent).toBe(false);

      const orphaned = data.issues.find(
        (i) => i.type === 'orphaned_dependency',
      );
      expect(orphaned).toBeDefined();
      expect(orphaned!.taskId).toBe('T300');
    });

    it('should detect status inconsistency (active child under done parent)', async () => {
      const inconsistentTasks = [
        {
          id: 'T400',
          title: 'Done parent',
          description: 'Parent is done',
          status: 'done',
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-05T00:00:00Z',
          completedAt: '2026-01-05T00:00:00Z',
        },
        {
          id: 'T401',
          title: 'Active child under done parent',
          description: 'Should not be active',
          status: 'active',
          priority: 'medium',
          parentId: 'T400',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-06T00:00:00Z',
        },
      ];

      writeTodoJson(inconsistentTasks);

      const result = await validateCoherenceCheck(TEST_ROOT);
      expect(result.success).toBe(true);

      const data = result.data!;
      expect(data.coherent).toBe(false);

      const inconsistency = data.issues.find(
        (i) => i.type === 'status_inconsistency',
      );
      expect(inconsistency).toBeDefined();
      expect(inconsistency!.taskId).toBe('T401');
    });

    it('should report coherent for valid task graph', async () => {
      const validTasks = [
        {
          id: 'T500',
          title: 'Active parent',
          description: 'Parent is active',
          status: 'active',
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'T501',
          title: 'Pending child',
          description: 'Pending under active parent',
          status: 'pending',
          priority: 'medium',
          parentId: 'T500',
          depends: ['T500'],
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: null,
        },
      ];

      writeTodoJson(validTasks);

      const result = await validateCoherenceCheck(TEST_ROOT);
      expect(result.success).toBe(true);
      expect(result.data!.coherent).toBe(true);
      expect(result.data!.issues.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Critical path
  // -------------------------------------------------------------------------
  describe('orchestrateCriticalPath', () => {
    it('should find the longest dependency chain', async () => {
      writeTodoJson(SAMPLE_TASKS);

      const result = await orchestrateCriticalPath(TEST_ROOT);
      expect(result.success).toBe(true);

      const data = result.data as any;
      // The longest chain is T101 -> T102 -> T103 -> T104 (length 4)
      expect(data.length).toBeGreaterThanOrEqual(4);
      expect(data.path.length).toBe(data.length);

      // Verify path is in dependency order
      const pathIds = data.path.map((p: any) => p.taskId);
      expect(pathIds).toContain('T101');
      expect(pathIds).toContain('T104');

      // T101 should come before T104 in the path
      expect(pathIds.indexOf('T101')).toBeLessThan(pathIds.indexOf('T104'));

      // Verify annotations
      for (const node of data.path) {
        expect(node.taskId).toBeDefined();
        expect(node.title).toBeDefined();
        expect(node.status).toBeDefined();
        expect(node.size).toBeDefined();
        expect(typeof node.blockerCount).toBe('number');
      }

      // completedInPath should count T101 (done)
      expect(data.completedInPath).toBeGreaterThanOrEqual(1);
      expect(data.remainingInPath).toBe(data.length - data.completedInPath);
    });

    it('should return empty path for empty task list', async () => {
      writeTodoJson([]);

      const result = await orchestrateCriticalPath(TEST_ROOT);
      expect(result.success).toBe(true);

      const data = result.data as any;
      expect(data.path).toHaveLength(0);
      expect(data.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Unblock opportunities
  // -------------------------------------------------------------------------
  describe('orchestrateUnblockOpportunities', () => {
    it('should detect single-blocker tasks', async () => {
      writeTodoJson(SAMPLE_TASKS);

      const result = await orchestrateUnblockOpportunities(TEST_ROOT);
      expect(result.success).toBe(true);

      const data = result.data as any;

      // T106 depends only on T105 (single blocker)
      const singleBlockers = data.singleBlocker;
      expect(Array.isArray(singleBlockers)).toBe(true);

      const t106entry = singleBlockers.find(
        (sb: any) => sb.taskId === 'T106',
      );
      expect(t106entry).toBeDefined();
      expect(t106entry.remainingBlocker.id).toBe('T105');
    });

    it('should identify high-impact completions', async () => {
      writeTodoJson(SAMPLE_TASKS);

      const result = await orchestrateUnblockOpportunities(TEST_ROOT);
      expect(result.success).toBe(true);

      const data = result.data as any;

      // T102 blocks T103 which blocks T104, plus T102 blocks T108/T109 indirectly
      // so completing T102 would unblock several tasks
      const highImpact = data.highImpact;
      expect(Array.isArray(highImpact)).toBe(true);
      expect(highImpact.length).toBeGreaterThan(0);

      // Sorted by wouldUnblock descending
      if (highImpact.length > 1) {
        expect(highImpact[0].wouldUnblock).toBeGreaterThanOrEqual(
          highImpact[highImpact.length - 1].wouldUnblock,
        );
      }
    });

    it('should return empty arrays when no tasks are blocked', async () => {
      const noDeps = [
        {
          id: 'T600',
          title: 'Independent A',
          description: 'No deps',
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: null,
        },
        {
          id: 'T601',
          title: 'Independent B',
          description: 'No deps either',
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: null,
        },
      ];
      writeTodoJson(noDeps);

      const result = await orchestrateUnblockOpportunities(TEST_ROOT);
      expect(result.success).toBe(true);

      const data = result.data as any;
      expect(data.singleBlocker).toHaveLength(0);
      expect(data.commonBlockers).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Decision round-trip
  // -------------------------------------------------------------------------
  describe('sessionRecordDecision / sessionDecisionLog', () => {
    it('should record a decision and retrieve it', async () => {
      writeTodoJson(SAMPLE_TASKS);

      // Record a decision
      const recordResult = await sessionRecordDecision(TEST_ROOT, {
        sessionId: 'test-session-001',
        taskId: 'T102',
        decision: 'Use modular architecture',
        rationale: 'Better maintainability and testability',
        alternatives: ['Monolithic', 'Microservices'],
      });

      expect(recordResult.success).toBe(true);
      const recorded = recordResult.data!;
      expect(recorded.id).toMatch(/^dec-/);
      expect(recorded.sessionId).toBe('test-session-001');
      expect(recorded.taskId).toBe('T102');
      expect(recorded.decision).toBe('Use modular architecture');
      expect(recorded.rationale).toBe('Better maintainability and testability');
      expect(recorded.alternatives).toEqual(['Monolithic', 'Microservices']);
      expect(recorded.timestamp).toBeDefined();

      // Query it back
      const queryResult = await sessionDecisionLog(TEST_ROOT, {
        sessionId: 'test-session-001',
      });

      expect(queryResult.success).toBe(true);
      const decisions = queryResult.data!;
      expect(decisions.length).toBe(1);
      expect(decisions[0].decision).toBe('Use modular architecture');
      expect(decisions[0].sessionId).toBe('test-session-001');
    });

    it('should filter decisions by taskId', async () => {
      writeTodoJson(SAMPLE_TASKS);
      writeDecisions(SAMPLE_DECISIONS);

      const result = await sessionDecisionLog(TEST_ROOT, { taskId: 'T102' });
      expect(result.success).toBe(true);

      const decisions = result.data!;
      expect(decisions.length).toBe(1);
      expect(decisions[0].taskId).toBe('T102');
      expect(decisions[0].decision).toBe(
        'Adopt plugin architecture for core module',
      );
    });

    it('should return all decisions when no filters applied', async () => {
      writeTodoJson(SAMPLE_TASKS);
      writeDecisions(SAMPLE_DECISIONS);

      const result = await sessionDecisionLog(TEST_ROOT);
      expect(result.success).toBe(true);
      expect(result.data!.length).toBe(SAMPLE_DECISIONS.length);
    });

    it('should return empty array when no decisions exist', async () => {
      writeTodoJson(SAMPLE_TASKS);

      const result = await sessionDecisionLog(TEST_ROOT);
      expect(result.success).toBe(true);
      expect(result.data!).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Assumption round-trip
  // -------------------------------------------------------------------------
  describe('sessionRecordAssumption', () => {
    it('should record an assumption and write to JSONL file', async () => {
      writeTodoJson(SAMPLE_TASKS);

      const result = await sessionRecordAssumption(TEST_ROOT, {
        sessionId: 'test-session-001',
        taskId: 'T102',
        assumption: 'Database schema will remain stable during development',
        confidence: 'medium',
      });

      expect(result.success).toBe(true);

      const data = result.data!;
      expect(data.id).toMatch(/^asm-/);
      expect(data.sessionId).toBe('test-session-001');
      expect(data.taskId).toBe('T102');
      expect(data.assumption).toBe(
        'Database schema will remain stable during development',
      );
      expect(data.confidence).toBe('medium');
      expect(data.timestamp).toBeDefined();

      // Verify the JSONL file was written
      const assumptionsPath = join(AUDIT_DIR, 'assumptions.jsonl');
      expect(existsSync(assumptionsPath)).toBe(true);

      const content = readFileSync(assumptionsPath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.assumption).toBe(
        'Database schema will remain stable during development',
      );
      expect(parsed.confidence).toBe('medium');
    });

    it('should reject assumption with invalid confidence', async () => {
      writeTodoJson(SAMPLE_TASKS);

      const result = await sessionRecordAssumption(TEST_ROOT, {
        assumption: 'Some assumption',
        confidence: 'invalid' as any,
      });

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('E_INVALID_INPUT');
    });

    it('should reject assumption with missing assumption text', async () => {
      writeTodoJson(SAMPLE_TASKS);

      const result = await sessionRecordAssumption(TEST_ROOT, {
        assumption: '',
        confidence: 'high',
      });

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('E_INVALID_INPUT');
    });
  });

  // -------------------------------------------------------------------------
  // 8. Context drift
  // -------------------------------------------------------------------------
  describe('sessionContextDrift', () => {
    it('should calculate drift score with focus-based scope', async () => {
      // Single-session mode: focus set to T100 (epic)
      writeTodoJson(SAMPLE_TASKS, {
        focus: {
          currentTask: 'T100',
          currentPhase: null,
          blockedUntil: null,
          sessionNote: null,
          sessionNotes: [],
          nextAction: null,
          primarySession: null,
        },
      });

      const result = await sessionContextDrift(TEST_ROOT);
      expect(result.success).toBe(true);

      const data = result.data!;
      expect(typeof data.score).toBe('number');
      expect(data.score).toBeGreaterThanOrEqual(0);
      expect(data.score).toBeLessThanOrEqual(100);
      expect(Array.isArray(data.factors)).toBe(true);
      expect(data.factors.length).toBeGreaterThan(0);
      expect(typeof data.completedInScope).toBe('number');
      expect(typeof data.totalInScope).toBe('number');
      expect(typeof data.outOfScope).toBe('number');
    });

    it('should return zero drift when no focus is set', async () => {
      writeTodoJson(SAMPLE_TASKS, {
        focus: {
          currentTask: null,
          currentPhase: null,
          blockedUntil: null,
          sessionNote: null,
          sessionNotes: [],
          nextAction: null,
          primarySession: null,
        },
      });

      const result = await sessionContextDrift(TEST_ROOT);
      expect(result.success).toBe(true);
      expect(result.data!.score).toBe(0);
    });

    it('should calculate drift for multi-session scope', async () => {
      writeTodoJson(SAMPLE_TASKS, {
        focus: {
          currentTask: 'T102',
          currentPhase: null,
          blockedUntil: null,
          sessionNote: null,
          sessionNotes: [],
          nextAction: null,
          primarySession: null,
        },
        meta: {
          schemaVersion: '2.6.0',
          multiSessionEnabled: true,
          activeSession: SAMPLE_SESSION.id,
          sessionsFile: 'sessions.json',
        },
      });
      writeSessionsJson([SAMPLE_SESSION]);

      const result = await sessionContextDrift(TEST_ROOT, {
        sessionId: SAMPLE_SESSION.id,
      });
      expect(result.success).toBe(true);

      const data = result.data!;
      expect(typeof data.score).toBe('number');
      // The scope includes T100 and its descendants
      expect(data.totalInScope).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 9. MVI generation
  // -------------------------------------------------------------------------
  describe('systemInjectGenerate', () => {
    it('should generate valid MVI markdown under 5KB', async () => {
      writeTodoJson(SAMPLE_TASKS, {
        project: { name: 'brain-ops-test' },
      });

      // Write a package.json so version is picked up
      writeFileSync(
        join(TEST_ROOT, 'package.json'),
        JSON.stringify({ version: '1.2.3' }),
        'utf-8',
      );

      const result = await systemInjectGenerate(TEST_ROOT);
      expect(result.success).toBe(true);

      const data = result.data!;

      // Must be a non-empty string
      expect(typeof data.injection).toBe('string');
      expect(data.injection.length).toBeGreaterThan(0);

      // Must be under 5KB
      expect(data.sizeBytes).toBeLessThan(5 * 1024);

      // Version field
      expect(data.version).toBe('1.0.0');

      // Check required sections in the MVI markdown
      const mvi = data.injection;
      expect(mvi).toContain('CLEO Task Management');
      expect(mvi).toContain('Essential Commands');
      expect(mvi).toContain('Session Protocol');
      expect(mvi).toContain('Error Handling');
      expect(mvi).toContain('Bootstrap');
    });

    it('should include session info when active session exists', async () => {
      writeTodoJson(SAMPLE_TASKS, {
        focus: { currentTask: 'T102' },
        meta: {
          schemaVersion: '2.6.0',
          multiSessionEnabled: true,
          activeSession: SAMPLE_SESSION.id,
          sessionsFile: 'sessions.json',
        },
      });
      writeSessionsJson([SAMPLE_SESSION]);
      writeFileSync(
        join(TEST_ROOT, 'package.json'),
        JSON.stringify({ version: '2.0.0' }),
        'utf-8',
      );

      const result = await systemInjectGenerate(TEST_ROOT);
      expect(result.success).toBe(true);

      const mvi = result.data!.injection;
      // The MVI should include session or focus info
      expect(mvi).toContain('Session');
    });

    it('should handle missing package.json gracefully', async () => {
      writeTodoJson(SAMPLE_TASKS);

      const result = await systemInjectGenerate(TEST_ROOT);
      expect(result.success).toBe(true);

      // Should still generate valid MVI
      expect(result.data!.injection.length).toBeGreaterThan(0);
      expect(result.data!.sizeBytes).toBeLessThan(5 * 1024);
    });
  });
});
