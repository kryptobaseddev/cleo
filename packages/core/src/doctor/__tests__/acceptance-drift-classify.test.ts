/**
 * Unit coverage for the acceptance composition rule (gh#1290 · T12157).
 *
 * The rule is the load-bearing part of the scan and it was got WRONG twice
 * before it was measured, so it is tested directly rather than through a
 * database. Both wrong versions are pinned as explicit counter-examples: a rule
 * that silently reverts to `json == text` would pass a naive test suite while
 * mis-reporting 88 tasks.
 *
 * @task T12157
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AcceptanceDriftEntry, AcceptanceDriftScanResult } from '../acceptance-drift.js';
import {
  classifyAcceptanceDrift,
  readAcceptanceDriftBaseline,
  writeAcceptanceDriftBaseline,
} from '../acceptance-drift.js';

/** A drifting entry created before the convention settled. */
function entry(taskId: string, createdAt: string): AcceptanceDriftEntry {
  return {
    taskId,
    type: 'task',
    kind: 'count-mismatch',
    jsonCount: 3,
    textRowCount: 1,
    childRowCount: 1,
    appWritten: true,
    createdAt,
    legacyEra: createdAt < '2026-06-01',
  };
}

/** A scan result carrying nothing but the baseline path. */
function emptyScan(baselinePath: string): AcceptanceDriftScanResult {
  return {
    storePath: '/dev/null',
    storeExists: true,
    tasksScanned: 0,
    rawDisagreements: 0,
    entries: [],
    byKind: {
      'json-never-projected': 0,
      'rows-unreadable': 0,
      'legacy-children-omitted': 0,
      'count-mismatch': 0,
    },
    currentEraDrift: 0,
    unbaselined: [],
    staleBaselineIds: [],
    baselinePath,
  };
}

describe('classifyAcceptanceDrift — the live convention is json == text + child', () => {
  it('treats an empty task as consistent', () => {
    expect(classifyAcceptanceDrift({ jsonCount: 0, textRowCount: 0, childRowCount: 0 })).toBeNull();
  });

  it('treats text-only agreement as consistent', () => {
    expect(classifyAcceptanceDrift({ jsonCount: 4, textRowCount: 4, childRowCount: 0 })).toBeNull();
  });

  it('treats a container whose children ARE in the JSON as consistent', () => {
    // T001's shape: one child projection, serialised into acceptance_json as
    // "Complete child T9092: …". 446 of 582 containers look like this.
    expect(classifyAcceptanceDrift({ jsonCount: 1, textRowCount: 0, childRowCount: 1 })).toBeNull();
  });

  it('treats a mixed container as consistent when JSON carries text AND children', () => {
    expect(classifyAcceptanceDrift({ jsonCount: 3, textRowCount: 1, childRowCount: 2 })).toBeNull();
  });

  it('flags JSON criteria that were never projected to rows', () => {
    expect(classifyAcceptanceDrift({ jsonCount: 5, textRowCount: 0, childRowCount: 0 })).toBe(
      'json-never-projected',
    );
  });

  it('flags rows with an empty JSON column — the only data-losing shape', () => {
    // `cleo show` reads the JSON column, so these criteria exist and cannot be
    // read back.
    expect(classifyAcceptanceDrift({ jsonCount: 0, textRowCount: 7, childRowCount: 0 })).toBe(
      'rows-unreadable',
    );
  });

  it('flags a container whose children are missing from the JSON as legacy', () => {
    // The pre-2026-06 convention: JSON holds exactly the text criteria.
    expect(classifyAcceptanceDrift({ jsonCount: 6, textRowCount: 6, childRowCount: 5 })).toBe(
      'legacy-children-omitted',
    );
  });

  it('flags a shortfall that is not explained by the child projections', () => {
    expect(classifyAcceptanceDrift({ jsonCount: 8, textRowCount: 4, childRowCount: 5 })).toBe(
      'count-mismatch',
    );
  });

  describe('counter-examples — rules that were believed and are wrong', () => {
    it('does NOT accept json == text when children exist (the stated-but-wrong rule)', () => {
      // If the rule ever reverts to `json == text`, this returns null and 88
      // legacy-convention tasks are silently reported as healthy.
      expect(
        classifyAcceptanceDrift({ jsonCount: 6, textRowCount: 6, childRowCount: 5 }),
      ).not.toBeNull();
    });

    it('does NOT treat an empty-JSON container as designed', () => {
      // 18 tasks were described as "containers in their designed state". Under
      // the live convention a container's children appear in the JSON, so an
      // empty JSON column beside child rows is drift, not design.
      expect(
        classifyAcceptanceDrift({ jsonCount: 0, textRowCount: 0, childRowCount: 4 }),
      ).not.toBeNull();
    });
  });
});

describe('baseline gating — creation date must not decide what fails', () => {
  it('reads an absent baseline as empty rather than as "everything accepted"', () => {
    // Failing OPEN here would reproduce the defect this module exists to catch:
    // a check that reports success for work it did not do.
    expect(readAcceptanceDriftBaseline('/nonexistent/acceptance-drift-baseline.json').size).toBe(0);
  });

  it('round-trips a baseline and excludes exactly the recorded ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'accept-drift-'));
    const baselinePath = join(dir, 'acceptance-drift-baseline.json');
    try {
      const legacyDrift = entry('T0001', '2026-04-01T00:00:00.000Z');
      const newDriftOnOldTask = entry('T0002', '2026-04-01T00:00:00.000Z');

      // Accept only the first.
      writeAcceptanceDriftBaseline({
        ...emptyScan(baselinePath),
        entries: [legacyDrift],
      });

      const baselined = readAcceptanceDriftBaseline(baselinePath);
      expect(baselined.has('T0001')).toBe(true);

      // THE REGRESSION THIS GUARDS: T0002 was created in April, so a gate keyed
      // on creation date calls it "legacy" and stays green forever. Measured on
      // the real store, 223 pre-convention tasks have been updated since — a
      // date-keyed gate is blind to new drift across 88% of it.
      const unbaselined = [legacyDrift, newDriftOnOldTask].filter((e) => !baselined.has(e.taskId));
      expect(unbaselined.map((e) => e.taskId)).toEqual(['T0002']);
      expect(unbaselined[0]?.legacyEra).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
