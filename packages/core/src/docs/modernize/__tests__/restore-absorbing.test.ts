/**
 * A modernize undo never writes a lifecycle transition the absorbing rule
 * refuses (T14333). `superseded` has no leave op (`docs.lifecycle.transitions`):
 * an undo that put the older doc back to its prior status would hold on the
 * undoing device only, a permanent divergence. The undo keeps a landed
 * supersession and restores everything a receiver would also apply.
 *
 * @task T14333
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../../store/__tests__/test-db-helper.js';
import { resolveConduitDocUid } from '../../../store/conduit-doc-history.js';
import { conduitAttachments } from '../../../store/schema/cleo-project/conduit.js';
import { getDb, getNativeDb } from '../../../store/sqlite.js';
import { docsAttachments } from '../../../store/tasks-schema.js';
import { runLegacyDocMigration } from '../../legacy-doc-migration.js';
import { supersedeDoc } from '../../supersede.js';
import { readSupersessionPrior, restoreSupersession } from '../restore.js';

let env: TestDbEnv;

/** The same two synced docs on a device, both with their identity. */
async function seedPair(target: TestDbEnv): Promise<void> {
  const db = await getDb(target.tempDir);
  for (const slug of ['undo-older', 'undo-newer']) {
    const body = Buffer.from(`# ${slug}\n`);
    const hash = createHash('sha256').update(body).digest('hex');
    const path = join(target.cleoDir, 'blobs', 'blobs', hash);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    await db
      .insert(docsAttachments)
      .values({
        id: `att-${slug}`,
        sha256: hash,
        attachmentJson: JSON.stringify({ kind: 'blob', mime: 'text/markdown', sha256: hash }),
        slug,
        createdAt: '2026-09-01T00:00:00.000Z',
      })
      .run();
  }
  const native = getNativeDb(target.tempDir);
  if (!native) throw new Error('expected a native handle');
  const migrated = await runLegacyDocMigration({
    projectRoot: target.tempDir,
    db: native,
    cwd: target.tempDir,
  });
  expect(migrated.report.status).toBe('completed');
}

/** The registry and identity state of the pair, for comparing devices. */
async function pairState(target: TestDbEnv) {
  const db = await getDb(target.tempDir);
  const registry = await db
    .select({
      slug: docsAttachments.slug,
      lifecycleStatus: docsAttachments.lifecycleStatus,
      supersededBy: docsAttachments.supersededBy,
      supersedes: docsAttachments.supersedes,
    })
    .from(docsAttachments)
    .all();
  const identity = await db
    .select({
      slug: conduitAttachments.slug,
      lifecycleStatus: conduitAttachments.lifecycleStatus,
      supersededByUid: conduitAttachments.supersededByUid,
      supersedesUid: conduitAttachments.supersedesUid,
    })
    .from(conduitAttachments)
    .all();
  const bySlug = <T extends { slug: string | null }>(rows: T[]) =>
    [...rows].sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  return { registry: bySlug(registry), identity: bySlug(identity) };
}

beforeEach(async () => {
  env = await createTestDb();
});

afterEach(async () => {
  await env.cleanup();
});

describe('modernize undo and the absorbing lifecycle (T14333)', () => {
  it('keeps a landed supersession: the older doc stays superseded on the registry and the identity', async () => {
    await seedPair(env);
    const prior = await readSupersessionPrior(env.tempDir, 'undo-older', 'undo-newer');
    if (!prior) throw new Error('expected a prior');
    await supersedeDoc(env.tempDir, { oldSlug: 'undo-older', newSlug: 'undo-newer' });

    expect(await restoreSupersession(env.tempDir, 'undo-older', 'undo-newer', prior)).toBe('kept');
    const db = await getDb(env.tempDir);
    const older = await db
      .select()
      .from(docsAttachments)
      .where(eq(docsAttachments.slug, 'undo-older'))
      .get();
    expect(older?.lifecycleStatus).toBe('superseded');
    expect(older?.supersededBy).toBe('att-undo-newer');
    const newer = await db
      .select()
      .from(docsAttachments)
      .where(eq(docsAttachments.slug, 'undo-newer'))
      .get();
    // The back pointer is plain LWW: restored.
    expect(newer?.supersedes).toBeNull();
    const olderUid = await resolveConduitDocUid(env.tempDir, 'undo-older');
    const identity = await db
      .select()
      .from(conduitAttachments)
      .where(eq(conduitAttachments.uid, olderUid ?? ''))
      .get();
    expect(identity?.lifecycleStatus).toBe('superseded');
  });

  it('a supersession that never landed is restored as before', async () => {
    await seedPair(env);
    const prior = await readSupersessionPrior(env.tempDir, 'undo-older', 'undo-newer');
    if (!prior) throw new Error('expected a prior');
    expect(await restoreSupersession(env.tempDir, 'undo-older', 'undo-newer', prior)).toBe(
      'restored',
    );
  });

  it('two devices: an undo on one leaves both registries convergent', async () => {
    // Device A supersedes and then undoes; device B received the supersede.
    const a = env;
    await seedPair(a);
    const prior = await readSupersessionPrior(a.tempDir, 'undo-older', 'undo-newer');
    if (!prior) throw new Error('expected a prior');
    await supersedeDoc(a.tempDir, { oldSlug: 'undo-older', newSlug: 'undo-newer' });
    await restoreSupersession(a.tempDir, 'undo-older', 'undo-newer', prior);
    const afterA = await pairState(a);
    await a.cleanup();

    const b = await createTestDb();
    env = b;
    await seedPair(b);
    await supersedeDoc(b.tempDir, { oldSlug: 'undo-older', newSlug: 'undo-newer' });
    // What B applies of A's undo: only LWW writes reach it (no row left
    // superseded, which B's absorbing rule would refuse) — the cleared back
    // pointer on the newer doc, on both tables.
    const db = await getDb(b.tempDir);
    await db
      .update(docsAttachments)
      .set({ supersedes: null })
      .where(eq(docsAttachments.slug, 'undo-newer'))
      .run();
    await db
      .update(conduitAttachments)
      .set({ supersedesUid: null })
      .where(eq(conduitAttachments.slug, 'undo-newer'))
      .run();
    expect(await pairState(b)).toEqual(afterA);
  });
});
