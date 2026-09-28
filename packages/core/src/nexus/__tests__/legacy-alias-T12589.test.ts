/**
 * T12589 — a truncated legacy alias shared by several projects names none.
 *
 * The legacy id is `base64url(path).slice(0, 32)`: only the first 24 path
 * bytes. Two sibling directories under one temp root share those bytes, so
 * they derive the same key, exactly as every project under
 * `/Users/<name>/projects/` does.
 *
 * - The second project's encounter writes nothing to stderr.
 * - The shared key resolves to no project (core registry readers and the
 *   raw-SQL resolver in `@cleocode/paths`); a key only one project claims
 *   still resolves.
 * - `cleo doctor projects` reports an existing ambiguous alias row, removes it
 *   under a receipt, and the receipt rolls it back. The next encounter does
 *   not record it again.
 *
 * Every case runs against a temp `CLEO_HOME`.
 *
 * @task T12589
 */

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyProjectId, resolveCanonicalCleoDir } from '@cleocode/paths';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyProjectRegistryRepair,
  inspectProjectRegistry,
  rollbackProjectRegistryRepair,
} from '../../doctor/projects.js';
import { getCleoHome, recordProjectEncounter, resolveProjectById } from '../../paths.js';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import { resetDbState } from '../../store/sqlite.js';
import { NexusProjectAmbiguityError, nexusGetProject } from '../registry.js';

let testDir: string;
let savedHome: string | undefined;

beforeEach(async () => {
  // Registry writers store resolved paths; macOS /tmp is a symlink.
  testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-legacy-alias-T12589-')));
  savedHome = process.env['CLEO_HOME'];
  process.env['CLEO_HOME'] = join(testDir, 'cleo-home');
  mkdirSync(process.env['CLEO_HOME'], { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await awaitBackgroundOps();
  resetDbState();
  const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
  resetNexusDbState();
  if (savedHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = savedHome;
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** Create an initialised-looking project declaring `projectId`. */
function makeProject(name: string, projectId: string): string {
  const root = join(testDir, name);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.cleo', 'project-info.json'), JSON.stringify({ projectId }));
  return root;
}

/** Encounter `root`, returning everything written to stderr meanwhile. */
async function encounter(root: string): Promise<string> {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await recordProjectEncounter(root);
    await awaitBackgroundOps();
  } finally {
    spy.mockRestore();
  }
  return written.join('');
}

async function aliasRow(legacyId: string) {
  const { getNexusRegistryDb } = await import('../../store/nexus-sqlite.js');
  const { projectIdAliases } = await import('../../store/schema/nexus-schema.js');
  const db = await getNexusRegistryDb(getCleoHome());
  return db.select().from(projectIdAliases).where(eq(projectIdAliases.legacyId, legacyId)).get();
}

/** Two sibling projects sharing the truncated legacy key. */
async function twoSiblings() {
  const alpha = makeProject('alpha', 'alpha-T12589');
  const beta = makeProject('beta', 'beta-T12589');
  const alias = legacyProjectId(alpha);
  expect(legacyProjectId(beta)).toBe(alias);
  expect(await encounter(alpha)).toBe('');
  return { alpha, beta, alias };
}

describe('truncated legacy alias shared by several projects (T12589)', () => {
  it('a second project under the same prefix encounters without writing to stderr', async () => {
    const { beta } = await twoSiblings();
    expect(await encounter(beta)).toBe('');
    // A repeated encounter (every command) stays silent too.
    expect(await encounter(beta)).toBe('');
  });

  it('a shared alias resolves to no project; a sole claimant still resolves', async () => {
    const { alpha, beta, alias } = await twoSiblings();
    expect((await resolveProjectById(alias))?.projectId).toBe('alpha-T12589');
    expect(resolveCanonicalCleoDir(alias)).toBe(join(alpha, '.cleo'));

    await encounter(beta);
    expect(await resolveProjectById(alias)).toBeNull();
    expect(resolveCanonicalCleoDir(alias)).toBeNull();
    const refused = await nexusGetProject(alias).catch((error: Error) => error);
    expect(refused).toBeInstanceOf(NexusProjectAmbiguityError);
    expect(
      (refused as NexusProjectAmbiguityError).candidates.map((c) => c.projectId).sort(),
    ).toEqual(['alpha-T12589', 'beta-T12589']);
  });

  it('doctor projects reports the ambiguous row, removes it under a receipt, and rolls it back', async () => {
    const { alpha, beta, alias } = await twoSiblings();
    await encounter(beta);
    const recorded = await aliasRow(alias);
    expect(recorded?.canonicalId).toBe('alpha-T12589');

    const report = await inspectProjectRegistry({ roots: [testDir] });
    expect(report.ambiguousAliases).toEqual([
      expect.objectContaining({
        legacyId: alias,
        canonicalId: 'alpha-T12589',
        claimants: ['alpha-T12589', 'beta-T12589'],
        remedy: 'cleo doctor projects --apply',
      }),
    ]);

    const applied = await applyProjectRegistryRepair({ roots: [testDir] });
    expect(applied.receipt?.actions).toContainEqual({
      action: 'drop-ambiguous-alias',
      projectId: 'alpha-T12589',
      from: alpha,
      alias,
      outcome: 'applied',
    });
    expect(await aliasRow(alias)).toBeUndefined();
    expect((await inspectProjectRegistry({ roots: [testDir] })).ambiguousAliases).toEqual([]);

    const receiptId = applied.receipt?.receiptId ?? '';
    const rolledBack = await rollbackProjectRegistryRepair(receiptId);
    expect(rolledBack.restored.aliases).toBe(1);
    expect(await aliasRow(alias)).toEqual(recorded);
  });

  it('after the repair, no encounter records the shared key again', async () => {
    const { alpha, beta, alias } = await twoSiblings();
    await encounter(beta);
    await applyProjectRegistryRepair({ roots: [testDir] });
    expect(await aliasRow(alias)).toBeUndefined();
    expect(await encounter(alpha)).toBe('');
    expect(await encounter(beta)).toBe('');
    expect(await aliasRow(alias)).toBeUndefined();
  });
});
