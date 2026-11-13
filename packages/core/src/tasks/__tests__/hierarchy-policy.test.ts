/**
 * Tests for hierarchy-policy module.
 * @task T5001
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CleoConfig, Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, setConfigValue } from '../../config.js';
import type { HierarchyPolicy } from '../hierarchy-policy.js';
import {
  assertNoCycle,
  assertParentExists,
  countActiveChildren,
  ENFORCEMENT_PROFILES,
  resolveHierarchyPolicy,
  validateHierarchyPlacement,
} from '../hierarchy-policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function makeConfig(hierarchy?: Partial<CleoConfig['hierarchy']>): CleoConfig {
  return {
    version: '2.0.0',
    output: {
      defaultFormat: 'json',
      showColor: false,
      showUnicode: false,
      showProgressBars: false,
      dateFormat: 'iso',
    },
    backup: { maxOperationalBackups: 10, maxSafetyBackups: 5, compressionEnabled: false },
    hierarchy: {
      maxDepth: 3,
      maxSiblings: 7,
      cascadeDelete: false,
      maxActiveSiblings: 3,
      countDoneInLimit: false,
      enforcementProfile: 'llm-agent-first',
      ...hierarchy,
    },
    session: { autoStart: false, requireNotes: false, multiSession: false },
    lifecycle: { mode: 'advisory' },
    logging: {
      level: 'info',
      filePath: 'logs/cleo.log',
      maxFileSize: 10_000_000,
      maxFiles: 5,
      auditRetentionDays: 90,
      archiveBeforePrune: true,
    },
    enforcement: {
      acceptance: { mode: 'off' as const, requiredForPriorities: [], minimumCriteria: 3 },
      session: { requiredForMutate: false },
    },
    verification: { enabled: false, maxRounds: 3, requiredGates: [] },
    sharing: { mode: 'none', commitAllowlist: [], denylist: [] },
  };
}

function llmPolicy(): HierarchyPolicy {
  return {
    enforcementProfile: 'llm-agent-first',
    maxDepth: 3,
    maxSiblings: 0,
    maxActiveSiblings: 32,
    countDoneInLimit: false,
  };
}

function humanPolicy(): HierarchyPolicy {
  return {
    enforcementProfile: 'human-cognitive',
    maxDepth: 3,
    maxSiblings: 7,
    maxActiveSiblings: 3,
    countDoneInLimit: false,
  };
}

// ===========================================================================
// resolveHierarchyPolicy
// ===========================================================================

describe('resolveHierarchyPolicy', () => {
  it('resolves llm-agent-first profile defaults', () => {
    // Build config with only enforcementProfile, no explicit field overrides
    const config = makeConfig({ enforcementProfile: 'llm-agent-first' });
    const h = config.hierarchy as unknown as Record<string, unknown>;
    delete h.maxSiblings;
    delete h.maxActiveSiblings;
    delete h.maxDepth;
    delete h.countDoneInLimit;
    const policy = resolveHierarchyPolicy(config);
    expect(policy.maxSiblings).toBe(0);
    expect(policy.maxActiveSiblings).toBe(0);
    expect(policy.maxDepth).toBe(3);
    expect(policy.countDoneInLimit).toBe(false);
    expect(policy.enforcementProfile).toBe('llm-agent-first');
  });

  it('resolves human-cognitive profile defaults', () => {
    const config = makeConfig({ enforcementProfile: 'human-cognitive' });
    const h = config.hierarchy as unknown as Record<string, unknown>;
    delete h.maxSiblings;
    delete h.maxActiveSiblings;
    delete h.maxDepth;
    delete h.countDoneInLimit;
    const policy = resolveHierarchyPolicy(config);
    expect(policy.maxSiblings).toBe(7);
    expect(policy.maxActiveSiblings).toBe(3);
    expect(policy.maxDepth).toBe(3);
    expect(policy.countDoneInLimit).toBe(false);
    expect(policy.enforcementProfile).toBe('human-cognitive');
  });

  it('explicit config fields override profile preset', () => {
    const config = makeConfig({
      enforcementProfile: 'human-cognitive',
      maxSiblings: 50,
    });
    const policy = resolveHierarchyPolicy(config);
    // maxSiblings should be overridden to 50
    expect(policy.maxSiblings).toBe(50);
    // Other fields should remain from human-cognitive preset
    expect(policy.maxActiveSiblings).toBe(3);
    expect(policy.maxDepth).toBe(3);
  });

  it('defaults to llm-agent-first when enforcementProfile not specified', () => {
    // Build a config with no explicit hierarchy overrides, then delete enforcementProfile.
    // This way the profile defaults won't be overridden by config fields.
    const config = makeConfig();
    const h = config.hierarchy as unknown as Record<string, unknown>;
    delete h.enforcementProfile;
    delete h.maxSiblings;
    delete h.maxActiveSiblings;
    delete h.maxDepth;
    delete h.countDoneInLimit;
    const policy = resolveHierarchyPolicy(config);
    // Should fall back to llm-agent-first preset
    expect(policy.maxSiblings).toBe(0);
    expect(policy.maxActiveSiblings).toBe(0);
    expect(policy.maxDepth).toBe(3);
  });

  it('overrides maxDepth from config', () => {
    const config = makeConfig({
      enforcementProfile: 'llm-agent-first',
      maxDepth: 5,
    });
    const policy = resolveHierarchyPolicy(config);
    expect(policy.maxDepth).toBe(5);
  });

  it('overrides countDoneInLimit from config', () => {
    const config = makeConfig({
      enforcementProfile: 'llm-agent-first',
      countDoneInLimit: true,
    });
    const policy = resolveHierarchyPolicy(config);
    expect(policy.countDoneInLimit).toBe(true);
  });
});

describe('resolveHierarchyPolicy with loaded configuration', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'cleo-hierarchy-policy-'));
    vi.stubEnv('CLEO_DIR', join(projectDir, '.cleo'));
    vi.stubEnv('CLEO_HOME', join(projectDir, 'global'));
    vi.stubEnv('CLEO_HIERARCHY_ENFORCEMENT_PROFILE', undefined);
    vi.stubEnv('CLEO_HIERARCHY_MAX_DEPTH', undefined);
    vi.stubEnv('CLEO_HIERARCHY_MAX_SIBLINGS', undefined);
    vi.stubEnv('CLEO_HIERARCHY_MAX_ACTIVE_SIBLINGS', undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(projectDir, { recursive: true, force: true });
  });

  it.each([
    { hierarchy: { enforcementProfile: 'human-cognitive' }, siblings: 7, active: 3 },
    {
      hierarchy: { enforcementProfile: 'human-cognitive', maxSiblings: 12, maxActiveSiblings: 5 },
      siblings: 12,
      active: 5,
    },
    {
      hierarchy: { enforcementProfile: 'human-cognitive', maxSiblings: 0, maxActiveSiblings: 0 },
      siblings: 0,
      active: 0,
    },
    {
      hierarchy: { enforcementProfile: 'human-cognitive', maxSiblings: 0 },
      siblings: 0,
      active: 3,
    },
    { hierarchy: {}, siblings: 0, active: 0 },
  ])('resolves $hierarchy to $siblings/$active caps', async ({ hierarchy, siblings, active }) => {
    await setConfigValue('hierarchy', hierarchy, projectDir);
    const config = await loadConfig(projectDir);
    expect(config.hierarchy).toMatchObject({ maxSiblings: siblings, maxActiveSiblings: active });
    expect(resolveHierarchyPolicy(config)).toMatchObject({
      maxSiblings: siblings,
      maxActiveSiblings: active,
    });
  });

  it('enforces both human-cognitive preset caps after loading', async () => {
    await setConfigValue('hierarchy.enforcementProfile', 'human-cognitive', projectDir);
    const policy = resolveHierarchyPolicy(await loadConfig(projectDir));
    const parent = makeTask({ id: 'T001', type: 'epic' });
    const children = Array.from({ length: 7 }, (_, i) =>
      makeTask({ id: `T${i + 2}`, parentId: parent.id, status: 'cancelled' }),
    );
    expect(validateHierarchyPlacement(parent.id, [parent, ...children], policy).error?.code).toBe(
      'E_SIBLING_LIMIT',
    );
    expect(
      validateHierarchyPlacement(
        parent.id,
        [parent, ...children.slice(0, 3).map((task) => ({ ...task, status: 'pending' as const }))],
        policy,
      ).error?.code,
    ).toBe('E_ACTIVE_SIBLING_LIMIT');
  });

  it('preserves global caps while a project selects the profile and overrides one cap', async () => {
    const globalDir = join(projectDir, 'global');
    await mkdir(globalDir, { recursive: true });
    await writeFile(
      join(globalDir, 'config.json'),
      JSON.stringify({ hierarchy: { maxSiblings: 11, maxActiveSiblings: 4 } }),
    );
    await setConfigValue(
      'hierarchy',
      { enforcementProfile: 'human-cognitive', maxSiblings: 0 },
      projectDir,
    );
    expect((await loadConfig(projectDir)).hierarchy).toMatchObject({
      maxSiblings: 0,
      maxActiveSiblings: 4,
    });
  });

  it('applies an environment-selected preset and explicit environment caps', async () => {
    vi.stubEnv('CLEO_HIERARCHY_ENFORCEMENT_PROFILE', 'human-cognitive');
    expect((await loadConfig(projectDir)).hierarchy).toMatchObject({
      maxSiblings: 7,
      maxActiveSiblings: 3,
    });
    await setConfigValue('hierarchy', { maxSiblings: 2, maxActiveSiblings: 1 }, projectDir);
    vi.stubEnv('CLEO_HIERARCHY_MAX_SIBLINGS', '0');
    vi.stubEnv('CLEO_HIERARCHY_MAX_ACTIVE_SIBLINGS', '5');
    expect((await loadConfig(projectDir)).hierarchy).toMatchObject({
      maxSiblings: 0,
      maxActiveSiblings: 5,
    });
  });
});

// ===========================================================================
// ENFORCEMENT_PROFILES constant
// ===========================================================================

describe('ENFORCEMENT_PROFILES', () => {
  it('has llm-agent-first and human-cognitive profiles', () => {
    expect(ENFORCEMENT_PROFILES['llm-agent-first']).toBeDefined();
    expect(ENFORCEMENT_PROFILES['human-cognitive']).toBeDefined();
  });

  it('llm-agent-first has maxSiblings=0 (unlimited)', () => {
    expect(ENFORCEMENT_PROFILES['llm-agent-first'].maxSiblings).toBe(0);
    expect(ENFORCEMENT_PROFILES['llm-agent-first'].maxActiveSiblings).toBe(0);
    expect(ENFORCEMENT_PROFILES['llm-agent-first'].maxDepth).toBe(3);
  });

  it('human-cognitive has maxSiblings=7', () => {
    expect(ENFORCEMENT_PROFILES['human-cognitive'].maxSiblings).toBe(7);
    expect(ENFORCEMENT_PROFILES['human-cognitive'].maxActiveSiblings).toBe(3);
    expect(ENFORCEMENT_PROFILES['human-cognitive'].maxDepth).toBe(3);
  });
});

// ===========================================================================
// validateHierarchyPlacement — unlimited siblings (maxSiblings=0)
// ===========================================================================

describe('validateHierarchyPlacement — unlimited siblings', () => {
  it('maxSiblings=0 allows unlimited children', () => {
    const parent = makeTask({ id: 'T001', type: 'epic' });
    const children = Array.from({ length: 20 }, (_, i) =>
      makeTask({ id: `T${String(i + 2).padStart(3, '0')}`, parentId: 'T001' }),
    );
    const tasks = [parent, ...children];
    const policy = llmPolicy(); // maxSiblings=0

    const result = validateHierarchyPlacement('T001', tasks, policy);
    expect(result.valid).toBe(true);
  });

  it('maxSiblings=7 fails when parent already has 7 children', () => {
    const parent = makeTask({ id: 'T001', type: 'epic' });
    const children = Array.from({ length: 7 }, (_, i) =>
      makeTask({ id: `T${String(i + 2).padStart(3, '0')}`, parentId: 'T001' }),
    );
    const tasks = [parent, ...children];
    const policy = humanPolicy(); // maxSiblings=7

    const result = validateHierarchyPlacement('T001', tasks, policy);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('E_SIBLING_LIMIT');
  });

  it('maxSiblings=7 succeeds when parent has fewer than 7 children', () => {
    const parent = makeTask({ id: 'T001', type: 'epic' });
    // Use 2 active children (under maxActiveSiblings=3) and stay under maxSiblings=7
    const children = Array.from({ length: 2 }, (_, i) =>
      makeTask({ id: `T${String(i + 2).padStart(3, '0')}`, parentId: 'T001' }),
    );
    const tasks = [parent, ...children];
    const policy = humanPolicy(); // maxSiblings=7, maxActiveSiblings=3

    const result = validateHierarchyPlacement('T001', tasks, policy);
    expect(result.valid).toBe(true);
  });
});

// ===========================================================================
// validateHierarchyPlacement — depth enforcement
// ===========================================================================

describe('validateHierarchyPlacement — depth enforcement', () => {
  // `maxDepth` is the maximum depth VALUE, inclusive, over the canonical spine
  // saga(0) → epic(1) → task(2) → subtask(3). These cases are written in TIER
  // names rather than bare depth integers on purpose: the previous versions
  // asserted the arithmetic over untyped fixtures, so when ADR-083/ADR-088 made
  // `saga` a real containment parent and pushed every tier down one level, they
  // kept passing while `--type subtask` became unreachable in every saga-rooted
  // project. A depth test that cannot name the tier it is protecting cannot
  // notice a tier being inserted above it.

  it('admits a subtask under a task on a saga-rooted spine (depth 3 == maxDepth)', () => {
    const tasks = [
      makeTask({ id: 'T001', type: 'saga' }),
      makeTask({ id: 'T002', type: 'epic', parentId: 'T001' }),
      makeTask({ id: 'T003', type: 'task', parentId: 'T002' }),
    ];
    const policy = llmPolicy(); // maxDepth=3

    const result = validateHierarchyPlacement('T003', tasks, policy);
    expect(result.valid).toBe(true);
  });

  it('refuses a child of a subtask (depth 4 > maxDepth)', () => {
    const tasks = [
      makeTask({ id: 'T001', type: 'saga' }),
      makeTask({ id: 'T002', type: 'epic', parentId: 'T001' }),
      makeTask({ id: 'T003', type: 'task', parentId: 'T002' }),
      makeTask({ id: 'T004', type: 'subtask', parentId: 'T003' }),
    ];
    const policy = llmPolicy(); // maxDepth=3

    const result = validateHierarchyPlacement('T004', tasks, policy);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('E_DEPTH_EXCEEDED');
  });

  it('succeeds when adding child within maxDepth', () => {
    // depth 0: T001, depth 1: T002
    // Adding child to T002 → depth 2, which is <= maxDepth(3) → OK
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002', parentId: 'T001' })];
    const policy = llmPolicy(); // maxDepth=3

    const result = validateHierarchyPlacement('T002', tasks, policy);
    expect(result.valid).toBe(true);
  });

  it('succeeds when adding child to root (depth 0)', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const policy = llmPolicy(); // maxDepth=3

    const result = validateHierarchyPlacement('T001', tasks, policy);
    expect(result.valid).toBe(true);
  });
});

// ===========================================================================
// validateHierarchyPlacement — maxActiveSiblings
// ===========================================================================

describe('validateHierarchyPlacement — maxActiveSiblings', () => {
  it('fails when active children equal maxActiveSiblings', () => {
    const parent = makeTask({ id: 'T001', type: 'epic' });
    const children = Array.from({ length: 32 }, (_, i) =>
      makeTask({ id: `T${String(i + 2).padStart(3, '0')}`, parentId: 'T001', status: 'active' }),
    );
    const tasks = [parent, ...children];
    const policy = llmPolicy(); // maxActiveSiblings=32

    const result = validateHierarchyPlacement('T001', tasks, policy);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('E_ACTIVE_SIBLING_LIMIT');
  });

  it('succeeds when active children are one less than maxActiveSiblings', () => {
    const parent = makeTask({ id: 'T001', type: 'epic' });
    const children = Array.from({ length: 31 }, (_, i) =>
      makeTask({ id: `T${String(i + 2).padStart(3, '0')}`, parentId: 'T001', status: 'active' }),
    );
    const tasks = [parent, ...children];
    const policy = llmPolicy(); // maxActiveSiblings=32

    const result = validateHierarchyPlacement('T001', tasks, policy);
    expect(result.valid).toBe(true);
  });

  it('maxActiveSiblings=0 disables active sibling check', () => {
    const parent = makeTask({ id: 'T001', type: 'epic' });
    const children = Array.from({ length: 50 }, (_, i) =>
      makeTask({ id: `T${String(i + 2).padStart(3, '0')}`, parentId: 'T001', status: 'active' }),
    );
    const tasks = [parent, ...children];
    const policy: HierarchyPolicy = {
      ...llmPolicy(),
      maxActiveSiblings: 0,
    };

    const result = validateHierarchyPlacement('T001', tasks, policy);
    expect(result.valid).toBe(true);
  });
});

// ===========================================================================
// validateHierarchyPlacement — countDoneInLimit
// ===========================================================================

describe('validateHierarchyPlacement — countDoneInLimit', () => {
  it('done children do not count when countDoneInLimit=false', () => {
    const parent = makeTask({ id: 'T001', type: 'epic' });
    const doneChildren = Array.from({ length: 7 }, (_, i) =>
      makeTask({ id: `T${String(i + 2).padStart(3, '0')}`, parentId: 'T001', status: 'done' }),
    );
    const activeChild = makeTask({ id: 'T010', parentId: 'T001', status: 'active' });
    const tasks = [parent, ...doneChildren, activeChild];
    const policy: HierarchyPolicy = {
      ...humanPolicy(),
      countDoneInLimit: false,
    };

    // 7 done + 1 active. With countDoneInLimit=false, only 1 counts → < 7 → SUCCEED
    const result = validateHierarchyPlacement('T001', tasks, policy);
    expect(result.valid).toBe(true);
  });

  it('done children count when countDoneInLimit=true', () => {
    const parent = makeTask({ id: 'T001', type: 'epic' });
    const doneChildren = Array.from({ length: 7 }, (_, i) =>
      makeTask({ id: `T${String(i + 2).padStart(3, '0')}`, parentId: 'T001', status: 'done' }),
    );
    const activeChild = makeTask({ id: 'T010', parentId: 'T001', status: 'active' });
    const tasks = [parent, ...doneChildren, activeChild];
    const policy: HierarchyPolicy = {
      ...humanPolicy(),
      countDoneInLimit: true,
    };

    // 7 done + 1 active = 8 total. With countDoneInLimit=true, 8 >= 7 → FAIL
    const result = validateHierarchyPlacement('T001', tasks, policy);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('E_SIBLING_LIMIT');
  });
});

// ===========================================================================
// validateHierarchyPlacement — hard invariants
// ===========================================================================

describe('validateHierarchyPlacement — hard invariants', () => {
  it('returns E_PARENT_NOT_FOUND when parentId not in tasks', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const policy = llmPolicy();

    const result = validateHierarchyPlacement('T999', tasks, policy);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('E_PARENT_NOT_FOUND');
  });

  it('null parentId always returns valid', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const policy = llmPolicy();

    const result = validateHierarchyPlacement(null, tasks, policy);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// ===========================================================================
// assertParentExists
// ===========================================================================

describe('assertParentExists', () => {
  it('returns null when parent is found', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const result = assertParentExists('T001', tasks);
    expect(result).toBeNull();
  });

  it('returns error when parent is not found', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const result = assertParentExists('T999', tasks);
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(result!.error?.code).toBe('E_PARENT_NOT_FOUND');
  });
});

// ===========================================================================
// assertNoCycle
// ===========================================================================

describe('assertNoCycle', () => {
  it('detects circular reference', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T002' }),
    ];
    // Setting T001 parent to T003 would create: T001 -> T002 -> T003 -> T001
    const result = assertNoCycle('T001', 'T003', tasks);
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(result!.error?.code).toBe('E_CIRCULAR_REFERENCE');
  });

  it('returns null for valid reparenting', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002' }),
      makeTask({ id: 'T003', parentId: 'T001' }),
    ];
    // Moving T003 under T002 is fine
    const result = assertNoCycle('T003', 'T002', tasks);
    expect(result).toBeNull();
  });
});

// ===========================================================================
// countActiveChildren
// ===========================================================================

describe('countActiveChildren', () => {
  it('counts only pending/active/blocked children', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001', status: 'pending' }),
      makeTask({ id: 'T003', parentId: 'T001', status: 'active' }),
      makeTask({ id: 'T004', parentId: 'T001', status: 'blocked' }),
      makeTask({ id: 'T005', parentId: 'T001', status: 'done' }),
      makeTask({ id: 'T006', parentId: 'T001', status: 'cancelled' }),
    ];
    expect(countActiveChildren('T001', tasks)).toBe(3);
  });

  it('does not count done children', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001', status: 'done' }),
      makeTask({ id: 'T003', parentId: 'T001', status: 'done' }),
    ];
    expect(countActiveChildren('T001', tasks)).toBe(0);
  });

  it('only counts direct children, not grandchildren', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001', status: 'active' }),
      makeTask({ id: 'T003', parentId: 'T002', status: 'active' }), // grandchild
    ];
    expect(countActiveChildren('T001', tasks)).toBe(1);
  });

  it('returns 0 when parent has no children', () => {
    const tasks = [makeTask({ id: 'T001' })];
    expect(countActiveChildren('T001', tasks)).toBe(0);
  });
});
