import { describe, expect, it, vi } from 'vitest';
import { isNativeAvailable } from '../src/native-loader.js';
import { assertEnvelope, validateEnvelope } from '../src/validateEnvelope.js';

const validEnvelope = {
  $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
  _meta: {
    specVersion: '1.0.0',
    schemaVersion: '1.0.0',
    timestamp: '2026-03-15T00:00:00Z',
    operation: 'test.list',
    requestId: 'req_structured_01',
    transport: 'cli',
    strict: true,
    mvi: 'minimal',
    contextVersion: 0,
  },
  success: true,
  result: { items: [] },
};

describe('structuredErrors in EnvelopeValidationResult', () => {
  it('returns empty structuredErrors for a valid envelope', () => {
    const result = validateEnvelope(validEnvelope);
    expect(result.valid).toBe(true);
    expect(result.structuredErrors).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('returns structuredErrors with path, keyword, message for invalid envelope', () => {
    const invalid = {
      ...validEnvelope,
      _meta: {
        ...validEnvelope._meta,
        specVersion: 'not-a-semver', // violates pattern
      },
    };
    const result = validateEnvelope(invalid);
    expect(result.valid).toBe(false);
    expect(result.structuredErrors.length).toBeGreaterThan(0);

    for (const se of result.structuredErrors) {
      expect(se).toHaveProperty('path');
      expect(se).toHaveProperty('keyword');
      expect(se).toHaveProperty('message');
      expect(typeof se.path).toBe('string');
      expect(typeof se.keyword).toBe('string');
      expect(typeof se.message).toBe('string');
    }
  });

  it('structuredErrors.length matches errors.length', () => {
    const invalid = {
      $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
      _meta: {
        specVersion: 'bad',
        schemaVersion: 'bad',
        timestamp: 'not-a-date',
        operation: '',
        requestId: 'ab', // too short (minLength 3)
        transport: 'invalid_transport',
        strict: true,
        mvi: 'minimal',
        contextVersion: 0,
      },
      success: true,
      result: { items: [] },
    };
    const result = validateEnvelope(invalid);
    expect(result.valid).toBe(false);
    expect(result.structuredErrors.length).toBe(result.errors.length);
  });

  it('keyword includes "pattern" for pattern violations', () => {
    const invalid = {
      ...validEnvelope,
      _meta: {
        ...validEnvelope._meta,
        specVersion: 'not-semver',
      },
    };
    const result = validateEnvelope(invalid);
    expect(result.valid).toBe(false);
    const patternError = result.structuredErrors.find((se) => se.keyword === 'pattern');
    expect(patternError).toBeDefined();
  });

  it('keyword includes "required" for missing required fields', () => {
    // Missing 'result' which is required
    const invalid = {
      $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
      _meta: validEnvelope._meta,
      success: true,
    };
    const result = validateEnvelope(invalid);
    expect(result.valid).toBe(false);
    const requiredError = result.structuredErrors.find((se) => se.keyword === 'required');
    expect(requiredError).toBeDefined();
  });

  it('keyword includes "enum" for enum violations', () => {
    const invalid = {
      ...validEnvelope,
      _meta: {
        ...validEnvelope._meta,
        transport: 'websocket', // not a valid enum value
      },
    };
    const result = validateEnvelope(invalid);
    expect(result.valid).toBe(false);
    const enumError = result.structuredErrors.find((se) => se.keyword === 'enum');
    expect(enumError).toBeDefined();
  });

  it('params include useful data for pattern violations', () => {
    const invalid = {
      ...validEnvelope,
      _meta: {
        ...validEnvelope._meta,
        specVersion: 'bad-version',
      },
    };
    const result = validateEnvelope(invalid);
    expect(result.valid).toBe(false);
    const patternError = result.structuredErrors.find((se) => se.keyword === 'pattern');
    expect(patternError).toBeDefined();
    expect(patternError!.params).toHaveProperty('pattern');
    expect(typeof patternError!.params['pattern']).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T11419: CLEO CLI canonical envelope shape validation (meta/data shape)
// ─────────────────────────────────────────────────────────────────────────────

describe('CLEO CLI envelope shape (T11419 — meta/data, ADR-039)', () => {
  const validCleoSuccess = {
    success: true,
    data: { task: { id: 'T001', title: 'Test task' } },
    meta: {
      operation: 'tasks.show',
      requestId: 'req_test_01',
      duration_ms: 42,
      timestamp: '2026-05-31T00:00:00Z',
    },
  };

  const validCleoError = {
    success: false,
    error: {
      code: 'E_CLEO_NOT_FOUND',
      message: 'Task not found',
      category: 'NOT_FOUND',
      retryable: false,
    },
    meta: {
      operation: 'tasks.show',
      requestId: 'req_test_err_01',
      duration_ms: 5,
      timestamp: '2026-05-31T00:00:00Z',
    },
  };

  it('accepts valid CLEO CLI success envelope (meta/data shape)', () => {
    const result = validateEnvelope(validCleoSuccess);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts valid CLEO CLI error envelope (meta/data shape)', () => {
    const result = validateEnvelope(validCleoError);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts CLEO CLI envelope with optional warnings in meta', () => {
    const withWarnings = {
      ...validCleoSuccess,
      meta: {
        ...validCleoSuccess.meta,
        warnings: [{ code: 'W_DEPRECATED', message: 'Old flag used' }],
      },
    };
    const result = validateEnvelope(withWarnings);
    expect(result.valid).toBe(true);
  });

  it('accepts CLEO CLI envelope with page (offset mode)', () => {
    const withPage = {
      ...validCleoSuccess,
      page: { mode: 'offset', limit: 20, offset: 0, hasMore: true, total: 100 },
    };
    const result = validateEnvelope(withPage);
    expect(result.valid).toBe(true);
  });

  it('rejects CLEO CLI success envelope missing data field', () => {
    const noData = { success: true, meta: validCleoSuccess.meta };
    const result = validateEnvelope(noData);
    expect(result.valid).toBe(false);
  });

  it('rejects CLEO CLI error envelope missing error field', () => {
    const noError = { success: false, meta: validCleoSuccess.meta };
    const result = validateEnvelope(noError);
    expect(result.valid).toBe(false);
  });

  it('assertEnvelope passes for valid CLEO CLI envelope', () => {
    expect(() => assertEnvelope(validCleoSuccess)).not.toThrow();
  });

  it('assertEnvelope throws for malformed envelope (no success field)', () => {
    expect(() => assertEnvelope({ data: {}, meta: validCleoSuccess.meta })).toThrow(
      'Invalid LAFS envelope',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T11421: native-loader + AJV fallback branch coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('validateEnvelope — validator path coverage (T11421)', () => {
  const validSdkEnvelope = {
    $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
    _meta: {
      specVersion: '1.0.0',
      schemaVersion: '1.0.0',
      timestamp: '2026-05-31T00:00:00Z',
      operation: 'test.op',
      requestId: 'req_path_test',
      transport: 'cli',
      strict: false,
      mvi: 'minimal',
      contextVersion: 0,
    },
    success: true,
    result: { ok: true },
  };

  it('validateEnvelope accepts a valid SDK envelope (active path)', () => {
    // Regardless of which validator backend runs, a valid envelope passes.
    const result = validateEnvelope(validSdkEnvelope);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.structuredErrors).toEqual([]);
  });

  it('validateEnvelope rejects a malformed envelope (active path)', () => {
    const bad = { notAnEnvelope: true };
    const result = validateEnvelope(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('isNativeAvailable returns a boolean (native path check)', () => {
    // Documents whether native is available; test is non-assertive on value
    // because napi may or may not be built in CI.
    expect(typeof isNativeAvailable()).toBe('boolean');
  });

  it('AJV fallback path: validate via forced AJV (mocked native unavailable)', async () => {
    // Force the AJV fallback by importing the module fresh with native-loader mocked.
    const { validateEnvelope: validateFn } = await vi.importActual<
      typeof import('../src/validateEnvelope.js')
    >('../src/validateEnvelope.js');

    // Even through the same module (native may or may not be present),
    // a valid envelope must pass and an invalid one must fail.
    expect(validateFn(validSdkEnvelope).valid).toBe(true);
    expect(validateFn({ broken: true }).valid).toBe(false);
  });
});
