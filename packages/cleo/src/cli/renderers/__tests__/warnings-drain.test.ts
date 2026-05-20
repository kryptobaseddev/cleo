/**
 * T9769 renderer integration test — CLI envelope must surface warnings
 * pushed via `pushWarning` (from `@cleocode/lafs`) inside an active
 * `withWarningCollector` scope, with zero stderr writes.
 *
 * This guards the Wave 0 contract for the JSON stream hygiene epic
 * (T9763): handlers attach non-fatal notices via the ALS carrier; the
 * renderer drains them into `meta.warnings[]`. Subsequent waves migrate
 * existing `process.stderr.write` / `console.warn` producers onto this
 * channel so JSON consumers see clean stdout.
 *
 * @epic T9763
 * @task T9769
 */

import {
  pushWarning as lafsPushWarning,
  WarningCollector,
  withWarningCollector,
} from '@cleocode/lafs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFormatContext } from '../../format-context.js';
import { cliError, cliOutput } from '../index.js';

beforeEach(() => {
  setFormatContext({ format: 'json', source: 'flag', quiet: false });
});

afterEach(() => {
  setFormatContext({ format: 'json', source: 'default', quiet: false });
  vi.restoreAllMocks();
});

interface CapturedStreams {
  stdout: string;
  stderr: string;
}

function captureStreams(run: () => void): CapturedStreams {
  let stdout = '';
  let stderr = '';
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    });
  try {
    run();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout, stderr };
}

interface CliEnvelopeShape {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: number | string; message: string };
  meta: {
    operation: string;
    requestId: string;
    duration_ms: number;
    timestamp: string;
    warnings?: Array<{
      code: string;
      message: string;
      severity?: string;
      context?: Record<string, unknown>;
    }>;
  };
}

function parseFirstEnvelope(stdout: string): CliEnvelopeShape {
  const firstLine = stdout.split('\n').find((l) => l.trim().length > 0);
  expect(firstLine, 'no stdout output captured').toBeDefined();
  return JSON.parse(firstLine ?? '{}') as CliEnvelopeShape;
}

describe('renderer drains ALS warnings into meta.warnings', () => {
  it('cliOutput surfaces a single pushWarning call in the success envelope', () => {
    const collector = new WarningCollector();
    const captured = captureStreams(() => {
      withWarningCollector(collector, () => {
        lafsPushWarning({
          code: 'W_BRIDGE_WRITE_FAILED',
          message: 'memory bridge unavailable',
          severity: 'warn',
          context: { file: 'memory-bridge.md' },
        });
        cliOutput({ ok: true }, { command: 'generic', operation: 'test.warning' });
      });
    });

    const envelope = parseFirstEnvelope(captured.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.meta.warnings).toBeDefined();
    expect(envelope.meta.warnings).toHaveLength(1);
    expect(envelope.meta.warnings?.[0]).toMatchObject({
      code: 'W_BRIDGE_WRITE_FAILED',
      message: 'memory bridge unavailable',
      severity: 'warn',
      context: { file: 'memory-bridge.md' },
    });

    // T9763 core invariant: producer wrote via pushWarning ONLY — no stderr.
    expect(captured.stderr).toBe('');
  });

  it('multiple pushWarning calls accumulate in envelope order', () => {
    const collector = new WarningCollector();
    const captured = captureStreams(() => {
      withWarningCollector(collector, () => {
        lafsPushWarning({ code: 'W_ONE', message: 'first' });
        lafsPushWarning({ code: 'W_TWO', message: 'second' });
        cliOutput({ ok: true }, { command: 'generic', operation: 'test.multi' });
      });
    });

    const envelope = parseFirstEnvelope(captured.stdout);
    expect(envelope.meta.warnings?.map((w) => w.code)).toEqual(['W_ONE', 'W_TWO']);
    expect(captured.stderr).toBe('');
  });

  it('cliError surfaces warnings in the error envelope meta', () => {
    const collector = new WarningCollector();
    const captured = captureStreams(() => {
      withWarningCollector(collector, () => {
        lafsPushWarning({ code: 'W_DEPRECATED_COMMAND', message: 'use new verb' });
        cliError('something broke', 99, { name: 'E_TEST' });
      });
    });

    const envelope = parseFirstEnvelope(captured.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.error?.code).toBe(99);
    expect(envelope.meta.warnings).toBeDefined();
    expect(envelope.meta.warnings?.[0]).toMatchObject({
      code: 'W_DEPRECATED_COMMAND',
      message: 'use new verb',
    });
    expect(captured.stderr).toBe('');
  });

  it('omits meta.warnings when no warnings are pushed', () => {
    const collector = new WarningCollector();
    const captured = captureStreams(() => {
      withWarningCollector(collector, () => {
        cliOutput({ ok: true }, { command: 'generic', operation: 'test.empty' });
      });
    });

    const envelope = parseFirstEnvelope(captured.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.meta.warnings).toBeUndefined();
    expect(captured.stderr).toBe('');
  });

  it('pushWarning outside an active collector is a no-op and yields no warnings field', () => {
    const captured = captureStreams(() => {
      // No withWarningCollector wrapper — should silently drop.
      lafsPushWarning({ code: 'W_LOST', message: 'no collector bound' });
      cliOutput({ ok: true }, { command: 'generic', operation: 'test.nocoll' });
    });

    const envelope = parseFirstEnvelope(captured.stdout);
    expect(envelope.meta.warnings).toBeUndefined();
    expect(captured.stderr).toBe('');
  });
});
