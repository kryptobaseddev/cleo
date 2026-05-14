/**
 * Unit tests for `classifyError` (T9270 — Hermes FailoverReason taxonomy).
 *
 * Each case checks that the returned `reason` matches the expected taxonomy
 * value AND that at least the asserted recovery flags are set correctly.
 *
 * @task T9270
 */

import { describe, expect, it } from 'vitest';
import { classifyError } from '../error-classifier.js';

describe('classifyError', () => {
  it.each([
    [{ status: 401 }, 'auth', { shouldRotateCredential: true }],
    [{ status: 402, message: 'insufficient credits' }, 'billing', { shouldRotateCredential: true }],
    [{ status: 429 }, 'rate_limit', { shouldRotateCredential: true }],
    [{ status: 500 }, 'server_error', { retryable: true }],
    [{ status: 503 }, 'overloaded', { retryable: true }],
    [{ status: 400, message: 'prompt is too long' }, 'context_overflow', { shouldCompress: true }],
    [{ status: 404 }, 'model_not_found', { shouldFallback: true }],
    [new Error('unrelated'), 'unknown', { retryable: false }],
  ] as const)('classifies %j → %s', (input, reason, flags) => {
    const result = classifyError(input);
    expect(result.reason).toBe(reason);
    for (const [k, v] of Object.entries(flags)) {
      expect(result[k as keyof typeof result]).toBe(v);
    }
  });

  it('extracts statusCode from err.statusCode property', () => {
    const result = classifyError({ statusCode: 429 });
    expect(result.reason).toBe('rate_limit');
    expect(result.statusCode).toBe(429);
  });

  it('extracts statusCode from err.response.status', () => {
    const result = classifyError({ response: { status: 503 } });
    expect(result.reason).toBe('overloaded');
    expect(result.statusCode).toBe(503);
  });

  it('extracts statusCode from err.cause.status', () => {
    const result = classifyError({ cause: { status: 404 } });
    expect(result.reason).toBe('model_not_found');
    expect(result.shouldFallback).toBe(true);
  });

  it('classifies AbortError name as timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const result = classifyError(err);
    expect(result.reason).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  it('classifies ETIMEDOUT message as timeout', () => {
    const result = classifyError(new Error('connect ETIMEDOUT 1.2.3.4:443'));
    expect(result.reason).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  it('classifies 400 with context_length_exceeded as context_overflow', () => {
    const result = classifyError({ status: 400, message: 'context_length_exceeded' });
    expect(result.reason).toBe('context_overflow');
    expect(result.shouldCompress).toBe(true);
    expect(result.retryable).toBe(true);
  });

  it('classifies 400 with "too long" as context_overflow', () => {
    const result = classifyError({ status: 400, message: 'prompt is too long for this model' });
    expect(result.reason).toBe('context_overflow');
    expect(result.shouldCompress).toBe(true);
  });

  it('classifies plain 400 as format_error', () => {
    const result = classifyError({ status: 400, message: 'invalid json body' });
    expect(result.reason).toBe('format_error');
    expect(result.retryable).toBe(false);
  });

  it('classifies 529 as overloaded', () => {
    const result = classifyError({ status: 529 });
    expect(result.reason).toBe('overloaded');
    expect(result.retryable).toBe(true);
  });

  it('populates provider and model from context', () => {
    const result = classifyError(
      { status: 429 },
      { provider: 'anthropic', model: 'claude-3-5-sonnet' },
    );
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-3-5-sonnet');
  });

  it('returns null for provider and model when context is omitted', () => {
    const result = classifyError({ status: 500 });
    expect(result.provider).toBeNull();
    expect(result.model).toBeNull();
  });

  it('preserves message from Error instance', () => {
    const result = classifyError(new Error('something went wrong'));
    expect(result.message).toBe('something went wrong');
  });
});
