import { describe, expect, it } from 'vitest';
import { lafsErrorToProblemDetails, PROBLEM_DETAILS_CONTENT_TYPE } from '../src/problemDetails.js';
import type { LAFSError } from '../src/types.js';

function makeError(overrides: Partial<LAFSError> = {}): LAFSError {
  return {
    code: 'E_VALIDATION_SCHEMA',
    message: 'Input failed schema validation',
    category: 'VALIDATION',
    retryable: false,
    retryAfterMs: null,
    details: {},
    ...overrides,
  };
}

describe('lafsErrorToProblemDetails', () => {
  it('produces valid RFC 9457 output with type, title, status, detail', () => {
    const pd = lafsErrorToProblemDetails(makeError());
    expect(pd.type).toMatch(/^https:\/\/lafs\.dev\/errors\/v1\//);
    expect(pd.title).toBe('E_VALIDATION_SCHEMA');
    expect(typeof pd.status).toBe('number');
    expect(pd.detail).toBe('Input failed schema validation');
  });

  it('includes retryable field from LAFSError', () => {
    const pd = lafsErrorToProblemDetails(makeError({ retryable: true }));
    expect(pd.retryable).toBe(true);
  });

  it('includes agentAction from top-level LAFSError field', () => {
    const pd = lafsErrorToProblemDetails(
      makeError({ agentAction: 'retry_modified' })
    );
    expect(pd.agentAction).toBe('retry_modified');
  });

  it('includes agentAction from error.details as fallback', () => {
    const pd = lafsErrorToProblemDetails(
      makeError({ details: { agentAction: 'retry_modified' } })
    );
    expect(pd.agentAction).toBe('retry_modified');
  });

  it('includes escalationRequired from top-level LAFSError field', () => {
    const pd = lafsErrorToProblemDetails(
      makeError({ escalationRequired: true })
    );
    expect(pd.escalationRequired).toBe(true);
  });

  it('includes suggestedAction from top-level LAFSError field', () => {
    const pd = lafsErrorToProblemDetails(
      makeError({ suggestedAction: 'Retry with valid input' })
    );
    expect(pd.suggestedAction).toBe('Retry with valid input');
  });

  it('includes docUrl from top-level LAFSError field', () => {
    const pd = lafsErrorToProblemDetails(
      makeError({ docUrl: 'https://lafs.dev/docs/errors/validation-schema' })
    );
    expect(pd.docUrl).toBe('https://lafs.dev/docs/errors/validation-schema');
  });

  it('includes retryAfterMs when non-null', () => {
    const pd = lafsErrorToProblemDetails(makeError({ retryAfterMs: 5000 }));
    expect(pd.retryAfterMs).toBe(5000);
  });

  it('maps instance from requestId parameter', () => {
    const pd = lafsErrorToProblemDetails(makeError(), 'req_abc123');
    expect(pd.instance).toBe('req_abc123');
  });

  it('omits instance when requestId is not provided', () => {
    const pd = lafsErrorToProblemDetails(makeError());
    expect(pd.instance).toBeUndefined();
  });

  it('spreads error.details as extension members', () => {
    const pd = lafsErrorToProblemDetails(
      makeError({ details: { traceId: 'trace-123', severity: 'high' } })
    );
    expect(pd['traceId']).toBe('trace-123');
    expect(pd['severity']).toBe('high');
  });

  it('does not overwrite core fields with details keys', () => {
    const pd = lafsErrorToProblemDetails(
      makeError({ details: { type: 'malicious-override', status: 999 } })
    );
    // Core fields should remain untouched
    expect(pd.type).toMatch(/^https:\/\/lafs\.dev\/errors\/v1\//);
    expect(pd.status).not.toBe(999);
  });

  it('falls back to constructed type URI when registry entry is missing', () => {
    const pd = lafsErrorToProblemDetails(
      makeError({ code: 'E_FAKE_NONEXISTENT_CODE' })
    );
    expect(pd.type).toBe('https://lafs.dev/errors/v1/E_FAKE_NONEXISTENT_CODE');
  });

  it('falls back to status 500 when registry entry is missing', () => {
    const pd = lafsErrorToProblemDetails(
      makeError({ code: 'E_FAKE_NONEXISTENT_CODE' })
    );
    expect(pd.status).toBe(500);
  });

  it('uses registry httpStatus when available', () => {
    const pd = lafsErrorToProblemDetails(
      makeError({ code: 'E_NOT_FOUND_RESOURCE' })
    );
    expect(pd.status).toBe(404);
  });
});

describe('PROBLEM_DETAILS_CONTENT_TYPE', () => {
  it('equals application/problem+json', () => {
    expect(PROBLEM_DETAILS_CONTENT_TYPE).toBe('application/problem+json');
  });
});
