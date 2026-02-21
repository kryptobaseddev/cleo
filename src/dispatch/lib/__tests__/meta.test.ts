import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDispatchMeta } from '../meta.js';

describe('createDispatchMeta', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-20T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return metadata with all required fields', () => {
    const startTime = Date.now() - 42;
    const meta = createDispatchMeta('query', 'tasks', 'show', startTime);

    expect(meta.gateway).toBe('query');
    expect(meta.domain).toBe('tasks');
    expect(meta.operation).toBe('show');
    expect(meta.timestamp).toBe('2026-02-20T12:00:00.000Z');
    expect(meta.duration_ms).toBe(42);
    expect(meta.source).toBe('mcp');
    expect(meta.requestId).toBeDefined();
    expect(typeof meta.requestId).toBe('string');
    expect(meta.requestId.length).toBeGreaterThan(0);
  });

  it('should default source to mcp when not provided', () => {
    const meta = createDispatchMeta('mutate', 'session', 'start', Date.now());
    expect(meta.source).toBe('mcp');
  });

  it('should use provided source', () => {
    const meta = createDispatchMeta('query', 'admin', 'dash', Date.now(), 'cli');
    expect(meta.source).toBe('cli');
  });

  it('should use provided requestId when given', () => {
    const meta = createDispatchMeta('query', 'tasks', 'list', Date.now(), 'mcp', 'custom-req-id');
    expect(meta.requestId).toBe('custom-req-id');
  });

  it('should generate unique requestIds when not provided', () => {
    const meta1 = createDispatchMeta('query', 'tasks', 'show', Date.now());
    const meta2 = createDispatchMeta('query', 'tasks', 'show', Date.now());
    expect(meta1.requestId).not.toBe(meta2.requestId);
  });

  it('should compute duration_ms from startTime to now', () => {
    const startTime = Date.now();
    vi.advanceTimersByTime(100);
    const meta = createDispatchMeta('mutate', 'tasks', 'add', startTime);
    expect(meta.duration_ms).toBe(100);
  });

  it('should produce valid ISO timestamp', () => {
    const meta = createDispatchMeta('query', 'memory', 'list', Date.now());
    const parsed = new Date(meta.timestamp);
    expect(parsed.toISOString()).toBe(meta.timestamp);
  });

  it('should handle mutate gateway', () => {
    const meta = createDispatchMeta('mutate', 'check', 'compliance.record', Date.now());
    expect(meta.gateway).toBe('mutate');
    expect(meta.domain).toBe('check');
    expect(meta.operation).toBe('compliance.record');
  });

  it('should handle dot-separated operation names', () => {
    const meta = createDispatchMeta('query', 'tools', 'skill.catalog.info', Date.now());
    expect(meta.operation).toBe('skill.catalog.info');
  });
});
