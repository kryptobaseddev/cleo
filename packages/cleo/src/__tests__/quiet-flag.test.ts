/**
 * Tests for the global `--quiet` flag and the stderr-suppression policy.
 *
 * Verifies:
 *   1. `quietStderrWrite` honors the format-context `quiet` flag.
 *   2. The core logger fallback respects `setLoggerQuiet(true)`.
 *   3. The format-context `isQuiet()` propagates through the LAFS resolver.
 *
 * @task T9933
 * @epic Saga T9855
 */

import { resolveOutputFormat } from '@cleocode/lafs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLogger, isLoggerQuiet, setLoggerQuiet } from '../../../core/src/logger.js';
import { isQuiet, setFormatContext } from '../cli/format-context.js';
import { ProgressTracker } from '../cli/progress.js';
import { quietStderrWrite } from '../cli/quiet-stderr.js';

describe('--quiet flag — format-context propagation', () => {
  afterEach(() => {
    // Reset to safe defaults so cross-suite tests don't see leaked state.
    setFormatContext({ format: 'json', source: 'default', quiet: false });
    setLoggerQuiet(false);
  });

  it('LAFS resolveOutputFormat carries quiet:true when the input flag is set', () => {
    const resolution = resolveOutputFormat({ jsonFlag: true, quiet: true });
    expect(resolution.quiet).toBe(true);
    expect(resolution.format).toBe('json');
  });

  it('LAFS resolveOutputFormat defaults quiet to false', () => {
    const resolution = resolveOutputFormat({ jsonFlag: true });
    expect(resolution.quiet).toBe(false);
  });

  it('isQuiet() reflects the format-context resolution', () => {
    setFormatContext({ format: 'json', source: 'flag', quiet: true });
    expect(isQuiet()).toBe(true);

    setFormatContext({ format: 'human', source: 'flag', quiet: false });
    expect(isQuiet()).toBe(false);
  });
});

describe('--quiet flag — quietStderrWrite helper', () => {
  let capturedStderr: string;
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    capturedStderr = '';
    originalWrite = process.stderr.write.bind(process.stderr);
    // Patch stderr.write to capture without printing. Cast through unknown
    // because the signature has 3 overloads — we only need the string path.
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (
      chunk: string,
    ) => {
      capturedStderr += chunk;
      return true;
    };
  });

  afterEach(() => {
    (process.stderr as unknown as { write: typeof originalWrite }).write = originalWrite;
    setFormatContext({ format: 'json', source: 'default', quiet: false });
  });

  it('writes to stderr when quiet=false', () => {
    setFormatContext({ format: 'human', source: 'flag', quiet: false });
    quietStderrWrite('progress: doing work\n');
    expect(capturedStderr).toBe('progress: doing work\n');
  });

  it('suppresses stderr when quiet=true', () => {
    setFormatContext({ format: 'json', source: 'flag', quiet: true });
    quietStderrWrite('progress: doing work\n');
    expect(capturedStderr).toBe('');
  });

  it('round-trips many writes under quiet=true with zero output', () => {
    setFormatContext({ format: 'json', source: 'flag', quiet: true });
    for (let i = 0; i < 50; i++) {
      quietStderrWrite(`line ${i}\n`);
    }
    expect(capturedStderr).toBe('');
  });
});

describe('--quiet flag — core logger fallback', () => {
  afterEach(() => {
    setLoggerQuiet(false);
  });

  it('isLoggerQuiet() reflects setLoggerQuiet()', () => {
    expect(isLoggerQuiet()).toBe(false);
    setLoggerQuiet(true);
    expect(isLoggerQuiet()).toBe(true);
    setLoggerQuiet(false);
    expect(isLoggerQuiet()).toBe(false);
  });

  it('fallback logger drops warn-level writes under quiet mode', () => {
    setLoggerQuiet(true);
    const logger = getLogger('test-subsystem-quiet');
    // pino exposes `level` on every logger; quiet mode forces 'silent'.
    expect(logger.level).toBe('silent');
  });

  it('fallback logger emits at warn level when quiet=false (default)', () => {
    setLoggerQuiet(false);
    const logger = getLogger('test-subsystem-loud');
    expect(logger.level).toBe('warn');
  });
});

describe('--quiet flag — ProgressTracker stderr gating', () => {
  let capturedStderr: string;
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    capturedStderr = '';
    originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (
      chunk: string,
    ) => {
      capturedStderr += chunk;
      return true;
    };
  });

  afterEach(() => {
    (process.stderr as unknown as { write: typeof originalWrite }).write = originalWrite;
    setFormatContext({ format: 'json', source: 'default', quiet: false });
  });

  it('emits step + complete lines when enabled and quiet=false', () => {
    setFormatContext({ format: 'human', source: 'flag', quiet: false });
    const tracker = new ProgressTracker({
      enabled: true,
      prefix: 'TEST',
      steps: ['First', 'Second'],
    });
    tracker.start();
    tracker.step(0);
    tracker.complete('done');
    expect(capturedStderr).toContain('TEST');
    expect(capturedStderr).toContain('First');
    expect(capturedStderr).toContain('done');
  });

  it('suppresses every progress line when quiet=true even if enabled', () => {
    setFormatContext({ format: 'human', source: 'flag', quiet: true });
    const tracker = new ProgressTracker({
      enabled: true,
      prefix: 'TEST',
      steps: ['First', 'Second'],
    });
    tracker.start();
    tracker.step(0);
    tracker.step(1);
    tracker.complete('done');
    tracker.error('oops');
    expect(capturedStderr).toBe('');
  });
});
