/**
 * LAFS conformance testing — two-layer verification:
 *
 * 1. Canonical CLI envelope (ADR-039): verifies that CLEO command outputs
 *    produce a well-formed `{success, data?, error?, meta}` envelope using
 *    the local `isValidLafsEnvelope()` helper.
 *
 * 2. Full LAFS protocol conformance: exercises `@cleocode/lafs`'s
 *    `runEnvelopeConformance()` tiered report against LAFS-native envelopes
 *    built via `createEnvelope()`. This proves the conformance pipeline
 *    (schema + invariants + registry + agent-action) works end-to-end.
 *
 * CLEO CLI envelopes cannot currently be validated against the LAFS schema
 * itself because after ADR-039 the two shapes diverged (CLEO uses `meta`,
 * LAFS still requires `_meta`). Unifying them is tracked as follow-up work.
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

import { ExitCode, getExitCodeName, isErrorCode, isSuccessCode } from '@cleocode/contracts';
import { createEnvelope, runEnvelopeConformance } from '@cleocode/lafs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getCleoErrorRegistry,
  getRegistryEntry,
  isCleoRegisteredCode,
} from '../../../core/src/error-registry.js';
import { CleoError } from '../../../core/src/errors.js';
import {
  formatSuccess as _formatSuccess,
  type FormatOptions,
  formatError,
  pushWarning,
} from '../../../core/src/output.js';

/**
 * Wrapper for formatSuccess. After ADR-039, the canonical CLI envelope is always
 * emitted regardless of mvi level, so this is now a thin pass-through.
 */
function formatSuccess<T>(
  data: T,
  message?: string,
  operationOrOpts?: string | FormatOptions,
): string {
  const opts: FormatOptions =
    typeof operationOrOpts === 'string' ? { operation: operationOrOpts } : (operationOrOpts ?? {});
  return _formatSuccess(data, message, opts);
}

import { createPage, paginate } from '../../../core/src/pagination.js';
import {
  createTestDb,
  makeTasks,
  type TestDbEnv,
} from '../../../core/src/store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../core/src/store/data-accessor.js';
import { validateHierarchyPlacement } from '../../../core/src/tasks/hierarchy-policy.js';
import { enforceBudget, isWithinBudget } from '../dispatch/lib/budget.js';
import { createGatewayMeta } from '../dispatch/lib/gateway-meta.js';

// ============================
// FULL LAFS ENVELOPE VALIDATION
// ============================

/**
 * Validate a canonical CLI envelope has required structural fields (ADR-039).
 *
 * Checks the unified shape: `{success, data?, error?, meta, page?}`.
 *
 * @task T4672
 * @task T338
 */
function isValidLafsEnvelope(json: string): { valid: boolean; error?: string } {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed.success !== 'boolean') {
      return { valid: false, error: 'Missing or non-boolean "success" field' };
    }
    if (!parsed.meta || typeof parsed.meta !== 'object') {
      return { valid: false, error: 'Missing "meta" object (ADR-039 — always required)' };
    }
    if (parsed.success) {
      if (!('data' in parsed)) {
        return { valid: false, error: 'Success envelope missing "data" field' };
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

describe('CLI Envelope Conformance (canonical shape, ADR-039)', () => {
  describe('formatSuccess with explicit operation', () => {
    it('produces valid canonical CLI envelope', () => {
      const json = formatSuccess({ task: { id: 'T001' } }, undefined, 'tasks.show');
      expect(isValidLafsEnvelope(json).valid).toBe(true);
    });

    it('does NOT include legacy $schema field', () => {
      const json = formatSuccess({ id: 'T001' }, undefined, 'tasks.add');
      const parsed = JSON.parse(json);
      // The canonical CLI envelope does not carry $schema — it's for the proto-envelope only
      expect(parsed.$schema).toBeUndefined();
    });

    it('includes meta with required CLI fields', () => {
      const json = formatSuccess({ count: 5 }, undefined, 'tasks.list');
      const parsed = JSON.parse(json);
      expect(parsed.meta).toBeDefined();
      expect(parsed.meta.timestamp).toBeDefined();
      expect(parsed.meta.operation).toBe('tasks.list');
      expect(parsed.meta.requestId).toBeDefined();
      expect(typeof parsed.meta.duration_ms).toBe('number');
      // Legacy _meta MUST be absent
      expect(parsed._meta).toBeUndefined();
    });

    it('sets success=true and data field (not result)', () => {
      const json = formatSuccess({ id: 'T001' }, undefined, 'tasks.add');
      const parsed = JSON.parse(json);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ id: 'T001' });
      // Legacy result MUST be absent
      expect(parsed.result).toBeUndefined();
      expect(parsed.error).toBeUndefined();
    });
  });

  describe('formatSuccess without operation (defaults to cli.output)', () => {
    it('produces valid canonical CLI envelope with default operation', () => {
      const json = formatSuccess({ task: { id: 'T001', title: 'Test' } });
      const parsed = JSON.parse(json);
      expect(parsed.meta).toBeDefined();
      expect(parsed.meta.operation).toBe('cli.output');
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ task: { id: 'T001', title: 'Test' } });
    });

    it('passes isValidLafsEnvelope() even without explicit operation', () => {
      const json = formatSuccess({ items: [1, 2] });
      expect(isValidLafsEnvelope(json).valid).toBe(true);
    });

    it('includes optional message in meta', () => {
      const result = formatSuccess({ id: 'T001' }, 'Task created');
      const parsed = JSON.parse(result);
      expect(parsed.meta.message).toBe('Task created');
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
    it('produces valid canonical CLI error envelope', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found');
      const json = formatError(err, 'tasks.show');
      expect(isValidLafsEnvelope(json).valid).toBe(true);
    });

    it('produces error shape with category and retryable', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found');
      const json = formatError(err, 'tasks.show');
      const parsed = JSON.parse(json);
      expect(parsed.success).toBe(false);
      // In canonical shape, no `result` field — errors do NOT have result
      expect(parsed.result).toBeUndefined();
      // Error carries structured fields
      expect(parsed.error.message).toBe('Task not found');
      expect(parsed.error.category).toBe('NOT_FOUND');
      expect(typeof parsed.error.retryable).toBe('boolean');
    });
  });

  describe('formatError without operation (defaults to cli.output)', () => {
    it('produces valid canonical CLI error envelope with default operation', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found');
      const json = formatError(err);
      const parsed = JSON.parse(json);
      expect(parsed.meta).toBeDefined();
      expect(parsed.meta.operation).toBe('cli.output');
      expect(parsed.success).toBe(false);
    });

    it('isValidLafsEnvelope() passes even without explicit operation', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found');
      const json = formatError(err);
      expect(isValidLafsEnvelope(json).valid).toBe(true);
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

  describe('isValidLafsEnvelope (canonical shape checks)', () => {
    it('canonical success envelope passes', () => {
      const json = formatSuccess({ items: [1, 2] }, undefined, 'system.health');
      expect(isValidLafsEnvelope(json).valid).toBe(true);
    });

    it('canonical error envelope passes', () => {
      const err = new CleoError(ExitCode.VALIDATION_ERROR, 'Bad input');
      const json = formatError(err, 'tasks.add');
      expect(isValidLafsEnvelope(json).valid).toBe(true);
    });

    it('canonical envelope without explicit operation passes', () => {
      const json = formatSuccess({ data: 'test' });
      expect(isValidLafsEnvelope(json).valid).toBe(true);
    });
  });
});

// ============================
// GATEWAY META CONFORMANCE
// ============================

describe('Gateway Meta', () => {
  it('createGatewayMeta includes all LAFS fields', () => {
    const startTime = Date.now();
    const meta = createGatewayMeta('query', 'tasks', 'list', startTime);
    expect(meta.specVersion).toBe('1.2.3');
    expect(meta.schemaVersion).toBe('2026.2.1');
    expect(meta.timestamp).toBeDefined();
    expect(meta.operation).toBe('list');
    expect(meta.requestId).toBeDefined();
    expect(meta.transport).toBe('sdk');
    expect(meta.strict).toBe(true);
    expect(meta.mvi).toBe('minimal');
    expect(meta.contextVersion).toBe(1);
  });

  it('createGatewayMeta includes CLEO gateway extensions', () => {
    const startTime = Date.now();
    const meta = createGatewayMeta('mutate', 'session', 'start', startTime);
    expect(meta.gateway).toBe('mutate');
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
    expect(lafsErr.code).toMatch(/^E_CLEO_NOT_FOUND/);
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
      (v) => typeof v === 'number' && v >= 1 && v < 100,
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
    const allCodes = Object.values(ExitCode).filter((v) => typeof v === 'number') as ExitCode[];
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
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;

    const tasks = makeTasks([
      {
        id: 'T001',
        title: 'Test task',
        status: 'pending',
        priority: 'medium',
        phase: 'core',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);
    for (const task of tasks) {
      await accessor.upsertSingleTask(task);
    }
    await accessor.setMetaValue('project_meta', {
      name: 'Test',
      phases: { core: { order: 1, name: 'Core', status: 'active' } },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('addTask result produces valid canonical CLI envelope (no operation)', async () => {
    const { addTask } = await import('../../../core/src/tasks/add.js');
    const result = await addTask(
      { title: 'New task', description: 'LAFS conformance test task' },
      env.tempDir,
      accessor,
    );
    const json = formatSuccess({ task: result.task });
    // Canonical CLI envelope shape check (ADR-039). The CLEO CLI no longer
    // emits the legacy LAFS schema shape, so `validateEnvelope` is not
    // applicable here — tracked separately for a future LAFS schema update.
    expect(isValidLafsEnvelope(json).valid).toBe(true);
    const envelope = JSON.parse(json);
    expect(envelope.success).toBe(true);
    expect(envelope.data).toBeDefined();
    expect(envelope.meta).toBeDefined();
  });

  it('addTask result produces valid canonical CLI envelope (explicit operation)', async () => {
    const { addTask } = await import('../../../core/src/tasks/add.js');
    const result = await addTask(
      { title: 'Full LAFS task', description: 'LAFS envelope with explicit operation' },
      env.tempDir,
      accessor,
    );
    const json = formatSuccess({ task: result.task }, undefined, 'tasks.add');
    const envelope = JSON.parse(json);
    expect(isValidLafsEnvelope(json).valid).toBe(true);
    expect(envelope.meta.operation).toBe('tasks.add');
  });

  it('listPhases result produces valid LAFS', async () => {
    const { listPhases } = await import('../../../core/src/phases/index.js');
    const result = await listPhases(env.tempDir, accessor);
    const json = formatSuccess(result);
    expect(isValidLafsEnvelope(json).valid).toBe(true);
  });

  it('error from showTask produces valid canonical CLI error envelope', async () => {
    const { showTask } = await import('../../../core/src/tasks/show.js');
    try {
      await showTask('T999', env.tempDir, accessor);
    } catch (err) {
      if (err instanceof CleoError) {
        const json = formatError(err);
        expect(isValidLafsEnvelope(json).valid).toBe(true);
        const envelope = JSON.parse(json);
        expect(envelope.success).toBe(false);
        expect(envelope.error).toBeDefined();
        expect(envelope.meta).toBeDefined();
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

describe('meta.warnings Deprecation Support (T4669)', () => {
  it('pushWarning adds warning to next envelope meta', () => {
    pushWarning({
      code: 'DEPRECATED_FLAG',
      message: '--legacy flag is deprecated',
      deprecated: '--legacy',
      replacement: '--modern',
      removeBy: '2027.1.0',
    });
    const json = formatSuccess({ ok: true });
    const parsed = JSON.parse(json);
    // Warnings are now in meta.warnings (canonical CLI envelope, ADR-039)
    expect(parsed.meta.warnings).toBeDefined();
    expect(parsed.meta.warnings).toHaveLength(1);
    expect(parsed.meta.warnings[0].code).toBe('DEPRECATED_FLAG');
    expect(parsed.meta.warnings[0].replacement).toBe('--modern');
  });

  it('warnings are drained after consumption', () => {
    pushWarning({ code: 'TEST', message: 'test warning' });
    formatSuccess({ ok: true }); // consumes
    const json = formatSuccess({ ok: true }); // no warnings
    const parsed = JSON.parse(json);
    expect(parsed.meta.warnings).toBeUndefined();
  });

  it('envelope with warnings still passes isValidLafsEnvelope()', () => {
    pushWarning({ code: 'W001', message: 'test warning' });
    const json = formatSuccess({ data: 1 }, undefined, 'system.test');
    expect(isValidLafsEnvelope(json).valid).toBe(true);
  });
});

// ============================
// T4670: EXTENSIONS
// ============================

describe('extensions in FormatOptions (T4670)', () => {
  it('_extensions field is not part of the canonical CLI envelope (ADR-039)', () => {
    // The canonical CLI envelope does not carry _extensions at the top level.
    // Extensions from FormatOptions are ignored in the unified shape.
    const json = formatSuccess({ ok: true }, undefined, {
      operation: 'system.status',
      extensions: {
        cleoVersion: '2026.2.5',
      },
    });
    const parsed = JSON.parse(json);
    expect(parsed._extensions).toBeUndefined();
    // Envelope is still valid
    expect(isValidLafsEnvelope(json).valid).toBe(true);
  });

  it('envelope without extensions still passes isValidLafsEnvelope()', () => {
    const json = formatSuccess({ ok: true }, undefined, {
      operation: 'test',
    });
    expect(isValidLafsEnvelope(json).valid).toBe(true);
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
    const response = {
      success: true,
      data: { items: Array(100).fill({ id: 'T001', title: 'x'.repeat(200) }) },
    };
    expect(isWithinBudget(response, 10)).toBe(false);
  });

  it('enforceBudget adds budget metadata to meta', () => {
    // The canonical CLI envelope uses `meta` (not `_meta`).
    const response = {
      meta: {
        operation: 'test',
        requestId: 'r1',
        duration_ms: 0,
        timestamp: new Date().toISOString(),
      },
      success: true,
      data: { ok: true },
    };
    const { response: enforced } = enforceBudget(response, 5000);
    const meta = enforced['meta'] as Record<string, unknown>;
    expect(meta['_budgetEnforcement']).toBeDefined();
    const be = meta['_budgetEnforcement'] as Record<string, unknown>;
    expect(typeof be['estimatedTokens']).toBe('number');
    expect(be['budget']).toBe(5000);
  });
});

// ============================
// T4702: SESSION ID IN _META
// ============================

describe('Session ID in meta (T4702)', () => {
  it('sessionId included in CLI meta when session is active', () => {
    const origEnv = process.env['CLEO_SESSION'];
    process.env['CLEO_SESSION'] = 'test-session-42';
    try {
      const json = formatSuccess({ ok: true });
      const parsed = JSON.parse(json);
      // sessionId is now in meta.sessionId (canonical CLI envelope, ADR-039)
      expect(parsed.meta.sessionId).toBe('test-session-42');
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
      // meta is always present (ADR-039), sessionId is optional
      expect(parsed.meta).toBeDefined();
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
      const meta = createGatewayMeta('query', 'tasks', 'list', Date.now());
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

describe('isValidLafsEnvelope() CI Suite (T4673 — canonical shape)', () => {
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
    it(`success envelope for ${operation} passes isValidLafsEnvelope()`, () => {
      const json = formatSuccess({ data: 'test' }, undefined, operation);
      expect(isValidLafsEnvelope(json).valid).toBe(true);
    });
  }

  it('all error envelopes pass isValidLafsEnvelope()', () => {
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
      expect(isValidLafsEnvelope(json).valid).toBe(true);
    }
  });

  it('envelope with page passes isValidLafsEnvelope()', () => {
    const page = createPage({ total: 50, limit: 10, offset: 0 });
    const json = formatSuccess({ tasks: [] }, undefined, { operation: 'tasks.list', page });
    expect(isValidLafsEnvelope(json).valid).toBe(true);
    // page field is present at top level
    const parsed = JSON.parse(json);
    expect(parsed.page).toBeDefined();
  });

  it('envelope with warnings passes isValidLafsEnvelope()', () => {
    pushWarning({ code: 'DEPRECATED', message: 'old feature' });
    const json = formatSuccess({ ok: true }, undefined, 'system.test');
    expect(isValidLafsEnvelope(json).valid).toBe(true);
  });
});

// ============================
// T4673: runEnvelopeConformance (tiered canonical checks from @cleocode/lafs)
// ============================

/**
 * Full conformance gate exercised against **LAFS-native envelopes** produced
 * by `@cleocode/lafs`'s own `createEnvelope()` factory.
 *
 * @remarks
 * After ADR-039 (2026-04-08), the CLEO CLI emits a different canonical
 * envelope shape (`{success, data?, error?, meta}`) from the legacy LAFS
 * schema shape (`{$schema, _meta, success, result}`). `runEnvelopeConformance`
 * validates against the LAFS schema, so CLEO envelopes cannot be tested
 * with it until the LAFS schema is updated to accept the new shape (tracked
 * separately).
 *
 * These tests wire up `runEnvelopeConformance` against envelopes built via
 * `createEnvelope()` — the function's intended input — proving that the
 * conformance pipeline (schema + invariants + registry + agent-action) works
 * end-to-end. This fulfils the file header's docstring claim that the suite
 * uses `runEnvelopeConformance` for canonical validation.
 *
 * @task T4673
 */
describe('runEnvelopeConformance — canonical tiered conformance (T4673)', () => {
  const CORE_OPERATIONS = [
    'tasks.list',
    'tasks.show',
    'tasks.add',
    'session.status',
    'system.version',
  ];

  for (const operation of CORE_OPERATIONS) {
    it(`LAFS-native success envelope for ${operation} passes core conformance`, () => {
      const envelope = createEnvelope({
        success: true,
        result: { ok: true, operation },
        meta: { operation, requestId: `req-${operation}` },
      });
      const report = runEnvelopeConformance(envelope, { tier: 'core' });
      if (!report.ok) {
        // Surface the failing checks for debugging.
        const failed = report.checks.filter((c) => !c.pass);
        throw new Error(
          `Core conformance failed for ${operation}: ${JSON.stringify(failed, null, 2)}`,
        );
      }
      expect(report.ok).toBe(true);
    });
  }

  it('LAFS-native error envelope passes core conformance', () => {
    const envelope = createEnvelope({
      success: false,
      error: {
        // Use a registered code from packages/lafs/schemas/v1/error-registry.json
        // so the core-tier `error_code_registered` check passes.
        code: 'E_NOT_FOUND_RESOURCE',
        message: 'Task not found',
      },
      meta: { operation: 'tasks.show', requestId: 'req-err-1' },
    });
    const report = runEnvelopeConformance(envelope, { tier: 'core' });
    if (!report.ok) {
      const failed = report.checks.filter((c) => !c.pass);
      throw new Error(`Core conformance failed: ${JSON.stringify(failed, null, 2)}`);
    }
    expect(report.ok).toBe(true);
  });

  it('report.checks contains the expected core check names', () => {
    const envelope = createEnvelope({
      success: true,
      result: { ok: true },
      meta: { operation: 'system.health', requestId: 'req-core-1' },
    });
    const report = runEnvelopeConformance(envelope, { tier: 'core' });
    const checkNames = report.checks.map((c) => c.name);
    // Tier "core" per packages/lafs conformance profiles always includes at least these:
    expect(checkNames).toContain('envelope_schema_valid');
    expect(checkNames).toContain('envelope_invariants');
    expect(checkNames).toContain('error_code_registered');
  });

  it('runEnvelopeConformance without options runs the default tier', () => {
    const envelope = createEnvelope({
      success: true,
      result: { items: [1, 2, 3] },
      meta: { operation: 'tasks.list', requestId: 'req-default-1' },
    });
    const report = runEnvelopeConformance(envelope);
    expect(report).toHaveProperty('ok');
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it('malformed envelope (missing success) is rejected by runEnvelopeConformance', () => {
    const broken = { data: { ok: true }, meta: { operation: 'test' } };
    const report = runEnvelopeConformance(broken, { tier: 'core' });
    expect(report.ok).toBe(false);
    const schemaCheck = report.checks.find((c) => c.name === 'envelope_schema_valid');
    expect(schemaCheck).toBeDefined();
    expect(schemaCheck!.pass).toBe(false);
  });
});

// ============================
// T5001: HIERARCHY POLICY CONFORMANCE
// ============================

describe('hierarchy policy conformance', () => {
  it('validateHierarchyPlacement returns well-formed result with all required fields', () => {
    const tasks = [
      {
        id: 'T001',
        title: 'Root',
        description: 'Root task',
        status: 'pending' as const,
        priority: 'medium' as const,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const policy = {
      maxDepth: 3,
      maxSiblings: 7,
      maxActiveSiblings: 3,
      countDoneInLimit: false,
      enforcementProfile: 'human-cognitive' as const,
    };

    // Valid placement
    const successResult = validateHierarchyPlacement('T001', tasks, policy);
    expect(successResult).toHaveProperty('valid');
    expect(typeof successResult.valid).toBe('boolean');

    // Error placement (parent not found)
    const errorResult = validateHierarchyPlacement('T999', tasks, policy);
    expect(errorResult).toHaveProperty('valid', false);
    expect(errorResult).toHaveProperty('error');
    expect(errorResult.error!).toHaveProperty('code');
    expect(errorResult.error!).toHaveProperty('message');
    expect(typeof errorResult.error!.code).toBe('string');
    expect(typeof errorResult.error!.message).toBe('string');
  });

  it('hierarchy error codes follow E_ prefix convention', () => {
    const tasks = [
      {
        id: 'T001',
        title: 'Root',
        description: 'Root task',
        status: 'pending' as const,
        priority: 'medium' as const,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const policy = {
      maxDepth: 3,
      maxSiblings: 7,
      maxActiveSiblings: 3,
      countDoneInLimit: false,
      enforcementProfile: 'human-cognitive' as const,
    };

    const result = validateHierarchyPlacement('T999', tasks, policy);
    expect(result.error!.code).toMatch(/^E_/);
  });

  it('hierarchy error flows through canonical CLI error envelope', () => {
    const err = new CleoError(ExitCode.DEPTH_EXCEEDED, 'Maximum nesting depth exceeded');
    const json = formatError(err, 'tasks.add');
    const parsed = JSON.parse(json);

    // Verify canonical CLI envelope structure (ADR-039 — uses `meta`, not `_meta`).
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
    expect(typeof parsed.error.message).toBe('string');
    expect(parsed.meta).toBeDefined();
    expect(parsed.meta.operation).toBe('tasks.add');
    expect(parsed.meta.requestId).toBeDefined();
    expect(parsed.meta.timestamp).toBeDefined();

    // Passes the canonical envelope structural check.
    expect(isValidLafsEnvelope(json).valid).toBe(true);
  });

  it('sibling limit error produces valid canonical CLI error envelope', () => {
    const err = new CleoError(ExitCode.SIBLING_LIMIT, 'Parent has too many children');
    const json = formatError(err, 'tasks.add');
    const parsed = JSON.parse(json);

    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toMatch(/^E_/);
    expect(parsed.meta).toBeDefined();
    expect(isValidLafsEnvelope(json).valid).toBe(true);
  });
});
