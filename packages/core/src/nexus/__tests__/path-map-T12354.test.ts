/**
 * Device-local path map + deterministic encounter (T12354).
 *
 * - After a move, an ORDINARY command's encounter (`recordProjectEncounter`,
 *   which the CLI awaits before every command) re-points the registry row and
 *   the path map; previously only `init` / `nexus reconcile` did.
 * - Two checkouts of one project on one device are both recorded.
 * - A vanished checkout is marked `missing`, never deleted (T12469); unregister
 *   and clean remove location rows.
 *
 * Every case runs against a temp `CLEO_HOME`.
 *
 * @task T12354
 */

import { cpSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCleoHome, recordProjectEncounter } from '../../paths.js';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import { resetDbState } from '../../store/sqlite.js';
import { listProjectCheckouts } from '../path-map.js';

let testDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  // Canonical (realpath) form: registry writers store resolved paths, and
  // macOS /tmp is a symlink to /private/tmp.
  testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-path-map-T12354-')));
  saved['CLEO_HOME'] = process.env['CLEO_HOME'];
  process.env['CLEO_HOME'] = join(testDir, 'cleo-home');
  mkdirSync(process.env['CLEO_HOME'], { recursive: true });
});

afterEach(async () => {
  await awaitBackgroundOps();
  resetDbState();
  const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
  resetNexusDbState();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** Create an initialised-looking project with an immutable id. */
function makeProject(root: string, projectId: string): string {
  mkdirSync(join(root, '.cleo'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.cleo', 'project-info.json'), JSON.stringify({ projectId }));
  return root;
}

/** Registry row path and live / missing location paths for a project id. */
async function registryState(
  projectId: string,
): Promise<{ row?: string; paths: string[]; missing: string[] }> {
  const { getNexusRegistryDb } = await import('../../store/nexus-sqlite.js');
  const { projectLocations, projectRegistry } = await import('../../store/schema/nexus-schema.js');
  const db = await getNexusRegistryDb(getCleoHome());
  const row = db
    .select({ projectPath: projectRegistry.projectPath })
    .from(projectRegistry)
    .where(eq(projectRegistry.projectId, projectId))
    .get();
  const locations = db
    .select({ path: projectLocations.path, state: projectLocations.state })
    .from(projectLocations)
    .where(eq(projectLocations.projectId, projectId))
    .all();
  const pick = (state: string) =>
    locations
      .filter((r) => r.state === state)
      .map((r) => r.path)
      .sort();
  return { row: row?.projectPath, paths: pick('live'), missing: pick('missing') };
}

describe('move then an ordinary command (T12354)', () => {
  it('re-points the registry row and path map on the next command after a move', async () => {
    const before = makeProject(join(testDir, 'before'), 'move-T12354');
    expect(await recordProjectEncounter(before)).toBe('recorded');
    expect(await registryState('move-T12354')).toEqual({
      row: before,
      paths: [before],
      missing: [],
    });

    const after = join(testDir, 'after');
    renameSync(before, after);
    expect(await recordProjectEncounter(after)).toBe('recorded');
    // T12469: the vanished checkout is kept as `missing`, never deleted.
    expect(await registryState('move-T12354')).toEqual({
      row: after,
      paths: [after],
      missing: [before],
    });

    // Already current: one read, no registration.
    expect(await recordProjectEncounter(after)).toBe('current');
  });
});

describe('two checkouts of one project on one device (T12354)', () => {
  it('records both checkouts; the registry row names the latest', async () => {
    const first = makeProject(join(testDir, 'first'), 'twin-T12354');
    await recordProjectEncounter(first);
    const second = join(testDir, 'second');
    cpSync(first, second, { recursive: true });
    await recordProjectEncounter(second);

    const state = await registryState('twin-T12354');
    expect(state.row).toBe(second);
    expect(state.paths).toEqual([first, second].sort());

    const checkouts = await listProjectCheckouts('twin-T12354');
    expect(checkouts.map((c) => c.projectPath).sort()).toEqual([first, second].sort());
    expect(checkouts.every((c) => c.exists && c.state === 'live')).toBe(true);

    // Returning to the first checkout re-points the row; both stay mapped.
    expect(await recordProjectEncounter(first)).toBe('recorded');
    expect(await registryState('twin-T12354')).toEqual({
      row: first,
      paths: [first, second].sort(),
      missing: [],
    });
  });

  it('unregister and clean leave no location rows behind', async () => {
    const first = makeProject(join(testDir, 'one'), 'gone-T12354');
    await recordProjectEncounter(first);
    const second = join(testDir, 'two');
    cpSync(first, second, { recursive: true });
    await recordProjectEncounter(second);
    const keep = makeProject(join(testDir, 'keep'), 'keep-T12354');
    await recordProjectEncounter(keep);

    const { nexusUnregister } = await import('../registry.js');
    await nexusUnregister('one');
    expect((await registryState('gone-T12354')).paths).toEqual([]);

    const { cleanProjects } = await import('../projects-clean.js');
    await cleanProjects({ dryRun: false, pattern: '/keep$' });
    expect((await registryState('keep-T12354')).paths).toEqual([]);
  });
});
