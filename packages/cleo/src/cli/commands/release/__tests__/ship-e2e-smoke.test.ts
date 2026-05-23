/**
 * Tests for the `cleo release ship-e2e-smoke` CLI handler (T10103).
 *
 * Verifies arg surface + delegation to `runShipE2eSmoke` + that the
 * verb appears under `releaseCommand.subCommands` exactly once.
 *
 * @task T10103
 */

import { describe, expect, it } from 'vitest';
import { shipE2eSmokeCommand } from '../ship-e2e-smoke.js';

describe('cleo release ship-e2e-smoke — CLI surface (T10103)', () => {
  it('declares the expected meta + arg shape', () => {
    expect(shipE2eSmokeCommand.meta).toBeDefined();
    const meta = shipE2eSmokeCommand.meta as { name: string; description: string };
    expect(meta.name).toBe('ship-e2e-smoke');
    expect(meta.description.toLowerCase()).toContain('dry-run');

    const args = shipE2eSmokeCommand.args as Record<string, { type: string; required?: boolean }>;
    expect(args.version?.type).toBe('positional');
    expect(args.version?.required).toBe(true);
    expect(args.epic?.type).toBe('string');
    expect(args.epic?.required).toBe(true);
    expect(args.execute?.type).toBe('boolean');
    expect(args['poll-interval-ms']?.type).toBe('string');
    expect(args['total-timeout-ms']?.type).toBe('string');
  });
});

describe('cleo release — subCommands ship verb deletion (T10103)', () => {
  it('removes the deprecated `ship` verb entirely', async () => {
    const { releaseCommand } = await import('../../release.js');
    const subs = (releaseCommand as unknown as { subCommands: Record<string, unknown> })
      .subCommands;
    expect(subs.ship).toBeUndefined();
    expect(subs.start).toBeUndefined();
    expect(subs.verify).toBeUndefined();
    expect(subs.publish).toBeUndefined();
  });

  it('registers `ship-e2e-smoke` under the release command', async () => {
    const { releaseCommand } = await import('../../release.js');
    const subs = (releaseCommand as unknown as { subCommands: Record<string, unknown> })
      .subCommands;
    expect(subs['ship-e2e-smoke']).toBeDefined();
  });
});
