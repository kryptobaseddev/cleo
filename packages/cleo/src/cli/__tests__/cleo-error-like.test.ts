/**
 * T12512 — the CLI entrypoint recognises every `CleoError` subclass, including
 * those that rename themselves, so their exit code, code name and fix reach
 * the envelope instead of `E_CLI_UNCAUGHT` with exit 1.
 *
 * @task T12512
 */

import { CleoError } from '@cleocode/core/errors.js';
import { NexusRegistryReadError } from '@cleocode/core/nexus/registry-errors.js';
import { describe, expect, it } from 'vitest';
import { asCleoErrorLike, cleoErrorCodeName } from '../cleo-error-like.js';

/** A subclass that renames itself, as several core errors do. */
class RenamedCleoError extends CleoError {
  constructor() {
    super(75, 'renamed failure', { fix: 'do the thing' });
    this.name = 'RenamedCleoError';
  }
}

describe('asCleoErrorLike (T12512)', () => {
  it('recognises a plain CleoError', () => {
    const typed = asCleoErrorLike(new CleoError(4, 'missing'));
    expect(typed?.code).toBe(4);
  });

  it('recognises a subclass that renames itself', () => {
    const err = new RenamedCleoError();
    expect(err.name).toBe('RenamedCleoError');
    const typed = asCleoErrorLike(err);
    expect(typed).not.toBeNull();
    if (!typed) return;
    expect(typed.code).toBe(75);
    expect(typed.fix).toBe('do the thing');
    expect(cleoErrorCodeName(typed)).toBe(err.toLAFSError().code);
  });

  it('recognises NexusRegistryReadError and prefers its declared codeName', () => {
    const typed = asCleoErrorLike(new NexusRegistryReadError('list projects', new Error('boom')));
    expect(typed).not.toBeNull();
    if (!typed) return;
    expect(typed.code).toBe(75);
    expect(cleoErrorCodeName(typed)).toBe('E_NEXUS_REGISTRY_READ');
  });

  it('rejects plain errors, citty-style string codes and non-errors', () => {
    expect(asCleoErrorLike(new Error('x'))).toBeNull();
    const citty = Object.assign(new Error('bad arg'), { name: 'CLIError', code: 'EARG' });
    expect(asCleoErrorLike(citty)).toBeNull();
    const noLafs = Object.assign(new Error('x'), { code: 3 });
    expect(asCleoErrorLike(noLafs)).toBeNull();
    expect(asCleoErrorLike({ code: 3, toLAFSError: () => ({ code: 'E' }) })).toBeNull();
    expect(asCleoErrorLike('boom')).toBeNull();
  });
});
