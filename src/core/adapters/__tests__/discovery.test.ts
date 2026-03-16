/**
 * Unit tests for adapter discovery.
 * @task T5240
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverAdapterManifests, detectProvider } from '../discovery.js';
import type { DetectionPattern } from '@cleocode/contracts';

describe('discoverAdapterManifests', () => {
  it('returns empty array when adapters directory does not exist', () => {
    const result = discoverAdapterManifests('/tmp/nonexistent-project');
    expect(result).toEqual([]);
  });
});

describe('detectProvider', () => {
  beforeEach(() => {
    // Clean up any test env vars
    delete process.env.TEST_CLEO_ADAPTER_DETECT;
  });

  it('returns false for empty patterns', () => {
    expect(detectProvider([])).toBe(false);
  });

  it('detects env pattern when env var is set', () => {
    process.env.TEST_CLEO_ADAPTER_DETECT = '1';
    const patterns: DetectionPattern[] = [
      { type: 'env', pattern: 'TEST_CLEO_ADAPTER_DETECT', description: 'Test env var' },
    ];
    expect(detectProvider(patterns)).toBe(true);
    delete process.env.TEST_CLEO_ADAPTER_DETECT;
  });

  it('returns false for env pattern when env var is not set', () => {
    const patterns: DetectionPattern[] = [
      { type: 'env', pattern: 'NONEXISTENT_VAR_CLEO_TEST', description: 'Missing var' },
    ];
    expect(detectProvider(patterns)).toBe(false);
  });

  it('detects file pattern when file exists', () => {
    const patterns: DetectionPattern[] = [
      { type: 'file', pattern: '/tmp', description: 'tmp directory exists' },
    ];
    expect(detectProvider(patterns)).toBe(true);
  });

  it('returns false for file pattern when file does not exist', () => {
    const patterns: DetectionPattern[] = [
      { type: 'file', pattern: '/nonexistent/path/cleo-test', description: 'Missing file' },
    ];
    expect(detectProvider(patterns)).toBe(false);
  });

  it('returns true if any pattern matches', () => {
    const patterns: DetectionPattern[] = [
      { type: 'env', pattern: 'NONEXISTENT_VAR_1', description: 'Miss' },
      { type: 'file', pattern: '/tmp', description: 'Hit' },
    ];
    expect(detectProvider(patterns)).toBe(true);
  });
});
