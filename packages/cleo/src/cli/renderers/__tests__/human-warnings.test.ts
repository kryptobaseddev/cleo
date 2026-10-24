/**
 * Human (TTY) output shows pushed warnings (T13987).
 *
 * Deprecations such as `cleo conduit *` (T13982) and `cleo docs supersede`
 * push a `W_DEPRECATED_COMMAND` warning. JSON consumers get it in
 * `meta.warnings`; before T13987 a person in a terminal never saw it, because
 * the human path never runs `formatSuccess`, which is where warnings drain.
 *
 * @task T13987
 */

import { drainWarnings, pushWarning } from '@cleocode/core/output';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFormatContext } from '../../format-context.js';
import { cliOutput } from '../index.js';

/** Capture what a callback writes to one stream. */
function capture(stream: NodeJS.WriteStream, run: () => void): string {
  let out = '';
  const spy = vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return out;
}

const DEPRECATION = {
  code: 'W_DEPRECATED_COMMAND',
  message: 'cleo conduit status is deprecated: use AgentMBX',
};

beforeEach(() => {
  drainWarnings();
});

afterEach(() => {
  drainWarnings();
  setFormatContext({ format: 'json', source: 'default', quiet: false });
  vi.restoreAllMocks();
});

describe('human output shows pushed warnings (T13987)', () => {
  it('writes the warning to stderr and keeps it out of stdout', () => {
    setFormatContext({ format: 'human', source: 'flag', quiet: false });
    pushWarning(DEPRECATION);
    let stdout = '';
    const stderr = capture(process.stderr, () => {
      stdout = capture(process.stdout, () => {
        cliOutput({ ok: true }, { command: 'conduit-status', operation: 'conduit.status' });
      });
    });
    expect(stderr).toContain('warning: cleo conduit status is deprecated: use AgentMBX');
    expect(stdout).not.toContain('deprecated');
    // Drained: it cannot leak into a later envelope.
    expect(drainWarnings()).toBeUndefined();
  });

  it('stays silent under --quiet but still drains', () => {
    setFormatContext({ format: 'human', source: 'flag', quiet: true });
    pushWarning(DEPRECATION);
    const stderr = capture(process.stderr, () => {
      capture(process.stdout, () => {
        cliOutput({ ok: true }, { command: 'conduit-status', operation: 'conduit.status' });
      });
    });
    expect(stderr).not.toContain('deprecated');
    expect(drainWarnings()).toBeUndefined();
  });
});
