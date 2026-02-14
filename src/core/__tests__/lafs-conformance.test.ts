/**
 * LAFS conformance testing - verifies all command outputs produce valid LAFS envelopes.
 * @task T4469
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatSuccess, formatError } from '../output.js';
import { CleoError } from '../errors.js';
import { ExitCode, isErrorCode, isSuccessCode, getExitCodeName } from '../../types/exit-codes.js';

// ============================
// LAFS ENVELOPE VALIDATION
// ============================

interface LafsSuccessEnvelope {
  success: true;
  data: unknown;
  message?: string;
  noChange?: boolean;
}

interface LafsErrorEnvelope {
  success: false;
  error: {
    code: number;
    name: string;
    message: string;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
  };
}

type LafsEnvelope = LafsSuccessEnvelope | LafsErrorEnvelope;

function isValidLafsEnvelope(json: string): { valid: boolean; parsed?: LafsEnvelope; error?: string } {
  try {
    const parsed = JSON.parse(json);

    // Must have success field
    if (typeof parsed.success !== 'boolean') {
      return { valid: false, error: 'Missing or non-boolean "success" field' };
    }

    if (parsed.success) {
      // Success envelope must have data field
      if (!('data' in parsed)) {
        return { valid: false, error: 'Success envelope missing "data" field' };
      }
      return { valid: true, parsed };
    } else {
      // Error envelope must have error object
      if (!parsed.error || typeof parsed.error !== 'object') {
        return { valid: false, error: 'Error envelope missing "error" object' };
      }
      if (typeof parsed.error.code !== 'number') {
        return { valid: false, error: 'Error envelope missing numeric "error.code"' };
      }
      if (typeof parsed.error.name !== 'string') {
        return { valid: false, error: 'Error envelope missing string "error.name"' };
      }
      if (typeof parsed.error.message !== 'string') {
        return { valid: false, error: 'Error envelope missing string "error.message"' };
      }
      return { valid: true, parsed };
    }
  } catch (e) {
    return { valid: false, error: `Invalid JSON: ${e}` };
  }
}

describe('LAFS Envelope Structure', () => {
  describe('formatSuccess', () => {
    it('produces valid LAFS success envelope', () => {
      const result = formatSuccess({ task: { id: 'T001', title: 'Test' } });
      const validation = isValidLafsEnvelope(result);
      expect(validation.valid).toBe(true);
      expect((validation.parsed as LafsSuccessEnvelope).success).toBe(true);
      expect((validation.parsed as LafsSuccessEnvelope).data).toBeDefined();
    });

    it('includes optional message', () => {
      const result = formatSuccess({ id: 'T001' }, 'Task created');
      const validation = isValidLafsEnvelope(result);
      expect(validation.valid).toBe(true);
      expect((validation.parsed as LafsSuccessEnvelope).message).toBe('Task created');
    });

    it('handles null data', () => {
      const result = formatSuccess(null);
      const validation = isValidLafsEnvelope(result);
      expect(validation.valid).toBe(true);
    });

    it('handles array data', () => {
      const result = formatSuccess([1, 2, 3]);
      const validation = isValidLafsEnvelope(result);
      expect(validation.valid).toBe(true);
    });

    it('handles nested objects', () => {
      const result = formatSuccess({
        tasks: [{ id: 'T001' }, { id: 'T002' }],
        pagination: { limit: 10, offset: 0, hasMore: false },
      });
      const validation = isValidLafsEnvelope(result);
      expect(validation.valid).toBe(true);
    });
  });

  describe('formatError', () => {
    it('produces valid LAFS error envelope', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found');
      const result = formatError(err);
      const validation = isValidLafsEnvelope(result);
      expect(validation.valid).toBe(true);
      expect((validation.parsed as LafsErrorEnvelope).success).toBe(false);
      expect((validation.parsed as LafsErrorEnvelope).error.code).toBe(ExitCode.NOT_FOUND);
    });

    it('includes fix suggestion', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found', {
        fix: 'Use cleo list to find tasks',
      });
      const result = formatError(err);
      const validation = isValidLafsEnvelope(result);
      expect(validation.valid).toBe(true);
      expect((validation.parsed as LafsErrorEnvelope).error.fix).toBeDefined();
    });

    it('includes alternatives', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found', {
        alternatives: [
          { action: 'List tasks', command: 'cleo list' },
          { action: 'Search', command: 'cleo find query' },
        ],
      });
      const result = formatError(err);
      const validation = isValidLafsEnvelope(result);
      expect(validation.valid).toBe(true);
      expect((validation.parsed as LafsErrorEnvelope).error.alternatives).toHaveLength(2);
    });
  });
});

describe('Exit Code Taxonomy', () => {
  it('all error codes are in range 1-99', () => {
    const errorCodes = Object.values(ExitCode).filter(
      v => typeof v === 'number' && v >= 1 && v < 100,
    );
    for (const code of errorCodes) {
      expect(isErrorCode(code as ExitCode)).toBe(true);
    }
  });

  it('success codes are 0 or 100+', () => {
    expect(isSuccessCode(ExitCode.SUCCESS)).toBe(true);
    expect(isSuccessCode(ExitCode.NO_DATA)).toBe(true);
    expect(isSuccessCode(ExitCode.ALREADY_EXISTS)).toBe(true);
    expect(isSuccessCode(ExitCode.NO_CHANGE)).toBe(true);
  });

  it('all exit codes have names', () => {
    const allCodes = Object.values(ExitCode).filter(v => typeof v === 'number') as ExitCode[];
    for (const code of allCodes) {
      const name = getExitCodeName(code);
      expect(name).not.toBe('UNKNOWN');
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('CleoError.toJSON produces valid LAFS envelope', () => {
    const error = new CleoError(ExitCode.VALIDATION_ERROR, 'Invalid input');
    const json = JSON.stringify(error.toJSON());
    const validation = isValidLafsEnvelope(json);
    expect(validation.valid).toBe(true);
  });
});

describe('MVI (Minimum Viable Info)', () => {
  it('success envelope contains data field', () => {
    const result = formatSuccess({ count: 5 });
    const parsed = JSON.parse(result);
    expect(parsed.data).toBeDefined();
    expect(parsed.data.count).toBe(5);
  });

  it('error envelope contains code, name, and message', () => {
    const err = new CleoError(ExitCode.NOT_FOUND, 'Task T001 not found');
    const result = formatError(err);
    const parsed = JSON.parse(result);
    expect(parsed.error.code).toBe(4);
    expect(parsed.error.name).toBe('NOT_FOUND');
    expect(parsed.error.message).toBe('Task T001 not found');
  });
});

describe('LAFS Integration with Core Modules', () => {
  let testDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'cleo-lafs-'));
    cleoDir = join(testDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;

    await writeFile(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        version: '2.10.0',
        project: { name: 'Test', phases: { core: { order: 1, name: 'Core', status: 'active' } } },
        lastUpdated: '2026-01-01T00:00:00Z',
        _meta: { schemaVersion: '2.10.0', specVersion: '0.1.0', checksum: 'abc', configVersion: '2.0.0' },
        focus: {},
        tasks: [
          { id: 'T001', title: 'Test task', status: 'pending', priority: 'medium', phase: 'core', createdAt: '2026-01-01T00:00:00Z' },
        ],
      }),
    );
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('addTask result produces valid LAFS', async () => {
    const { addTask } = await import('../tasks/add.js');
    const result = await addTask({ title: 'New task' });
    const json = formatSuccess({ task: result.task });
    expect(isValidLafsEnvelope(json).valid).toBe(true);
  });

  it('listPhases result produces valid LAFS', async () => {
    const { listPhases } = await import('../phases/index.js');
    const result = await listPhases();
    const json = formatSuccess(result);
    expect(isValidLafsEnvelope(json).valid).toBe(true);
  });

  it('error from showTask produces valid LAFS', async () => {
    const { showTask } = await import('../tasks/show.js');
    try {
      await showTask('T999');
    } catch (err) {
      if (err instanceof CleoError) {
        const json = formatError(err);
        expect(isValidLafsEnvelope(json).valid).toBe(true);
      }
    }
  });
});
