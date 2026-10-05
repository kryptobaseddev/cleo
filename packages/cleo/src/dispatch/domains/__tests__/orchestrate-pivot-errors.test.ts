/**
 * `orchestrate pivot` renders a re-numbered task as `E_TASK_RENAMED` (exit 26),
 * never `E_GENERAL`; the gateway maps the code both ways (T12800).
 *
 * @task T12800
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The orchestrate domain loads pivotTask from its defining module (T13126).
vi.mock('@cleocode/core/orchestrate/pivot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/orchestrate/pivot')>()),
  pivotTask: vi.fn(),
}));

import { CleoError } from '@cleocode/core/internal';
import { pivotTask } from '@cleocode/core/orchestrate/pivot';
import { mapNumericExitCodeToString, STRING_TO_EXIT } from '@cleocode/runtime/gateway';
import { OrchestrateHandler } from '../orchestrate.js';

describe('E_TASK_RENAMED (exit 26) is a public contract (T12800)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the gateway maps it both ways', () => {
    expect(STRING_TO_EXIT['E_TASK_RENAMED']).toBe(26);
    expect(mapNumericExitCodeToString(26)).toBe('E_TASK_RENAMED');
  });

  it('a pivot whose task was re-numbered renders E_TASK_RENAMED with the new id', async () => {
    vi.mocked(pivotTask).mockRejectedValue(
      new CleoError(26, 'Task T004 is now T950', {
        fix: "Re-read it with 'cleo show T950' and retry against T950.",
        details: { field: 'taskId', actual: 'T004', expected: 'T950' },
      }),
    );
    const result = await new OrchestrateHandler().mutate('pivot', {
      fromTaskId: 'T004',
      toTaskId: 'T005',
      reason: 'sidetrack',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'E_TASK_RENAMED',
      exitCode: 26,
      details: { expected: 'T950' },
    });
  });
});
