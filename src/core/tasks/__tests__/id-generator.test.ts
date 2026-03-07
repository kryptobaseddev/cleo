import { describe, it, expect } from 'vitest';
import { normalizeTaskId } from '../id-generator.js';

describe('normalizeTaskId', () => {
  it('passes through canonical T-prefixed IDs', () => {
    expect(normalizeTaskId('T1234')).toBe('T1234');
  });

  it('preserves leading zeros', () => {
    expect(normalizeTaskId('T001')).toBe('T001');
  });

  it('uppercases lowercase t prefix', () => {
    expect(normalizeTaskId('t1234')).toBe('T1234');
  });

  it('prepends T to numeric-only input', () => {
    expect(normalizeTaskId('1234')).toBe('T1234');
  });

  it('prepends T to numeric-only with leading zeros', () => {
    expect(normalizeTaskId('001')).toBe('T001');
  });

  it('strips underscore-prefixed suffix', () => {
    expect(normalizeTaskId('T1234_description')).toBe('T1234');
  });

  it('trims whitespace', () => {
    expect(normalizeTaskId('  T1234  ')).toBe('T1234');
  });

  it('returns null for empty string', () => {
    expect(normalizeTaskId('')).toBeNull();
  });

  it('returns null for null', () => {
    expect(normalizeTaskId(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(normalizeTaskId(undefined)).toBeNull();
  });

  it('returns null for number type', () => {
    expect(normalizeTaskId(123)).toBeNull();
  });

  it('returns null for T with no digits', () => {
    expect(normalizeTaskId('T')).toBeNull();
  });

  it('returns null for non-digit body', () => {
    expect(normalizeTaskId('TASKABC')).toBeNull();
  });

  it('returns null for dash separator', () => {
    expect(normalizeTaskId('T-123')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(normalizeTaskId('   ')).toBeNull();
  });

  it('handles very long digit strings', () => {
    expect(normalizeTaskId('T' + '9'.repeat(20))).toBe('T' + '9'.repeat(20));
  });

  it('returns null for mixed case prefix like tT1234', () => {
    expect(normalizeTaskId('tT1234')).toBeNull();
  });

  it('normalizes numeric zero to T0', () => {
    expect(normalizeTaskId('0')).toBe('T0');
  });
});
