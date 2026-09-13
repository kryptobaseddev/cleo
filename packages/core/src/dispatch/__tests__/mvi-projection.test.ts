/**
 * Unit tests for MVI record projection (T9922 / Saga T9855 / E8.3).
 *
 * Verifies the per-kind allow-lists, the dispatch-level routing table, and
 * the opt-out resolver.
 */

import { TokenEstimator } from '@cleocode/lafs';
import { describe, expect, it } from 'vitest';
import {
  applyProjectionPlan,
  PROJECTION_PLANS,
  projectMVI,
  projectMvi,
  projectMviList,
  resolveProjectionMode,
  WITHHELD_KEY,
} from '../mvi-projection.js';

const FULL_TASK = {
  id: 'T9922',
  title: 'MVI projection default',
  description: 'Long description that should be stripped under MVI.',
  status: 'pending',
  priority: 'high',
  type: 'task',
  parentId: 'T9919',
  kind: 'work',
  acceptance: ['ac1', 'ac2'],
  verification: { passed: false, round: 1 },
  createdAt: '2026-05-21T16:31:48.186Z',
  updatedAt: '2026-05-24T07:17:45.193Z',
  completedAt: null,
  cancelledAt: null,
  position: 3,
  positionVersion: 0,
  relates: [],
  labels: ['e8', 'lafs'],
  size: 'medium',
  epicLifecycle: null,
  noAutoComplete: null,
  origin: null,
  pipelineStage: 'research',
  scope: 'feature',
  severity: null,
} as const;

const FULL_DOC = {
  id: 'att_abc123',
  sha256: 'deadbeef'.repeat(8),
  kind: 'blob',
  mime: 'application/json',
  size: 1024,
  slug: 'my-doc',
  type: 'changeset',
  createdAt: '2026-05-24T00:00:00.000Z',
  refCount: 1,
  description: 'Test doc',
  labels: ['e8'],
  ownerId: 'T9922',
  ownerType: 'task',
} as const;

describe('projectMvi', () => {
  it('keeps the allow-listed task fields, plus the withheld marker (T12121)', () => {
    const out = projectMvi(FULL_TASK, 'task');
    // `_withheld` is part of the projected surface as of T12121 (GH #1243):
    // a field that exists on the record is either present in the envelope or
    // explicitly named as withheld. See WITHHELD_KEY.
    expect(Object.keys(out).sort()).toEqual(
      ['_withheld', 'id', 'kind', 'parentId', 'priority', 'status', 'title', 'type'].sort(),
    );
    expect(out.id).toBe('T9922');
    expect(out.title).toBe('MVI projection default');
    expect(out.status).toBe('pending');
  });

  it('drops description / verification / acceptance / labels under task mode', () => {
    const out = projectMvi(FULL_TASK, 'task') as Record<string, unknown>;
    expect(out['description']).toBeUndefined();
    expect(out['verification']).toBeUndefined();
    expect(out['acceptance']).toBeUndefined();
    expect(out['labels']).toBeUndefined();
    expect(out['createdAt']).toBeUndefined();
  });

  it('NAMES every dropped field that had content, with its size (T12121)', () => {
    const out = projectMvi(FULL_TASK, 'task') as Record<string, unknown>;
    const withheld = out[WITHHELD_KEY] as Record<string, number>;

    // The field whose silent absence caused a destructive overwrite.
    expect(withheld['description']).toBe(FULL_TASK.description.length);
    expect(withheld['verification']).toBeGreaterThan(0);
    expect(withheld['acceptance']).toBeGreaterThan(0);
    expect(withheld['labels']).toBeGreaterThan(0);
    expect(withheld['createdAt']).toBeGreaterThan(0);

    // Allow-listed (thus present) fields are never reported as withheld.
    for (const kept of ['id', 'title', 'status', 'priority', 'type', 'parentId', 'kind']) {
      expect(withheld).not.toHaveProperty(kept);
    }
  });

  it('does NOT reproduce a withheld value — only its size (T12121)', () => {
    // A truncated copy under the real field name would let a consumer read it
    // and write it back, silently CORRUPTING the record. A size is inert.
    const out = projectMvi(FULL_TASK, 'task') as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('Long description');
    expect(typeof (out[WITHHELD_KEY] as Record<string, unknown>)['description']).toBe('number');
  });

  it('omits the marker entirely for a genuine stub — absence of marker means complete', () => {
    // This is the distinction the 2026-09-12 incident confused: a title-only
    // stub carries NO marker, so an agent can tell "nothing was hidden" from
    // "a 1440-character description was hidden".
    const stub = {
      id: 'T001',
      title: 'stub',
      status: 'pending',
      priority: 'medium',
      type: 'task',
      kind: 'work',
      description: '',
      verification: null,
      acceptance: [],
    };
    const out = projectMvi(stub, 'task') as Record<string, unknown>;
    expect(out).not.toHaveProperty(WITHHELD_KEY);
  });

  it('keeps childRollup on epic kind but drops it on task kind', () => {
    const withRollup = { ...FULL_TASK, childRollup: { total: 5, done: 2 } };
    const epic = projectMvi(withRollup, 'epic') as Record<string, unknown>;
    const task = projectMvi(withRollup, 'task') as Record<string, unknown>;
    expect(epic['childRollup']).toEqual({ total: 5, done: 2 });
    expect(task['childRollup']).toBeUndefined();
  });

  it('keeps allow-listed doc fields and drops the rest', () => {
    const out = projectMvi(FULL_DOC, 'doc') as Record<string, unknown>;
    expect(out['id']).toBe('att_abc123');
    expect(out['slug']).toBe('my-doc');
    expect(out['type']).toBe('changeset');
    expect(out['ownerId']).toBeUndefined();
    expect(out['ownerType']).toBeUndefined();
    expect(out['labels']).toBeUndefined();
  });

  it('passes records through unchanged for unknown kind', () => {
    const out = projectMvi(FULL_TASK, 'unknown');
    expect(out).toBe(FULL_TASK);
  });
});

describe('projectMviList', () => {
  it('projects every element of an array', () => {
    const list = [FULL_TASK, { ...FULL_TASK, id: 'T1' }];
    const out = projectMviList(list, 'task');
    expect(out).toHaveLength(2);
    for (const row of out) {
      expect(row.id).toBeDefined();
      expect((row as Record<string, unknown>)['description']).toBeUndefined();
    }
  });

  it('returns an empty array unchanged in shape', () => {
    expect(projectMviList([], 'task')).toEqual([]);
  });
});

describe('resolveProjectionMode', () => {
  it('returns mvi when the opt-out signal is absent', () => {
    expect(resolveProjectionMode(undefined)).toBe('mvi');
    expect(resolveProjectionMode(false)).toBe('mvi');
  });

  it('returns full when the opt-out signal is true', () => {
    expect(resolveProjectionMode(true)).toBe('full');
  });
});

describe('PROJECTION_PLANS — SSoT for read ops', () => {
  it('declares plans for the T9922 acceptance ops', () => {
    expect(PROJECTION_PLANS['tasks.show']).toBeDefined();
    expect(PROJECTION_PLANS['tasks.list']).toBeDefined();
    expect(PROJECTION_PLANS['tasks.find']).toBeDefined();
    expect(PROJECTION_PLANS['docs.list']).toBeDefined();
    expect(PROJECTION_PLANS['docs.fetch']).toBeDefined();
  });

  it('does not project mutate ops by default', () => {
    expect(PROJECTION_PLANS['tasks.add']).toBeUndefined();
    expect(PROJECTION_PLANS['tasks.update']).toBeUndefined();
    expect(PROJECTION_PLANS['tasks.complete']).toBeUndefined();
  });
});

describe('applyProjectionPlan — the exact `cleo show` path (T12121 · GH #1243)', () => {
  /**
   * This is the end-to-end shape of the 2026-09-12 data-loss incident:
   * `cleo show T289` routes through PROJECTION_PLANS['tasks.show'], which
   * projected `data.task` and dropped `description` with no trace. The second
   * agent read `task.description`, got nothing, concluded "title-only stub",
   * and overwrote a 1440-character description.
   */
  it('marks a withheld description so absence can no longer read as empty', () => {
    const description = 'x'.repeat(1440);
    const data = {
      task: {
        id: 'T289',
        title: 'filed with a full mechanism description',
        status: 'pending',
        priority: 'high',
        type: 'task',
        kind: 'bug',
        description,
        verification: { passed: false },
      },
      view: {},
      attachments: [],
    };

    const out = applyProjectionPlan(data, 'tasks.show', 'mvi') as {
      task: Record<string, unknown>;
    };

    // The pre-fix behaviour: the key is still absent...
    expect(out.task['description']).toBeUndefined();
    // ...but the envelope now SAYS so, with the size that distinguishes a
    // populated field from a genuine stub.
    const withheld = out.task[WITHHELD_KEY] as Record<string, number>;
    expect(withheld['description']).toBe(1440);
    expect(withheld['verification']).toBeGreaterThan(0);

    // And the value itself is not reproduced, so nothing invites a round-trip.
    expect(JSON.stringify(out.task)).not.toContain(description);
  });

  it('leaves a genuine stub unmarked, so "no marker" means "nothing hidden"', () => {
    const data = {
      task: {
        id: 'T290',
        title: 'genuinely a stub',
        status: 'pending',
        priority: 'medium',
        type: 'task',
        kind: 'work',
        description: null,
      },
    };
    const out = applyProjectionPlan(data, 'tasks.show', 'mvi') as {
      task: Record<string, unknown>;
    };
    expect(out.task).not.toHaveProperty(WITHHELD_KEY);
  });

  it('marks withheld fields on every row of a list, not just single records', () => {
    const data = {
      tasks: [
        { id: 'T1', title: 'a', status: 'pending', description: 'some real content' },
        { id: 'T2', title: 'b', status: 'pending' },
      ],
    };
    const out = applyProjectionPlan(data, 'tasks.list', 'mvi') as {
      tasks: Record<string, unknown>[];
    };
    expect((out.tasks[0]?.[WITHHELD_KEY] as Record<string, number>)['description']).toBe(17);
    expect(out.tasks[1]).not.toHaveProperty(WITHHELD_KEY);
  });
});

describe('applyProjectionPlan', () => {
  it('projects tasks.show data.task under mvi mode while preserving relation counts', () => {
    const relationCounts = { depends: 1, blockedBy: 0, relates: 2, children: 3, docs: 4 };
    const data = { task: { ...FULL_TASK, relationCounts }, view: null, attachments: [] };
    const out = applyProjectionPlan(data, 'tasks.show', 'mvi') as {
      task: Record<string, unknown>;
      view: null;
      attachments: unknown[];
    };
    expect(out.task['description']).toBeUndefined();
    expect(out.task['verification']).toBeUndefined();
    expect(out.task['id']).toBe('T9922');
    expect(out.task['relationCounts']).toEqual(relationCounts);
    // sibling fields preserved
    expect(out.view).toBeNull();
    expect(out.attachments).toEqual([]);
  });

  it('is a no-op under full mode', () => {
    const data = { task: FULL_TASK, view: null, attachments: [] };
    const out = applyProjectionPlan(data, 'tasks.show', 'full');
    expect(out).toBe(data);
  });

  it('projects every element of tasks.list data.tasks', () => {
    const data = { tasks: [FULL_TASK, { ...FULL_TASK, id: 'T1' }], total: 2, filtered: 2 };
    const out = applyProjectionPlan(data, 'tasks.list', 'mvi') as {
      tasks: Record<string, unknown>[];
      total: number;
      filtered: number;
    };
    expect(out.tasks).toHaveLength(2);
    for (const t of out.tasks) {
      expect(t['description']).toBeUndefined();
      expect(t['id']).toBeDefined();
    }
    expect(out.total).toBe(2);
  });

  it('projects every element of tasks.find data.results', () => {
    const data = { results: [FULL_TASK], total: 1 };
    const out = applyProjectionPlan(data, 'tasks.find', 'mvi') as {
      results: Record<string, unknown>[];
    };
    expect(out.results[0]['description']).toBeUndefined();
    expect(out.results[0]['id']).toBe('T9922');
  });

  it('projects docs.list data.attachments', () => {
    const data = { ownerId: '', ownerType: 'task', count: 1, attachments: [FULL_DOC] };
    const out = applyProjectionPlan(data, 'docs.list', 'mvi') as {
      attachments: Record<string, unknown>[];
    };
    expect(out.attachments[0]['ownerId']).toBeUndefined();
    expect(out.attachments[0]['ownerType']).toBeUndefined();
    expect(out.attachments[0]['slug']).toBe('my-doc');
  });

  it('projects docs.fetch data.metadata', () => {
    const data = { metadata: FULL_DOC, sizeBytes: 1024, inlined: false };
    const out = applyProjectionPlan(data, 'docs.fetch', 'mvi') as {
      metadata: Record<string, unknown>;
      sizeBytes: number;
      inlined: boolean;
    };
    expect(out.metadata['ownerId']).toBeUndefined();
    expect(out.metadata['ownerType']).toBeUndefined();
    expect(out.metadata['slug']).toBe('my-doc');
    expect(out.sizeBytes).toBe(1024);
    expect(out.inlined).toBe(false);
  });

  it('returns data unchanged when the operation has no plan', () => {
    const data = { foo: 'bar' };
    expect(applyProjectionPlan(data, 'tasks.add', 'mvi')).toBe(data);
    expect(applyProjectionPlan(data, 'memory.find', 'mvi')).toBe(data);
  });

  it('is safe when the target path is missing from the envelope', () => {
    const data = { total: 0 };
    expect(applyProjectionPlan(data, 'tasks.list', 'mvi')).toBe(data);
  });

  it('passes through null / undefined / primitive data', () => {
    expect(applyProjectionPlan(null, 'tasks.show', 'mvi')).toBeNull();
    expect(applyProjectionPlan(undefined, 'tasks.show', 'mvi')).toBeUndefined();
    expect(applyProjectionPlan(42, 'tasks.show', 'mvi')).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// projectMVI — generalized, budget-aware projector (T11351 · Epic T11285)
// ---------------------------------------------------------------------------

describe('projectMVI generalized projector (T11351)', () => {
  it('known kind keeps the same allow-list as projectMvi', () => {
    const viaNew = projectMVI(FULL_TASK, { kind: 'task' });
    const viaOld = projectMvi(FULL_TASK, 'task');
    expect(viaNew).toEqual(viaOld);
    expect(viaNew).not.toHaveProperty('description');
    expect(viaNew).not.toHaveProperty('acceptance');
  });

  it("mode 'full' returns the record unchanged", () => {
    expect(projectMVI(FULL_TASK, { kind: 'task', mode: 'full' })).toBe(FULL_TASK);
  });

  it('UNKNOWN kind degrades to generic identity fields — never the full payload', () => {
    const weird = {
      id: 'X1',
      name: 'widget',
      status: 'active',
      secretBlob: 'x'.repeat(5000),
      internalState: { a: 1, b: 2, c: 3 },
      audit: ['e1', 'e2', 'e3'],
    };
    const projected = projectMVI(weird, { kind: 'unknown' });
    // Identity/routing kept...
    expect(projected).toHaveProperty('id', 'X1');
    expect(projected).toHaveProperty('name', 'widget');
    expect(projected).toHaveProperty('status', 'active');
    // ...full payload NOT leaked.
    expect(projected).not.toHaveProperty('secretBlob');
    expect(projected).not.toHaveProperty('internalState');
    expect(projected).not.toHaveProperty('audit');
  });

  it('an unrecognized kind string is treated as unknown (no leak)', () => {
    const weird = { id: 'Y1', title: 'thing', payload: 'p'.repeat(2000) };
    // `as` only to feign an out-of-band kind value at the boundary.
    const projected = projectMVI(weird, { kind: 'mysteryKind' as never });
    expect(projected).toHaveProperty('id', 'Y1');
    expect(projected).not.toHaveProperty('payload');
  });

  it('honors a real token budget — reduces output below the budget', () => {
    const estimator = new TokenEstimator();
    const before = estimator.estimate(projectMvi(FULL_TASK, 'task'));
    // Pick a budget well below the full MVI field-set estimate.
    const budget = Math.max(1, Math.floor(before / 2));
    const reduced = projectMVI(FULL_TASK, { kind: 'task', budget });
    expect(estimator.estimate(reduced)).toBeLessThanOrEqual(budget);
    // id stays routable through reduction.
    expect(reduced).toHaveProperty('id', 'T9922');
  });

  it('keeps id as the last-resort minimum under a tiny budget', () => {
    const reduced = projectMVI(FULL_TASK, { kind: 'task', budget: 1 });
    expect(reduced).toHaveProperty('id', 'T9922');
    // Everything else dropped to honor the budget.
    expect(Object.keys(reduced)).toEqual(['id']);
  });

  it('an unknown-kind over-budget record both avoids leak AND fits the budget', () => {
    const estimator = new TokenEstimator();
    const weird = {
      id: 'Z9',
      title: 'big',
      status: 'open',
      bulk: 'q'.repeat(8000),
    };
    const budget = 8;
    const projected = projectMVI(weird, { kind: 'unknown', budget });
    expect(projected).not.toHaveProperty('bulk');
    expect(estimator.estimate(projected)).toBeLessThanOrEqual(budget);
    expect(projected).toHaveProperty('id', 'Z9');
  });

  it('no budget → pure field-allow-listing (no estimator pass)', () => {
    const projected = projectMVI(FULL_TASK, { kind: 'task' });
    expect(projected).toHaveProperty('priority', 'high');
    expect(projected).toHaveProperty('parentId', 'T9919');
  });

  it('passes through null / primitive / array inputs unchanged', () => {
    expect(projectMVI(null as never, { kind: 'task' })).toBeNull();
    expect(projectMVI(42 as never, { kind: 'task' })).toBe(42);
    const arr = [{ id: 'A' }] as never;
    expect(projectMVI(arr, { kind: 'task' })).toBe(arr);
  });
});
