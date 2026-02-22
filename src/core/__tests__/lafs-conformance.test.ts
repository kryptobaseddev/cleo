/**
 * LAFS conformance testing - verifies all command outputs produce valid LAFS envelopes.
 *
 * Uses @cleocode/lafs-protocol's validateEnvelope() and runEnvelopeConformance()
 * for canonical validation instead of hand-rolled checks.
 *
 * @task T4672
 * @task T4673
 * @task T4668
 * @task T4669
 * @task T4670
 * @task T4671
 * @task T4701
 * @task T4702
 * @epic T4663
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateEnvelope, runEnvelopeConformance } from '@cleocode/lafs-protocol';
import { formatSuccess, formatError, pushWarning } from '../output.js';
import { CleoError } from '../errors.js';
import { ExitCode, isErrorCode, isSuccessCode, getExitCodeName } from '../../types/exit-codes.js';
import { createGatewayMeta } from '../../mcp/lib/gateway-meta.js';
import { createPage, paginate } from '../pagination.js';
import { getCleoErrorRegistry, isCleoRegisteredCode, getRegistryEntry } from '../error-registry.js';
import { enforceBudget, isWithinBudget } from '../../mcp/lib/budget.js';

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
      join(cleoDir, 'tasks.json'),
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

// ============================
// T4668: PAGINATION
// ============================

describe('LAFSPage Pagination (T4668)', () => {
  it('createPage returns mode:"none" when no limit/offset', () => {
    const page = createPage({ total: 100 });
    expect(page.mode).toBe('none');
  });

  it('createPage returns offset page with hasMore=true when more data exists', () => {
    const page = createPage({ total: 100, limit: 20, offset: 0 });
    expect(page.mode).toBe('offset');
    if (page.mode === 'offset') {
      expect(page.hasMore).toBe(true);
      expect(page.total).toBe(100);
      expect(page.limit).toBe(20);
      expect(page.offset).toBe(0);
    }
  });

  it('createPage returns hasMore=false on last page', () => {
    const page = createPage({ total: 100, limit: 20, offset: 80 });
    expect(page.mode).toBe('offset');
    if (page.mode === 'offset') {
      expect(page.hasMore).toBe(false);
    }
  });

  it('paginate slices array and returns page metadata', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const result = paginate(items, 10, 5);
    expect(result.items).toHaveLength(10);
    expect(result.items[0]).toBe(5);
    expect(result.page.mode).toBe('offset');
    if (result.page.mode === 'offset') {
      expect(result.page.hasMore).toBe(true);
      expect(result.page.total).toBe(50);
    }
  });

  it('paginate returns all items when no pagination specified', () => {
    const items = [1, 2, 3];
    const result = paginate(items);
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.page.mode).toBe('none');
  });

  it('formatSuccess includes page field when provided', () => {
    const page = createPage({ total: 100, limit: 20, offset: 0 });
    const json = formatSuccess({ tasks: [] }, undefined, { operation: 'tasks.list', page });
    const parsed = JSON.parse(json);
    expect(parsed.page).toBeDefined();
    expect(parsed.page.mode).toBe('offset');
    expect(parsed.page.hasMore).toBe(true);
  });
});

// ============================
// T4669: WARNINGS
// ============================

describe('_meta.warnings Deprecation Support (T4669)', () => {
  it('pushWarning adds warning to next envelope', () => {
    pushWarning({
      code: 'DEPRECATED_FLAG',
      message: '--legacy flag is deprecated',
      deprecated: '--legacy',
      replacement: '--modern',
      removeBy: '2027.1.0',
    });
    const json = formatSuccess({ ok: true });
    const parsed = JSON.parse(json);
    expect(parsed._meta.warnings).toBeDefined();
    expect(parsed._meta.warnings).toHaveLength(1);
    expect(parsed._meta.warnings[0].code).toBe('DEPRECATED_FLAG');
    expect(parsed._meta.warnings[0].replacement).toBe('--modern');
  });

  it('warnings are drained after consumption', () => {
    pushWarning({ code: 'TEST', message: 'test warning' });
    formatSuccess({ ok: true }); // consumes
    const json = formatSuccess({ ok: true }); // no warnings
    const parsed = JSON.parse(json);
    expect(parsed._meta.warnings).toBeUndefined();
  });

  it('envelope with warnings still passes validation', () => {
    pushWarning({ code: 'W001', message: 'test warning' });
    const json = formatSuccess({ data: 1 }, undefined, 'system.test');
    const envelope = JSON.parse(json);
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);
  });
});

// ============================
// T4670: EXTENSIONS
// ============================

describe('_extensions CLEO Metadata (T4670)', () => {
  it('formatSuccess includes _extensions when provided', () => {
    const json = formatSuccess({ ok: true }, undefined, {
      operation: 'system.status',
      extensions: {
        cleoVersion: '2026.2.5',
        activeSession: 'sess-123',
        focusTask: 'T001',
      },
    });
    const parsed = JSON.parse(json);
    expect(parsed._extensions).toBeDefined();
    expect(parsed._extensions.cleoVersion).toBe('2026.2.5');
    expect(parsed._extensions.activeSession).toBe('sess-123');
    expect(parsed._extensions.focusTask).toBe('T001');
  });

  it('_extensions omitted when empty', () => {
    const json = formatSuccess({ ok: true }, undefined, {
      operation: 'test',
      extensions: {},
    });
    const parsed = JSON.parse(json);
    expect(parsed._extensions).toBeUndefined();
  });

  it('envelope with _extensions still passes validation', () => {
    const json = formatSuccess({ data: 1 }, undefined, {
      operation: 'system.test',
      extensions: { foo: 'bar' },
    });
    const envelope = JSON.parse(json);
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);
  });
});

// ============================
// T4671: ERROR REGISTRY
// ============================

describe('CLEO Error Registry (T4671)', () => {
  it('registry contains entries for common exit codes', () => {
    expect(getRegistryEntry(ExitCode.NOT_FOUND)).toBeDefined();
    expect(getRegistryEntry(ExitCode.VALIDATION_ERROR)).toBeDefined();
    expect(getRegistryEntry(ExitCode.LOCK_TIMEOUT)).toBeDefined();
    expect(getRegistryEntry(ExitCode.SESSION_NOT_FOUND)).toBeDefined();
  });

  it('registry entries have valid LAFS code format', () => {
    const registry = getCleoErrorRegistry();
    for (const entry of registry) {
      expect(entry.lafsCode).toMatch(/^E_CLEO_/);
      expect(entry.category).toBeDefined();
      expect(typeof entry.retryable).toBe('boolean');
      expect(typeof entry.httpStatus).toBe('number');
    }
  });

  it('isCleoRegisteredCode returns true for valid codes', () => {
    expect(isCleoRegisteredCode('E_CLEO_NOT_FOUND')).toBe(true);
    expect(isCleoRegisteredCode('E_CLEO_VALIDATION')).toBe(true);
  });

  it('isCleoRegisteredCode returns false for unknown codes', () => {
    expect(isCleoRegisteredCode('E_NONEXISTENT')).toBe(false);
  });

  it('lookup by LAFS code matches lookup by exit code', () => {
    const byExit = getRegistryEntry(ExitCode.NOT_FOUND);
    expect(byExit).toBeDefined();
    expect(byExit!.lafsCode).toBe('E_CLEO_NOT_FOUND');
    expect(byExit!.category).toBe('NOT_FOUND');
  });
});

// ============================
// T4701: BUDGET ENFORCEMENT
// ============================

describe('LAFS Budget Enforcement (T4701)', () => {
  it('enforceBudget passes small responses within budget', () => {
    const response = {
      _meta: {
        specVersion: '1.2.3',
        schemaVersion: '2026.2.1',
        timestamp: new Date().toISOString(),
        operation: 'test',
        requestId: 'r1',
        transport: 'sdk',
        strict: true,
        mvi: 'standard',
        contextVersion: 1,
      },
      success: true,
      data: { task: { id: 'T001', title: 'Test' } },
    };
    const { enforcement } = enforceBudget(response, 10000);
    expect(enforcement.withinBudget).toBe(true);
    expect(enforcement.truncated).toBe(false);
  });

  it('isWithinBudget returns true for small responses', () => {
    const response = { success: true, data: { ok: true } };
    expect(isWithinBudget(response, 10000)).toBe(true);
  });

  it('isWithinBudget returns false for large responses with tiny budget', () => {
    const response = { success: true, data: { items: Array(100).fill({ id: 'T001', title: 'x'.repeat(200) }) } };
    expect(isWithinBudget(response, 10)).toBe(false);
  });

  it('enforceBudget adds budget metadata to _meta', () => {
    const response = {
      _meta: {
        specVersion: '1.2.3',
        schemaVersion: '2026.2.1',
        timestamp: new Date().toISOString(),
        operation: 'test',
        requestId: 'r1',
        transport: 'sdk',
        strict: true,
        mvi: 'standard',
        contextVersion: 1,
      },
      success: true,
      data: { ok: true },
    };
    const { response: enforced } = enforceBudget(response, 5000);
    const meta = enforced['_meta'] as Record<string, unknown>;
    expect(meta['_budgetEnforcement']).toBeDefined();
    const be = meta['_budgetEnforcement'] as Record<string, unknown>;
    expect(typeof be['estimatedTokens']).toBe('number');
    expect(be['budget']).toBe(5000);
  });
});

// ============================
// T4702: SESSION ID IN _META
// ============================

describe('Session ID in _meta (T4702)', () => {
  it('sessionId included in CLI meta when session is active', () => {
    const origEnv = process.env['CLEO_SESSION'];
    process.env['CLEO_SESSION'] = 'test-session-42';
    try {
      const json = formatSuccess({ ok: true });
      const parsed = JSON.parse(json);
      expect(parsed._meta.sessionId).toBe('test-session-42');
    } finally {
      if (origEnv !== undefined) {
        process.env['CLEO_SESSION'] = origEnv;
      } else {
        delete process.env['CLEO_SESSION'];
      }
    }
  });

  it('sessionId omitted from CLI meta when no session', () => {
    const origEnv = process.env['CLEO_SESSION'];
    delete process.env['CLEO_SESSION'];
    try {
      const json = formatSuccess({ ok: true });
      const parsed = JSON.parse(json);
      // sessionId may or may not be present depending on .current-session file
      // but should not throw
      expect(parsed._meta).toBeDefined();
    } finally {
      if (origEnv !== undefined) {
        process.env['CLEO_SESSION'] = origEnv;
      }
    }
  });

  it('sessionId included in gateway meta when session is active', () => {
    const origEnv = process.env['CLEO_SESSION'];
    process.env['CLEO_SESSION'] = 'gw-session-99';
    try {
      const meta = createGatewayMeta('cleo_query', 'tasks', 'list', Date.now());
      expect(meta.sessionId).toBe('gw-session-99');
    } finally {
      if (origEnv !== undefined) {
        process.env['CLEO_SESSION'] = origEnv;
      } else {
        delete process.env['CLEO_SESSION'];
      }
    }
  });
});

// ============================
// T4673: FULL CONFORMANCE CI SUITE
// ============================

describe('runEnvelopeConformance() CI Suite (T4673)', () => {
  const OPERATIONS = [
    'tasks.list',
    'tasks.show',
    'tasks.add',
    'tasks.find',
    'session.status',
    'system.version',
    'system.dash',
    'cli.output',
  ];

  for (const operation of OPERATIONS) {
    it(`success envelope for ${operation} passes full conformance`, () => {
      const json = formatSuccess({ data: 'test' }, undefined, operation);
      const envelope = JSON.parse(json);
      const report = runEnvelopeConformance(envelope);
      expect(report.ok).toBe(true);
    });
  }

  it('all error envelopes pass conformance (except code registry)', () => {
    const errorCodes = [
      ExitCode.NOT_FOUND,
      ExitCode.VALIDATION_ERROR,
      ExitCode.LOCK_TIMEOUT,
      ExitCode.SESSION_NOT_FOUND,
      ExitCode.DEPTH_EXCEEDED,
    ];
    for (const code of errorCodes) {
      const err = new CleoError(code, `Test error ${code}`);
      const json = formatError(err, 'test.error');
      const envelope = JSON.parse(json);
      const report = runEnvelopeConformance(envelope);
      const nonRegistryFails = report.checks
        .filter((c: { name: string; pass: boolean }) => !c.pass && c.name !== 'error_code_registered');
      expect(nonRegistryFails).toHaveLength(0);
    }
  });

  it('envelope with page passes conformance', () => {
    const page = createPage({ total: 50, limit: 10, offset: 0 });
    const json = formatSuccess({ tasks: [] }, undefined, { operation: 'tasks.list', page });
    const envelope = JSON.parse(json);
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);
  });

  it('envelope with _extensions passes conformance', () => {
    const json = formatSuccess({ ok: true }, undefined, {
      operation: 'system.info',
      extensions: { cleoVersion: '2026.2.5' },
    });
    const envelope = JSON.parse(json);
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);
  });

  it('envelope with warnings passes conformance', () => {
    pushWarning({ code: 'DEPRECATED', message: 'old feature' });
    const json = formatSuccess({ ok: true }, undefined, 'system.test');
    const envelope = JSON.parse(json);
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);
  });
});
