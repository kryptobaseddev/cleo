/**
 * LAFS conformance testing - verifies all command outputs produce valid LAFS envelopes.
 *
 * Uses @cleocode/lafs-protocol's validateEnvelope() and runEnvelopeConformance()
 * for canonical validation instead of hand-rolled checks.
 *
 * @task T4672
 * @epic T4663
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateEnvelope, runEnvelopeConformance } from '@cleocode/lafs-protocol';
import { formatSuccess, formatError } from '../output.js';
import { CleoError } from '../errors.js';
import { ExitCode, isErrorCode, isSuccessCode, getExitCodeName } from '../../types/exit-codes.js';
import { createGatewayMeta } from '../../mcp/lib/gateway-meta.js';

// ============================
// FULL LAFS ENVELOPE VALIDATION
// ============================

/**
 * Validate a full LAFS envelope has required structural fields.
 *
 * @task T4672
 */
function isValidLafsEnvelope(json: string): { valid: boolean; error?: string } {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed.$schema !== 'string') {
      return { valid: false, error: 'Missing $schema field' };
    }
    if (!parsed._meta || typeof parsed._meta !== 'object') {
      return { valid: false, error: 'Missing _meta object' };
    }
    if (typeof parsed.success !== 'boolean') {
      return { valid: false, error: 'Missing or non-boolean "success" field' };
    }
    if (parsed.success) {
      if (!('result' in parsed)) {
        return { valid: false, error: 'Success envelope missing "result" field' };
      }
    } else {
      if (!parsed.error || typeof parsed.error !== 'object') {
        return { valid: false, error: 'Error envelope missing "error" object' };
      }
      if (typeof parsed.error.message !== 'string') {
        return { valid: false, error: 'Error envelope missing string "error.message"' };
      }
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, error: `Invalid JSON: ${e}` };
  }
}

// ============================
// PROTOCOL-BASED CONFORMANCE
// ============================

describe('LAFS Protocol Conformance (full envelope)', () => {
  describe('formatSuccess with explicit operation', () => {
    it('passes protocol validateEnvelope()', () => {
      const json = formatSuccess({ task: { id: 'T001' } }, undefined, 'tasks.show');
      const envelope = JSON.parse(json);
      const result = validateEnvelope(envelope);
      expect(result.valid).toBe(true);
    });

    it('includes $schema field', () => {
      const json = formatSuccess({ id: 'T001' }, undefined, 'tasks.add');
      const parsed = JSON.parse(json);
      expect(parsed.$schema).toBe('https://lafs.dev/schemas/v1/envelope.schema.json');
    });

    it('includes _meta with all required LAFS fields', () => {
      const json = formatSuccess({ count: 5 }, undefined, 'tasks.list');
      const parsed = JSON.parse(json);
      expect(parsed._meta).toBeDefined();
      expect(parsed._meta.specVersion).toBe('1.2.3');
      expect(parsed._meta.timestamp).toBeDefined();
      expect(parsed._meta.operation).toBe('tasks.list');
      expect(parsed._meta.requestId).toBeDefined();
      expect(parsed._meta.transport).toBe('cli');
      expect(parsed._meta.strict).toBe(true);
    });

    it('sets success=true and result field', () => {
      const json = formatSuccess({ id: 'T001' }, undefined, 'tasks.add');
      const parsed = JSON.parse(json);
      expect(parsed.success).toBe(true);
      expect(parsed.result).toEqual({ id: 'T001' });
      // In strict mode, error is omitted rather than set to null
      expect(parsed.error).toBeUndefined();
    });
  });

  describe('formatSuccess without operation (defaults to cli.output)', () => {
    it('produces full LAFS envelope with default operation', () => {
      const json = formatSuccess({ task: { id: 'T001', title: 'Test' } });
      const parsed = JSON.parse(json);
      expect(parsed.$schema).toBe('https://lafs.dev/schemas/v1/envelope.schema.json');
      expect(parsed._meta).toBeDefined();
      expect(parsed._meta.operation).toBe('cli.output');
      expect(parsed.success).toBe(true);
      expect(parsed.result).toEqual({ task: { id: 'T001', title: 'Test' } });
    });

    it('passes protocol validateEnvelope() even without explicit operation', () => {
      const json = formatSuccess({ items: [1, 2] });
      const envelope = JSON.parse(json);
      const result = validateEnvelope(envelope);
      expect(result.valid).toBe(true);
    });

    it('includes optional message', () => {
      const result = formatSuccess({ id: 'T001' }, 'Task created');
      const parsed = JSON.parse(result);
      expect(parsed.message).toBe('Task created');
    });

    it('handles null data', () => {
      const result = formatSuccess(null);
      expect(isValidLafsEnvelope(result).valid).toBe(true);
    });

    it('handles array data', () => {
      const result = formatSuccess([1, 2, 3]);
      expect(isValidLafsEnvelope(result).valid).toBe(true);
    });
  });

  describe('formatError with explicit operation', () => {
    it('passes protocol validateEnvelope()', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found');
      const json = formatError(err, 'tasks.show');
      const envelope = JSON.parse(json);
      const result = validateEnvelope(envelope);
      expect(result.valid).toBe(true);
    });

    it('produces LAFS error shape with category', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found');
      const json = formatError(err, 'tasks.show');
      const parsed = JSON.parse(json);
      expect(parsed.success).toBe(false);
      expect(parsed.result).toBeNull(); // result is required by schema even for errors
      expect(parsed.error.code).toMatch(/^E_/);
      expect(parsed.error.category).toBe('NOT_FOUND');
      expect(typeof parsed.error.retryable).toBe('boolean');
    });
  });

  describe('formatError without operation (defaults to cli.output)', () => {
    it('produces full LAFS envelope with default operation', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found');
      const json = formatError(err);
      const parsed = JSON.parse(json);
      expect(parsed.$schema).toBe('https://lafs.dev/schemas/v1/envelope.schema.json');
      expect(parsed._meta).toBeDefined();
      expect(parsed._meta.operation).toBe('cli.output');
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toMatch(/^E_/);
    });

    it('passes protocol validateEnvelope() even without explicit operation', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found');
      const json = formatError(err);
      const envelope = JSON.parse(json);
      const result = validateEnvelope(envelope);
      expect(result.valid).toBe(true);
    });

    it('includes LAFS error details', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found', {
        fix: 'Use cleo list to find tasks',
        alternatives: [
          { action: 'List tasks', command: 'cleo list' },
          { action: 'Search', command: 'cleo find query' },
        ],
      });
      const json = formatError(err);
      const parsed = JSON.parse(json);
      expect(parsed.error.details.fix).toBe('Use cleo list to find tasks');
      expect(parsed.error.details.alternatives).toHaveLength(2);
    });
  });

  describe('runEnvelopeConformance()', () => {
    it('full conformance suite passes for success envelope', () => {
      const json = formatSuccess({ items: [1, 2] }, undefined, 'system.health');
      const envelope = JSON.parse(json);
      const report = runEnvelopeConformance(envelope);
      expect(report.ok).toBe(true);
      const failedChecks = report.checks.filter((c: { pass: boolean }) => !c.pass);
      expect(failedChecks).toHaveLength(0);
    });

    it('full conformance suite passes for error envelope (except code registry)', () => {
      const err = new CleoError(ExitCode.VALIDATION_ERROR, 'Bad input');
      const json = formatError(err, 'tasks.add');
      const envelope = JSON.parse(json);
      const report = runEnvelopeConformance(envelope);
      // CLEO error codes aren't in the default LAFS registry, so
      // error_code_registered is expected to fail. All other checks pass.
      const failedChecks = report.checks
        .filter((c: { name: string; pass: boolean }) => !c.pass && c.name !== 'error_code_registered');
      expect(failedChecks).toHaveLength(0);
    });

    it('conformance passes for envelope without explicit operation', () => {
      const json = formatSuccess({ data: 'test' });
      const envelope = JSON.parse(json);
      const report = runEnvelopeConformance(envelope);
      expect(report.ok).toBe(true);
    });
  });
});

// ============================
// MCP GATEWAY META CONFORMANCE
// ============================

describe('MCP Gateway Meta', () => {
  it('createGatewayMeta includes all LAFS fields', () => {
    const startTime = Date.now();
    const meta = createGatewayMeta('cleo_query', 'tasks', 'list', startTime);
    expect(meta.specVersion).toBe('1.2.3');
    expect(meta.schemaVersion).toBe('2026.2.1');
    expect(meta.timestamp).toBeDefined();
    expect(meta.operation).toBe('list');
    expect(meta.requestId).toBeDefined();
    expect(meta.transport).toBe('sdk');
    expect(meta.strict).toBe(true);
    expect(meta.mvi).toBe('standard');
    expect(meta.contextVersion).toBe(1);
  });

  it('createGatewayMeta includes CLEO gateway extensions', () => {
    const startTime = Date.now();
    const meta = createGatewayMeta('cleo_mutate', 'session', 'start', startTime);
    expect(meta.gateway).toBe('cleo_mutate');
    expect(meta.domain).toBe('session');
    expect(typeof meta.duration_ms).toBe('number');
  });

  it('gateway meta produces unique requestId per call', () => {
    const now = Date.now();
    const m1 = createGatewayMeta('q', 'd', 'op', now);
    const m2 = createGatewayMeta('q', 'd', 'op', now);
    expect(m1.requestId).not.toBe(m2.requestId);
  });
});

// ============================
// CLEO ERROR -> LAFS ERROR
// ============================

describe('CleoError LAFS Shape', () => {
  it('toLAFSError() produces protocol-conformant error', () => {
    const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found');
    const lafsErr = err.toLAFSError();
    expect(lafsErr.code).toMatch(/^E_NOT_FOUND/);
    expect(lafsErr.category).toBe('NOT_FOUND');
    expect(typeof lafsErr.retryable).toBe('boolean');
    expect(lafsErr.message).toBe('Task not found');
  });

  it('toLAFSError() marks recoverable codes as retryable', () => {
    const err = new CleoError(ExitCode.LOCK_TIMEOUT, 'Lock held');
    const lafsErr = err.toLAFSError();
    expect(lafsErr.retryable).toBe(true);
  });

  it('toLAFSError() includes details with exitCode', () => {
    const err = new CleoError(ExitCode.VALIDATION_ERROR, 'Bad field', {
      fix: 'Check field lengths',
    });
    const lafsErr = err.toLAFSError();
    expect(lafsErr.details).toBeDefined();
    expect((lafsErr.details as Record<string, unknown>).exitCode).toBe(ExitCode.VALIDATION_ERROR);
    expect((lafsErr.details as Record<string, unknown>).fix).toBe('Check field lengths');
  });

  it('backward-compat toJSON() still produces old shape', () => {
    const err = new CleoError(ExitCode.VALIDATION_ERROR, 'Invalid input');
    const json = err.toJSON();
    expect(json.success).toBe(false);
    expect((json.error as Record<string, unknown>).code).toBe(ExitCode.VALIDATION_ERROR);
    expect((json.error as Record<string, unknown>).name).toBe('VALIDATION_ERROR');
  });
});

// ============================
// EXIT CODE TAXONOMY
// ============================

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
});

// ============================
// INTEGRATION TESTS
// ============================

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

  it('addTask result produces valid full LAFS envelope (no operation)', async () => {
    const { addTask } = await import('../tasks/add.js');
    const result = await addTask({ title: 'New task' });
    const json = formatSuccess({ task: result.task });
    expect(isValidLafsEnvelope(json).valid).toBe(true);
    const envelope = JSON.parse(json);
    const validation = validateEnvelope(envelope);
    expect(validation.valid).toBe(true);
  });

  it('addTask result produces valid full LAFS envelope (explicit operation)', async () => {
    const { addTask } = await import('../tasks/add.js');
    const result = await addTask({ title: 'Full LAFS task' });
    const json = formatSuccess({ task: result.task }, undefined, 'tasks.add');
    const envelope = JSON.parse(json);
    const validation = validateEnvelope(envelope);
    expect(validation.valid).toBe(true);
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
        const envelope = JSON.parse(json);
        const validation = validateEnvelope(envelope);
        expect(validation.valid).toBe(true);
      }
    }
  });
});
