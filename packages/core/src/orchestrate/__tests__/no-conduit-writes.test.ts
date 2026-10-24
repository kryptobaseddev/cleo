/**
 * Spawn and handoff write no conduit messages (T13953 · T13981).
 *
 * T13953 removed the fire-and-forget `sendConduitEvent` calls from
 * `orchestrateSpawnExecute` (`agent.spawned`) and `orchestrateHandoff`
 * (`orchestrate.handoff`); T13981 removed the helper itself. Conduit messaging
 * is retiring (epic T13933): agents talk over AgentMBX. This guard fails if
 * either module reaches for a conduit transport again.
 *
 * It reads the module sources, so it proves the modules make no direct conduit
 * call; it does not trace calls made through other modules.
 *
 * @task T13981
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/** Conduit write entry points a spawn or handoff path must not use. */
const CONDUIT_WRITERS = /\b(sendConduitEvent|createConduit|LocalTransport|HttpTransport)\b/;

describe('spawn and handoff write no conduit messages (T13981)', () => {
  for (const file of ['spawn-ops.ts', 'handoff-ops.ts']) {
    it(`${file} names no conduit writer`, () => {
      const source = readFileSync(join(here, '..', file), 'utf-8');
      expect(source.match(CONDUIT_WRITERS)?.[0]).toBeUndefined();
    });
  }

  it('neither the orchestrate barrel nor @cleocode/core/internal exports sendConduitEvent', async () => {
    const barrel = await import('../index.js');
    expect('sendConduitEvent' in barrel).toBe(false);
    const internal = await import('../../internal.js');
    expect('sendConduitEvent' in internal).toBe(false);
  });
});
