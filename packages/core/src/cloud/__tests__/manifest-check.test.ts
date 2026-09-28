import type { Manifest } from '@cleocode/contracts/cloud';
import { describe, expect, it } from 'vitest';
import { checkManifest, sumDeltas } from '../manifest-check.js';

const H = 'a'.repeat(64);
const m = (tables: Record<string, number>, schemaVersion = 1): Manifest => ({
  schemaVersion,
  tables: Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, { rows, hash: H }])),
});

describe('checkManifest', () => {
  it('accepts genesis', () => {
    expect(checkManifest(null, m({ tasks_tasks: 10 }), {}, 1)).toEqual({ ok: true });
  });

  it('accepts growth that matches created deltas', () => {
    const between = sumDeltas([{ tasks_tasks: { created: 3, deleted: 0 } }]);
    expect(checkManifest(m({ tasks_tasks: 10 }), m({ tasks_tasks: 13 }), between, 1).ok).toBe(true);
  });

  it('accepts a shrink backed by tombstones', () => {
    const between = sumDeltas([
      { tasks_tasks: { created: 1, deleted: 0 } },
      { tasks_tasks: { created: 0, deleted: 4 } },
    ]);
    expect(checkManifest(m({ tasks_tasks: 10 }), m({ tasks_tasks: 7 }), between, 1).ok).toBe(true);
  });

  it('refuses a shrink with no tombstones: the silent data-loss case', () => {
    const v = checkManifest(
      m({ tasks_tasks: 5229, brain_observations: 5550 }),
      m({ tasks_tasks: 0, brain_observations: 5550 }),
      {},
      1,
    );
    expect(v.ok).toBe(false);
    if (!v.ok && v.code === 'E_REGRESSION') {
      expect(v.tables).toEqual([
        expect.objectContaining({
          table: 'tasks_tasks',
          expectedRows: 5229,
          actualRows: 0,
          reason: 'count-mismatch',
        }),
      ]);
    }
  });

  it('refuses a dropped table', () => {
    const v = checkManifest(
      m({ tasks_tasks: 1, brain_decisions: 2 }),
      m({ tasks_tasks: 1 }),
      {},
      1,
    );
    expect(v).toMatchObject({
      ok: false,
      code: 'E_REGRESSION',
      tables: [{ table: 'brain_decisions', reason: 'missing-table' }],
    });
  });

  it('refuses unexplained growth too: counts must be exact', () => {
    const v = checkManifest(m({ tasks_tasks: 1 }), m({ tasks_tasks: 2 }), {}, 1);
    expect(v.ok).toBe(false);
  });

  it('refuses a schema newer than the stream accepts', () => {
    expect(checkManifest(null, m({}, 9), {}, 8)).toEqual({
      ok: false,
      code: 'E_SCHEMA_AHEAD',
      schemaVersion: 9,
      maxAccepted: 8,
    });
  });

  it('accepts a new table that appears only through deltas', () => {
    const between = { docs_attachments: { created: 2, deleted: 0 } };
    expect(
      checkManifest(m({ tasks_tasks: 1 }), m({ tasks_tasks: 1, docs_attachments: 2 }), between, 1)
        .ok,
    ).toBe(true);
  });
});
