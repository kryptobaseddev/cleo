/**
 * T12512 — `cleo doctor db-substrate --fleet` without `--fleet-root` on an
 * unreadable registry: a typed `E_NEXUS_REGISTRY_READ` envelope with exit 75
 * whose fix names `--fleet-root`, never `E_CLI_UNCAUGHT` with exit 1.
 *
 * The registry read is mocked, so no store is opened.
 *
 * @task T12512
 */

import { NexusRegistryReadError } from '@cleocode/core/nexus/registry-errors.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cleocode/core/nexus/registry-roots.js', () => ({
  listRegistryParentRoots: vi.fn(async () => {
    throw new NexusRegistryReadError('list projects', new Error('no such table: nexus_projects'));
  }),
}));

import { setFormatContext } from '../../format-context.js';
import { doctorDbSubstrateCommand } from '../doctor-db-substrate.js';

let written: string[];

beforeEach(() => {
  written = [];
  const capture = (chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  setFormatContext({ format: 'json', source: 'default', quiet: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('doctor db-substrate --fleet with an unreadable registry (T12512)', () => {
  it('emits E_NEXUS_REGISTRY_READ with exit 75 and a --fleet-root fix', async () => {
    const run = doctorDbSubstrateCommand.run as (ctx: {
      args: Record<string, unknown>;
    }) => Promise<void>;
    await run({ args: { fleet: true, _: [] } });
    expect(process.exitCode).toBe(75);
    const envelope = JSON.parse(written.join('').trim()) as {
      success: boolean;
      error: { code: number; codeName: string; fix: string };
    };
    expect(envelope.success).toBe(false);
    expect(envelope.error.code).toBe(75);
    expect(envelope.error.codeName).toBe('E_NEXUS_REGISTRY_READ');
    expect(envelope.error.fix).toMatch(/--fleet-root <dir>/);
  });
});
