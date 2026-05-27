/**
 * cliOutput integration tests for nexus subcommands (T1720).
 *
 * Verifies the cleo dispatcher path: `cliOutput(data, {command: 'nexus-*'})`
 * picks the correct human renderer and that --json output conforms to the
 * LAFS envelope shape.
 *
 * Pure-renderer behaviour is covered by
 * `packages/core/src/render/nexus/__tests__/renderers.test.ts` (B7 / T10132
 * moved the renderers themselves to `@cleocode/core/render/nexus`).
 *
 * @task T1720
 * @epic T1691
 */

import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFormatContext } from '../../format-context.js';

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let suiteDir: string;

beforeEach(async () => {
  suiteDir = await mkdtemp(join(tmpdir(), 'nexus-clioutput-test-'));
  mkdirSync(join(suiteDir, 'cleo-home'), { recursive: true });
  process.env['CLEO_HOME'] = join(suiteDir, 'cleo-home');
  // Default to json format for isolation
  setFormatContext({ format: 'json', source: 'default', quiet: false });
});

afterEach(async () => {
  setFormatContext({ format: 'json', source: 'default', quiet: false });
  delete process.env['CLEO_HOME'];
  await rm(suiteDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// cliOutput integration — JSON envelope shape validation
// ---------------------------------------------------------------------------

describe('cliOutput — LAFS envelope shape for nexus commands', () => {
  it('emits valid LAFS envelope in json format', async () => {
    const { cliOutput } = await import('../../renderers/index.js');
    setFormatContext({ format: 'json', source: 'flag', quiet: false });

    let written = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      written += String(chunk);
      return true;
    };

    try {
      cliOutput(
        { paths: [], count: 0 },
        { command: 'nexus-hot-paths', operation: 'nexus.hot-paths' },
      );
    } finally {
      process.stdout.write = origWrite;
    }

    expect(written.length).toBeGreaterThan(0);
    const envelope = JSON.parse(written.trim()) as Record<string, unknown>;
    expect(envelope['success']).toBe(true);
    expect(envelope['meta']).toBeDefined();
    const meta = envelope['meta'] as Record<string, unknown>;
    expect(meta['operation']).toBe('nexus.hot-paths');
    expect(meta['timestamp']).toBeDefined();
  });

  it('emits human output via renderer in human format', async () => {
    const { cliOutput } = await import('../../renderers/index.js');
    setFormatContext({ format: 'human', source: 'flag', quiet: false });

    let written = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      written += String(chunk);
      return true;
    };

    try {
      cliOutput(
        { paths: [], count: 0 },
        { command: 'nexus-hot-paths', operation: 'nexus.hot-paths' },
      );
    } finally {
      process.stdout.write = origWrite;
      setFormatContext({ format: 'json', source: 'default', quiet: false });
    }

    expect(written.length).toBeGreaterThan(0);
    expect(written).toContain('[nexus] No hot paths found');
  });

  it('emits human clusters output via nexus-clusters renderer', async () => {
    const { cliOutput } = await import('../../renderers/index.js');
    setFormatContext({ format: 'human', source: 'flag', quiet: false });

    let written = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      written += String(chunk);
      return true;
    };

    try {
      cliOutput(
        {
          projectId: 'test-proj',
          communities: [{ id: 'c1', label: 'core', symbolCount: 100, cohesion: 0.8 }],
        },
        { command: 'nexus-clusters', operation: 'nexus.clusters' },
      );
    } finally {
      process.stdout.write = origWrite;
      setFormatContext({ format: 'json', source: 'default', quiet: false });
    }

    expect(written.length).toBeGreaterThan(0);
    expect(written).toContain('test-proj');
    expect(written).toContain('core');
    expect(written).toContain('0.800');
  });
});
