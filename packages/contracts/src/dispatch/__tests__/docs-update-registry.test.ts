import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../operations-registry.js';

describe('docs.update registry flags (T10617)', () => {
  it('exposes registry-driven dry-run and strict preflight CLI params', () => {
    const updateOp = OPERATIONS.find(
      (op) => op.domain === 'docs' && op.operation === 'update' && op.gateway === 'mutate',
    );

    expect(updateOp).toBeDefined();
    const dryRun = updateOp?.params?.find((param) => param.name === 'dryRun');
    const strict = updateOp?.params?.find((param) => param.name === 'strict');

    expect(dryRun).toMatchObject({
      type: 'boolean',
      required: false,
      cli: { flag: 'dry-run' },
    });
    expect(strict).toMatchObject({
      type: 'boolean',
      required: false,
    });
  });
});
