/**
 * Unit tests for the Mental Model Manager ({@link consolidate}, {@link renderMentalModel}, {@link harvestObservations}).
 *
 * @remarks
 * These tests exercise the full mental model lifecycle: consolidation with
 * pending observations, deduplication/reinforcement, decay, token cap
 * enforcement, rendering with validation prefix, and post-session harvesting.
 * A mock {@link MentalModelStore} isolates the logic from persistence.
 *
 * Vitest with describe/it blocks per project conventions.
 */

import { describe, expect, it } from 'vitest';
import {
  type ConsolidateOptions,
  type MentalModel,
  type MentalModelObservation,
  type MentalModelStore,
  type SessionOutput,
  consolidate,
  createEmptyModel,
  harvestObservations,
  renderMentalModel,
} from '../src/mental-model';

// ---------------------------------------------------------------------------
// Mock MentalModelStore
// ---------------------------------------------------------------------------

/**
 * Create a mock {@link MentalModelStore} backed by in-memory maps.
 *
 * @param existingModel - An existing model to pre-load, or null.
 * @param pendingObs - Pending observations to pre-load.
 * @returns A mock store with inspection helpers.
 */
function createMockStore(
  existingModel: MentalModel | null = null,
  pendingObs: MentalModelObservation[] = [],
): MentalModelStore & {
  savedModels: MentalModel[];
  clearedKeys: string[];
  appendedObs: MentalModelObservation[];
} {
  const savedModels: MentalModel[] = [];
  const clearedKeys: string[] = [];
  const appendedObs: MentalModelObservation[] = [];

  return {
    savedModels,
    clearedKeys,
    appendedObs,

    async load(agentName: string, projectHash: string): Promise<MentalModel | null> {
      if (
        existingModel &&
        existingModel.agentName === agentName &&
        existingModel.projectHash === projectHash
      ) {
        // Return a deep copy to avoid mutation leaking between calls
        return JSON.parse(JSON.stringify(existingModel)) as MentalModel;
      }
      return null;
    },

    async save(model: MentalModel): Promise<void> {
      savedModels.push(JSON.parse(JSON.stringify(model)) as MentalModel);
    },

    async appendObservation(obs: MentalModelObservation): Promise<void> {
      appendedObs.push(obs);
    },

    async listPending(agentName: string, projectHash: string): Promise<MentalModelObservation[]> {
      return pendingObs.filter((o) => o.agentName === agentName && o.projectHash === projectHash);
    },

    async clearPending(agentName: string, projectHash: string): Promise<void> {
      clearedKeys.push(`${agentName}:${projectHash}`);
    },
  };
}

/**
 * Create a test observation with sensible defaults.
 *
 * @param overrides - Partial overrides for observation fields.
 * @returns A complete observation.
 */
function createObs(overrides: Partial<MentalModelObservation> = {}): MentalModelObservation {
  return {
    id: `mm-test-${Math.random().toString(36).slice(2, 8)}`,
    agentName: 'test-agent',
    projectHash: 'proj-abc',
    timestamp: new Date().toISOString(),
    content: 'Test observation',
    tokens: 10,
    trigger: 'pattern_observed',
    reinforceCount: 0,
    ...overrides,
  };
}

/** Default consolidation options for tests. */
const DEFAULT_OPTIONS: ConsolidateOptions = {
  maxTokens: 1000,
  decayAfterDays: 30,
  scope: 'project',
};

// ---------------------------------------------------------------------------
// consolidate
// ---------------------------------------------------------------------------

describe('consolidate', () => {
  it('creates fresh model when none exists', async () => {
    const store = createMockStore(null, []);
    const result = await consolidate(store, 'test-agent', 'proj-abc', DEFAULT_OPTIONS);

    expect(result.agentName).toBe('test-agent');
    expect(result.projectHash).toBe('proj-abc');
    expect(result.scope).toBe('project');
    expect(result.observations).toEqual([]);
    expect(result.totalTokens).toBe(0);
    expect(result.maxTokens).toBe(1000);
    expect(result.lastConsolidated).not.toBeNull();
    expect(store.savedModels).toHaveLength(1);
    expect(store.clearedKeys).toContain('test-agent:proj-abc');
  });

  it('returns existing model with no pending observations', async () => {
    const existing = createEmptyModel('test-agent', 'proj-abc', 'project', 1000);
    const obs = createObs({ content: 'Existing observation', tokens: 20 });
    existing.observations = [obs];
    existing.totalTokens = 20;
    existing.lastConsolidated = '2026-04-01T00:00:00Z';

    const store = createMockStore(existing, []);
    const result = await consolidate(store, 'test-agent', 'proj-abc', DEFAULT_OPTIONS);

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].content).toBe('Existing observation');
    expect(result.lastConsolidated).not.toBe('2026-04-01T00:00:00Z'); // refreshed
    expect(store.savedModels).toHaveLength(1);
  });

  it('merges pending observations into model', async () => {
    const existing = createEmptyModel('test-agent', 'proj-abc', 'project', 1000);
    existing.observations = [createObs({ content: 'Existing', tokens: 10 })];
    existing.totalTokens = 10;

    const pending = [
      createObs({ content: 'New observation 1', tokens: 15 }),
      createObs({ content: 'New observation 2', tokens: 15 }),
    ];

    const store = createMockStore(existing, pending);
    const result = await consolidate(store, 'test-agent', 'proj-abc', DEFAULT_OPTIONS);

    expect(result.observations).toHaveLength(3);
    expect(result.totalTokens).toBe(40);
  });

  it('deduplicates and reinforces matching content', async () => {
    // Use sliding timestamps relative to "now" so the test does not collide
    // with the 30-day `decayAfterDays` window when wall-clock advances.
    // Hardcoded '2026-04-05T00:00:00Z' previously matched the cutoff
    // boundary on 2026-05-05 (cutoff = 2026-04-05T<current-time>) and the
    // obs at midnight got filtered. Sliding timestamps avoid that drift.
    const reinforceTimestamp = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const originalTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    const existing = createEmptyModel('test-agent', 'proj-abc', 'project', 1000);
    const originalObs = createObs({
      content: 'DRY principle applies',
      tokens: 10,
      reinforceCount: 2,
      timestamp: originalTimestamp,
    });
    existing.observations = [originalObs];
    existing.totalTokens = 10;

    const pending = [
      createObs({
        content: 'DRY principle applies',
        tokens: 10,
        timestamp: reinforceTimestamp,
      }),
    ];

    const store = createMockStore(existing, pending);
    const result = await consolidate(store, 'test-agent', 'proj-abc', DEFAULT_OPTIONS);

    // Should NOT add a duplicate -- just reinforce the existing one
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].reinforceCount).toBe(3);
    expect(result.observations[0].timestamp).toBe(reinforceTimestamp);
    expect(result.totalTokens).toBe(10);
  });

  it('decays old observations past decayAfterDays', async () => {
    const existing = createEmptyModel('test-agent', 'proj-abc', 'project', 1000);

    // An observation from 60 days ago (should be decayed with 30-day window)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    const oldObs = createObs({
      content: 'Ancient observation',
      tokens: 10,
      timestamp: oldDate.toISOString(),
    });

    // A recent observation (should be kept)
    const recentObs = createObs({
      content: 'Recent observation',
      tokens: 10,
      timestamp: new Date().toISOString(),
    });

    existing.observations = [oldObs, recentObs];
    existing.totalTokens = 20;

    const store = createMockStore(existing, []);
    const result = await consolidate(store, 'test-agent', 'proj-abc', {
      ...DEFAULT_OPTIONS,
      decayAfterDays: 30,
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].content).toBe('Recent observation');
  });

  it('enforces token cap dropping oldest first', async () => {
    const existing = createEmptyModel('test-agent', 'proj-abc', 'project', 25);

    // Three observations totaling 30 tokens, cap is 25.
    // Use relative timestamps (1, 2, 3 days ago) to avoid decay-cutoff flakes:
    // with decayAfterDays:30 any hardcoded past date eventually falls outside
    // the retention window as real time advances (T1731 root-cause fix).
    const daysAgo = (n: number): string => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return d.toISOString();
    };

    const obs1 = createObs({
      content: 'Oldest observation',
      tokens: 10,
      timestamp: daysAgo(3),
    });
    const obs2 = createObs({
      content: 'Middle observation',
      tokens: 10,
      timestamp: daysAgo(2),
    });
    const obs3 = createObs({
      content: 'Newest observation',
      tokens: 10,
      timestamp: daysAgo(1),
    });

    existing.observations = [obs1, obs2, obs3];
    existing.totalTokens = 30;

    const store = createMockStore(existing, []);
    const result = await consolidate(store, 'test-agent', 'proj-abc', {
      ...DEFAULT_OPTIONS,
      maxTokens: 25,
    });

    // Sorted newest first: obs3, obs2, obs1. Budget 25 fits obs3(10)+obs2(10)=20, obs1 would be 30 > 25
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0].content).toBe('Newest observation');
    expect(result.observations[1].content).toBe('Middle observation');
    expect(result.totalTokens).toBe(20);
    expect(result.maxTokens).toBe(25);
  });

  it('saves consolidated model and clears pending', async () => {
    const pending = [createObs({ content: 'Pending obs', tokens: 10 })];
    const store = createMockStore(null, pending);

    await consolidate(store, 'test-agent', 'proj-abc', DEFAULT_OPTIONS);

    expect(store.savedModels).toHaveLength(1);
    expect(store.savedModels[0].observations).toHaveLength(1);
    expect(store.clearedKeys).toContain('test-agent:proj-abc');
  });
});

// ---------------------------------------------------------------------------
// renderMentalModel
// ---------------------------------------------------------------------------

describe('renderMentalModel', () => {
  it('returns empty string for empty model', () => {
    const model = createEmptyModel('test-agent', 'proj-abc', 'project', 1000);
    expect(renderMentalModel(model)).toBe('');
  });

  it('includes validation prefix', () => {
    const model = createEmptyModel('test-agent', 'proj-abc', 'project', 1000);
    model.observations = [createObs({ content: 'Some observation', trigger: 'pattern_observed' })];

    const rendered = renderMentalModel(model);

    expect(rendered).toContain('VALIDATE THIS MENTAL MODEL');
    expect(rendered).toContain('Re-evaluate each claim against current code state');
    expect(rendered).toContain('assume drift');
  });

  it('includes reinforcement counts', () => {
    const model = createEmptyModel('test-agent', 'proj-abc', 'project', 1000);
    model.observations = [
      createObs({ content: 'DRY principle', trigger: 'pattern_observed', reinforceCount: 5 }),
      createObs({ content: 'Use pnpm', trigger: 'decision_made', reinforceCount: 0 }),
    ];

    const rendered = renderMentalModel(model);

    expect(rendered).toContain('(reinforced 5x)');
    expect(rendered).toContain('(reinforced 0x)');
  });

  it('formats observations with trigger tags', () => {
    const model = createEmptyModel('test-agent', 'proj-abc', 'project', 1000);
    model.observations = [
      createObs({ content: 'Fixed auth bug', trigger: 'bug_fixed', reinforceCount: 1 }),
      createObs({ content: 'Task done', trigger: 'task_completed', reinforceCount: 0 }),
    ];

    const rendered = renderMentalModel(model);

    expect(rendered).toContain('[bug_fixed] Fixed auth bug');
    expect(rendered).toContain('[task_completed] Task done');
  });
});

// ---------------------------------------------------------------------------
// harvestObservations
// ---------------------------------------------------------------------------

describe('harvestObservations', () => {
  it('extracts patterns as pattern_observed observations', () => {
    const output: SessionOutput = {
      patternsUsed: ['DRY principle', 'Factory pattern'],
      decisionsMade: [],
      filesTouched: [],
      outcome: 'failure',
    };

    const observations = harvestObservations('test-agent', 'proj-abc', output);

    const patternObs = observations.filter((o) => o.trigger === 'pattern_observed');
    expect(patternObs).toHaveLength(2);
    expect(patternObs[0].content).toBe('Pattern applied: DRY principle');
    expect(patternObs[1].content).toBe('Pattern applied: Factory pattern');
    expect(patternObs[0].agentName).toBe('test-agent');
    expect(patternObs[0].projectHash).toBe('proj-abc');
    expect(patternObs[0].reinforceCount).toBe(0);
  });

  it('extracts decisions as decision_made observations', () => {
    const output: SessionOutput = {
      patternsUsed: [],
      decisionsMade: ['Use JWT for auth', 'Migrate to ESM'],
      filesTouched: [],
      outcome: 'failure',
    };

    const observations = harvestObservations('test-agent', 'proj-abc', output);

    const decisionObs = observations.filter((o) => o.trigger === 'decision_made');
    expect(decisionObs).toHaveLength(2);
    expect(decisionObs[0].content).toBe('Decision: Use JWT for auth');
    expect(decisionObs[1].content).toBe('Decision: Migrate to ESM');
    expect(decisionObs[0].reinforceCount).toBe(0);
  });

  it('records task completion on success outcome', () => {
    const output: SessionOutput = {
      patternsUsed: [],
      decisionsMade: [],
      filesTouched: ['src/index.ts', 'tests/index.test.ts'],
      outcome: 'success',
    };

    const observations = harvestObservations('test-agent', 'proj-abc', output);

    const completionObs = observations.filter((o) => o.trigger === 'task_completed');
    expect(completionObs).toHaveLength(1);
    expect(completionObs[0].content).toContain('Task completed successfully');
    expect(completionObs[0].content).toContain('src/index.ts');
    expect(completionObs[0].content).toContain('tests/index.test.ts');
  });

  it('does not record task completion on failure outcome', () => {
    const output: SessionOutput = {
      patternsUsed: ['Some pattern'],
      decisionsMade: [],
      filesTouched: ['src/broken.ts'],
      outcome: 'failure',
    };

    const observations = harvestObservations('test-agent', 'proj-abc', output);

    const completionObs = observations.filter((o) => o.trigger === 'task_completed');
    expect(completionObs).toHaveLength(0);
    // Pattern should still be recorded
    expect(observations).toHaveLength(1);
    expect(observations[0].trigger).toBe('pattern_observed');
  });

  it('does not record task completion on partial outcome', () => {
    const output: SessionOutput = {
      patternsUsed: [],
      decisionsMade: ['Chose approach A'],
      filesTouched: ['src/partial.ts'],
      outcome: 'partial',
    };

    const observations = harvestObservations('test-agent', 'proj-abc', output);

    const completionObs = observations.filter((o) => o.trigger === 'task_completed');
    expect(completionObs).toHaveLength(0);
    expect(observations).toHaveLength(1);
    expect(observations[0].trigger).toBe('decision_made');
  });

  it('estimates tokens for observation content', () => {
    const output: SessionOutput = {
      patternsUsed: ['A pattern with some length'],
      decisionsMade: [],
      filesTouched: [],
      outcome: 'failure',
    };

    const observations = harvestObservations('test-agent', 'proj-abc', output);

    expect(observations).toHaveLength(1);
    const expectedContent = 'Pattern applied: A pattern with some length';
    expect(observations[0].tokens).toBe(Math.ceil(expectedContent.length / 4));
  });

  it('returns empty array for session with no extractable data', () => {
    const output: SessionOutput = {
      patternsUsed: [],
      decisionsMade: [],
      filesTouched: [],
      outcome: 'failure',
    };

    const observations = harvestObservations('test-agent', 'proj-abc', output);

    expect(observations).toEqual([]);
  });

  it('assigns unique IDs to all observations', () => {
    const output: SessionOutput = {
      patternsUsed: ['Pattern A', 'Pattern B'],
      decisionsMade: ['Decision C'],
      filesTouched: ['file.ts'],
      outcome: 'success',
    };

    const observations = harvestObservations('test-agent', 'proj-abc', output);

    const ids = observations.map((o) => o.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^mm-/);
    }
  });
});
