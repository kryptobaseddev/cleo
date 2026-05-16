/**
 * T9393 regression test — cliOutput must propagate decorator-stamped meta
 * fields from `responseMeta` into the emitted LAFS envelope.
 *
 * Covers the defect chain that left `_nexus` and `deprecated` out of every
 * `cleo nexus <op> --json` envelope despite the dispatch decorator stamping
 * them on `response.meta`:
 *
 *   1. `formatSuccess` must merge `opts.extensions` into the envelope `meta`
 *      (the field had been dead since T4670).
 *   2. `cliOutput` must accept `responseMeta` and forward the decorator-only
 *      subset (`_nexus`, `deprecated`) via the extensions channel.
 *
 * Asserts T9393 acceptance criterion 6 ("integration test asserts
 * decorator-added meta keys appear in final CLI envelope").
 *
 * @task T9393
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFormatContext } from '../../format-context.js';
import { cliOutput } from '../index.js';

// Set JSON format so cliOutput exercises the formatSuccess → stdout path.
beforeEach(() => {
  setFormatContext({ format: 'json', source: 'flag', quiet: false });
});

afterEach(() => {
  setFormatContext({ format: 'json', source: 'default', quiet: false });
  vi.restoreAllMocks();
});

function captureEnvelope(run: () => void): Record<string, unknown> {
  let captured = '';
  const orig = process.stdout.write.bind(process.stdout);
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    });
  try {
    run();
  } finally {
    spy.mockRestore();
    // Re-bind to avoid leaking the mock to other tests
    void orig;
  }
  // First newline-delimited record is the envelope; downstream LAFS validator
  // messages (if any) come on subsequent lines.
  const line = captured.split('\n').filter((l) => l.trim().length > 0)[0] ?? '{}';
  return JSON.parse(line) as Record<string, unknown>;
}

describe('cliOutput — responseMeta decorator passthrough (T9393)', () => {
  it('propagates response.meta._nexus into envelope.meta._nexus', () => {
    const stampedNexus = {
      scope: 'project',
      effect: 'read',
      projectId: 'proj-abc',
      bindingSource: 'arg-project-id',
      canonicalCommand: 'cleo nexus status',
    };

    const env = captureEnvelope(() => {
      cliOutput(
        { indexed: true, nodeCount: 42 },
        {
          command: 'nexus-status',
          operation: 'nexus.status',
          responseMeta: { _nexus: stampedNexus } as Record<string, unknown>,
        },
      );
    });

    expect(env['success']).toBe(true);
    const meta = env['meta'] as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta['_nexus']).toEqual(stampedNexus);
    // Canonical fields are still produced fresh by createCliMeta
    expect(meta['operation']).toBe('nexus.status');
    expect(typeof meta['requestId']).toBe('string');
    expect(typeof meta['timestamp']).toBe('string');
  });

  it('propagates response.meta.deprecated into envelope.meta.deprecated', () => {
    const deprecated = {
      since: 'v2026.6.5',
      removeIn: 'v2026.8.0',
      replacement: 'cleo graph context',
    };

    const env = captureEnvelope(() => {
      cliOutput(
        { results: [], matchCount: 0 },
        {
          command: 'nexus-context',
          operation: 'nexus.context',
          responseMeta: { deprecated } as Record<string, unknown>,
        },
      );
    });

    const meta = env['meta'] as Record<string, unknown>;
    expect(meta['deprecated']).toEqual(deprecated);
  });

  it('does NOT forward non-decorator meta fields (operation/requestId/timestamp from dispatcher)', () => {
    const env = captureEnvelope(() => {
      cliOutput(
        { ok: true },
        {
          command: 'nexus-status',
          operation: 'nexus.status',
          responseMeta: {
            // canonical CLI fields the dispatcher also tracks — these must NOT
            // leak into the envelope (createCliMeta owns them).
            operation: 'should-not-override',
            requestId: 'should-not-override',
            timestamp: 'should-not-override',
            gateway: 'query',
            domain: 'nexus',
            source: 'cli',
            // decorator-only fields — these MUST flow through.
            _nexus: { scope: 'project', effect: 'read' },
          } as Record<string, unknown>,
        },
      );
    });

    const meta = env['meta'] as Record<string, unknown>;
    expect(meta['operation']).toBe('nexus.status');
    expect(meta['requestId']).not.toBe('should-not-override');
    expect(meta['timestamp']).not.toBe('should-not-override');
    // Non-decorator dispatcher fields are deliberately dropped to keep the
    // envelope minimal.
    expect(meta['gateway']).toBeUndefined();
    expect(meta['domain']).toBeUndefined();
    expect(meta['source']).toBeUndefined();
    // Decorator field still propagates.
    expect(meta['_nexus']).toEqual({ scope: 'project', effect: 'read' });
  });

  it('propagates duration_ms from extensions (createCliMeta default would be 0)', () => {
    const env = captureEnvelope(() => {
      cliOutput(
        { ok: true },
        {
          command: 'nexus-status',
          operation: 'nexus.status',
          extensions: { duration_ms: 1234 },
        },
      );
    });

    const meta = env['meta'] as Record<string, unknown>;
    expect(meta['duration_ms']).toBe(1234);
  });

  it('handles missing responseMeta gracefully (no decorator fields)', () => {
    const env = captureEnvelope(() => {
      cliOutput(
        { ok: true },
        { command: 'nexus-status', operation: 'nexus.status' },
      );
    });

    const meta = env['meta'] as Record<string, unknown>;
    expect(meta['_nexus']).toBeUndefined();
    expect(meta['deprecated']).toBeUndefined();
    expect(meta['operation']).toBe('nexus.status');
  });

  it('explicit extensions override responseMeta when keys collide', () => {
    const env = captureEnvelope(() => {
      cliOutput(
        { ok: true },
        {
          command: 'nexus-status',
          operation: 'nexus.status',
          extensions: { _nexus: { from: 'extensions' } },
          responseMeta: { _nexus: { from: 'responseMeta' } } as Record<string, unknown>,
        },
      );
    });

    const meta = env['meta'] as Record<string, unknown>;
    expect(meta['_nexus']).toEqual({ from: 'extensions' });
  });
});
