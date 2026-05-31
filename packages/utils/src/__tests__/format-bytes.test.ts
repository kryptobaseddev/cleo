import { describe, expect, it } from 'vitest';
import { formatBytes } from '../format-bytes.js';

describe('formatBytes', () => {
  it('renders zero and sub-kilobyte values as whole bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('renders kilobytes with one decimal (binary step)', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('renders megabytes and gigabytes with one decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(2 ** 30)).toBe('1.0 GB');
  });

  it('caps the unit at TB for very large inputs', () => {
    expect(formatBytes(5 * 1024 ** 4)).toBe('5.0 TB');
    expect(formatBytes(1024 ** 5)).toBe('1024.0 TB');
  });

  it('clamps negative and non-finite inputs to 0 B', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});
