/**
 * Golden Parity Tests
 *
 * Validates that native engine output matches CLI fixture structure.
 * Uses deterministic fixture data to compare structural equivalence,
 * ignoring dynamic fields (timestamps, IDs, versions).
 *
 * @task T4370
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { compareOutputs, formatReport } from './compare';

const FIXTURES_DIR = resolve(__dirname, 'fixtures');

/**
 * Load a fixture file
 */
function loadFixture(name: string): Record<string, unknown> {
  const filePath = resolve(FIXTURES_DIR, name);
  const content = readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

describe('Golden Parity: Fixture Structure', () => {
  it('task-add fixture has required fields', () => {
    const fixture = loadFixture('task-add.json');
    expect(fixture).toHaveProperty('success', true);
    expect(fixture).toHaveProperty('task');
    const task = fixture.task as Record<string, unknown>;
    expect(task).toHaveProperty('id');
    expect(task).toHaveProperty('title');
    expect(task).toHaveProperty('description');
    expect(task).toHaveProperty('status');
  });

  it('task-list fixture has required fields', () => {
    const fixture = loadFixture('task-list.json');
    expect(fixture).toHaveProperty('success', true);
    expect(fixture).toHaveProperty('tasks');
    expect(Array.isArray(fixture.tasks)).toBe(true);
    expect(fixture).toHaveProperty('total');
  });

  it('task-show fixture has required fields', () => {
    const fixture = loadFixture('task-show.json');
    expect(fixture).toHaveProperty('success', true);
    expect(fixture).toHaveProperty('task');
    const task = fixture.task as Record<string, unknown>;
    expect(task).toHaveProperty('id');
    expect(task).toHaveProperty('title');
    expect(task).toHaveProperty('status');
  });

  it('task-find fixture has required fields', () => {
    const fixture = loadFixture('task-find.json');
    expect(fixture).toHaveProperty('success', true);
    expect(fixture).toHaveProperty('results');
    expect(Array.isArray(fixture.results)).toBe(true);
    expect(fixture).toHaveProperty('total');
    expect(fixture).toHaveProperty('query');
  });

  it('session-status fixture has required fields', () => {
    const fixture = loadFixture('session-status.json');
    expect(fixture).toHaveProperty('success', true);
    expect(fixture).toHaveProperty('session');
    const session = fixture.session as Record<string, unknown>;
    expect(session).toHaveProperty('id');
    expect(session).toHaveProperty('status');
  });

  it('system-version fixture has required fields', () => {
    const fixture = loadFixture('system-version.json');
    expect(fixture).toHaveProperty('success', true);
    expect(fixture).toHaveProperty('version');
  });

  it('validate-schema fixture has required fields', () => {
    const fixture = loadFixture('validate-schema.json');
    expect(fixture).toHaveProperty('success', true);
    expect(fixture).toHaveProperty('valid');
    expect(fixture).toHaveProperty('errors');
  });
});

describe('Golden Parity: Comparison Utility', () => {
  it('should match identical structures', () => {
    const a = { success: true, data: { id: 'T1', title: 'Test' } };
    const b = { success: true, data: { id: 'T1', title: 'Test' } };
    const result = compareOutputs(a, b);
    expect(result.match).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('should detect missing keys', () => {
    const expected = { success: true, data: { id: 'T1', title: 'Test' } };
    const actual = { success: true, data: { id: 'T1' } };
    const result = compareOutputs(expected, actual);
    expect(result.match).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].type).toBe('missing_key');
    expect(result.failures[0].path).toBe('data.title');
  });

  it('should detect extra keys', () => {
    const expected = { success: true };
    const actual = { success: true, extra: 'field' };
    const result = compareOutputs(expected, actual);
    expect(result.match).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].type).toBe('extra_key');
  });

  it('should detect type mismatches', () => {
    const expected = { count: 5 };
    const actual = { count: '5' };
    const result = compareOutputs(expected, actual);
    expect(result.match).toBe(false);
    expect(result.failures[0].type).toBe('type_mismatch');
  });

  it('should detect value mismatches', () => {
    const expected = { status: 'active' };
    const actual = { status: 'pending' };
    const result = compareOutputs(expected, actual);
    expect(result.match).toBe(false);
    expect(result.failures[0].type).toBe('value_mismatch');
  });

  it('should ignore dynamic fields (timestamp)', () => {
    const expected = { timestamp: '2026-01-01T00:00:00Z', status: 'ok' };
    const actual = { timestamp: '2026-02-13T12:00:00Z', status: 'ok' };
    const result = compareOutputs(expected, actual);
    expect(result.match).toBe(true);
    expect(result.dynamicDiffs).toHaveLength(1);
    expect(result.dynamicDiffs[0].path).toBe('timestamp');
  });

  it('should ignore __DYNAMIC__ placeholder values', () => {
    const expected = { id: '__DYNAMIC__', title: 'Test' };
    const actual = { id: 'T1234', title: 'Test' };
    const result = compareOutputs(expected, actual);
    expect(result.match).toBe(true);
    expect(result.dynamicDiffs).toHaveLength(1);
  });

  it('should detect array length mismatches', () => {
    const expected = { items: [1, 2, 3] };
    const actual = { items: [1, 2] };
    const result = compareOutputs(expected, actual);
    expect(result.match).toBe(false);
    expect(result.failures.some((d) => d.type === 'array_length')).toBe(true);
  });

  it('should support ignorePaths parameter', () => {
    const expected = { a: 1, b: 2 };
    const actual = { a: 1, b: 99 };
    const result = compareOutputs(expected, actual, ['b']);
    expect(result.match).toBe(true);
  });

  it('should produce readable report for failures', () => {
    const expected = { status: 'active', count: 5 };
    const actual = { status: 'pending', count: 5 };
    const result = compareOutputs(expected, actual);
    const report = formatReport(result);
    expect(report).toContain('FAIL');
    expect(report).toContain('status');
    expect(report).toContain('value_mismatch');
  });

  it('should produce readable report for success', () => {
    const a = { status: 'ok' };
    const result = compareOutputs(a, a);
    const report = formatReport(result);
    expect(report).toContain('PASS');
  });

  it('should handle nested object comparison', () => {
    const expected = {
      _meta: { format: 'json', version: '__DYNAMIC__' },
      task: { id: '__DYNAMIC__', title: 'Test', status: 'pending' },
    };
    const actual = {
      _meta: { format: 'json', version: '0.97.0' },
      task: { id: 'T5001', title: 'Test', status: 'pending' },
    };
    const result = compareOutputs(expected, actual);
    expect(result.match).toBe(true);
    expect(result.dynamicDiffs.length).toBeGreaterThan(0);
  });
});
