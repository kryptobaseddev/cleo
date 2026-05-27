import { describe, expect, it } from 'vitest';
import { validateEnvelope } from '../src/validateEnvelope.js';

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
