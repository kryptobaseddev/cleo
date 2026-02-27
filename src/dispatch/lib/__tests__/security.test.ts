import { describe, it, expect } from 'vitest';
import { sanitizeParams, SecurityError } from '../security.js';

describe('dispatch security sanitizeParams', () => {
  it('accepts lifecycle stage status for pipeline.stage.record', () => {
    const result = sanitizeParams(
      { taskId: 'T4798', stage: 'research', status: 'in_progress' },
      undefined,
      { domain: 'pipeline', operation: 'stage.record' },
    );

    expect(result?.['status']).toBe('in_progress');
  });

  it('rejects lifecycle stage status outside lifecycle stage recording context', () => {
    expect(() => sanitizeParams({ status: 'in_progress' })).toThrow(SecurityError);
  });
});
