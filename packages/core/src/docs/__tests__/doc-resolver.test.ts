/**
 * One doc resolver (T14288): a slug, live or an old alias, resolves through
 * the doc's immutable conduit uid to its head version, and the version count
 * comes from the version DAG.
 *
 * Covered:
 *   - a migrated doc resolves by uid, with no `W_DOC_NOT_MIGRATED` warning;
 *   - a doc with no identity resolves through its registry row, marked
 *     `legacy`, with the warning;
 *   - a head moved by sync (its content has no registry row) takes its
 *     metadata from the slug row and its bytes from the head version;
 *   - an update reports the version count from the DAG.
 *
 * @task T14288
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drainWarnings } from '../../output.js';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import {
  appendConduitAttachmentVersion,
  getConduitDocHead,
  listConduitAttachmentVersions,
  upsertConduitDocHead,
} from '../../store/conduit-doc-history.js';
import { getDb, getNativeDb } from '../../store/sqlite.js';
import { encodeHlc } from '../../store/sync/hlc.js';
import { docsAttachments } from '../../store/tasks-schema.js';
import { createDocsReadModel } from '../docs-read-model.js';
import { updateDocBySlug } from '../docs-update.js';
import { runLegacyDocMigration } from '../legacy-doc-migration.js';
import { resolveDocRef } from '../slug-rename.js';

let env: TestDbEnv;

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Store bytes in the blob store and return their hash. */
function storeBlob(bytes: Buffer): string {
  const hash = sha(bytes);
  const path = join(env.cleoDir, 'blobs', 'blobs', hash);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return hash;
}

/** Seed a legacy doc row (no conduit identity) holding `body`. */
async function seedLegacyDoc(slug: string, body: Buffer): Promise<string> {
  const hash = storeBlob(body);
  const db = await getDb(env.tempDir);
  await db
    .insert(docsAttachments)
    .values({
      id: `att-${slug}`,
      sha256: hash,
      attachmentJson: JSON.stringify({ kind: 'blob', mime: 'text/markdown', sha256: hash }),
      slug,
      type: 'research',
      createdAt: '2026-09-01T00:00:00.000Z',
    })
    .run();
  return hash;
}

/** Give every legacy doc its identity and head (`cleo docs migrate`). */
async function migrate(): Promise<void> {
  const native = getNativeDb(env.tempDir);
  if (!native) throw new Error('expected a native handle');
  const result = await runLegacyDocMigration({
    projectRoot: env.tempDir,
    db: native,
    cwd: env.tempDir,
  });
  expect(result.report.status).toBe('completed');
}

const warningCodes = (): string[] => drainWarnings()?.map((w) => w.code) ?? [];

beforeEach(async () => {
  env = await createTestDb();
  drainWarnings();
});

afterEach(async () => {
  await env.cleanup();
});

describe('resolveDocRef (T14288)', () => {
  it('a migrated doc resolves by uid to its head, without a warning', async () => {
    const hash = await seedLegacyDoc('resolver-migrated', Buffer.from('# Migrated\n'));
    await migrate();
    drainWarnings();

    const ref = await resolveDocRef(env.tempDir, 'resolver-migrated');
    expect(ref?.identity).toBe('uid');
    expect(ref?.docUid).toBeTruthy();
    expect(ref?.headVersionUid).toBeTruthy();
    expect(ref?.sha256).toBe(hash);
    expect(warningCodes()).not.toContain('W_DOC_NOT_MIGRATED');
  });

  it('a doc with no identity resolves through its row, marked legacy, with a warning', async () => {
    const hash = await seedLegacyDoc('resolver-legacy', Buffer.from('# Legacy\n'));

    const ref = await resolveDocRef(env.tempDir, 'resolver-legacy');
    expect(ref?.identity).toBe('legacy');
    expect(ref?.docUid).toBeNull();
    expect(ref?.sha256).toBe(hash);
    expect(warningCodes()).toContain('W_DOC_NOT_MIGRATED');
    expect(await resolveDocRef(env.tempDir, 'no-such-doc')).toBeNull();
  });

  it('a head moved by sync takes metadata from the slug row and bytes from the head', async () => {
    await seedLegacyDoc('resolver-synced', Buffer.from('# Synced\n\nlocal text.\n'));
    await migrate();
    const ref = await resolveDocRef(env.tempDir, 'resolver-synced');
    if (!ref?.docUid || !ref.headVersionUid) throw new Error('expected a uid-resolved doc');

    // Another device's version lands: its content has no registry row here.
    const remote = Buffer.from('# Synced\n\nlocal text.\n\nremote addition.\n');
    const remoteHash = storeBlob(remote);
    const version = await appendConduitAttachmentVersion(env.tempDir, {
      attachmentUid: ref.docUid,
      parentVersionUid: ref.headVersionUid,
      authorAgentId: 'remote-device',
      storageKey: `sha256:${remoteHash}`,
      contentHash: remoteHash,
      originalSize: remote.length,
      compressedSize: remote.length,
      tokens: 6,
    });
    const head = await getConduitDocHead(env.tempDir, ref.docUid);
    await upsertConduitDocHead(env.tempDir, {
      attachmentUid: ref.docUid,
      headVersionUid: version.uid ?? '',
      headHlc: encodeHlc({
        phys: Date.parse('2099-01-01T00:00:00.000Z'),
        ctr: 0,
        replica: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      }),
    });
    expect((await getConduitDocHead(env.tempDir, ref.docUid))?.headVersionUid).not.toBe(
      head?.headVersionUid,
    );

    const moved = await resolveDocRef(env.tempDir, 'resolver-synced');
    expect(moved?.identity).toBe('uid');
    expect(moved?.sha256).toBe(remoteHash);
    expect(moved?.row.slug).toBe('resolver-synced');
    expect(moved?.row.type).toBe('research');

    // The read model serves the head's bytes under the slug row's metadata.
    const model = createDocsReadModel(env.tempDir);
    const doc = await model.resolveBySlug('resolver-synced');
    expect(doc?.sha256).toBe(remoteHash);
    expect(doc?.kind).toBe('research');
    expect(doc ? await model.fetchContent(doc) : null).toBe(remote.toString('utf-8'));
  });
});

describe('the version ordinal comes from the DAG (T14288 AC3)', () => {
  it('an update reports the doc version count from its version rows', async () => {
    await seedLegacyDoc('resolver-versions', Buffer.from('# Versions\n\nfirst.\n'));
    await migrate();
    const first = await updateDocBySlug(env.tempDir, {
      slug: 'resolver-versions',
      content: '# Versions\n\nfirst.\n\nsecond.\n',
    });
    expect(first.ok).toBe(true);
    const second = await updateDocBySlug(env.tempDir, {
      slug: 'resolver-versions',
      content: '# Versions\n\nfirst.\n\nsecond.\n\nthird.\n',
    });
    expect(second.ok).toBe(true);
    const ref = await resolveDocRef(env.tempDir, 'resolver-versions');
    const rows = await listConduitAttachmentVersions(env.tempDir, ref?.docUid ?? '');
    expect(rows).toHaveLength(3);
    if (!second.ok) return;
    expect(second.result.version).toBe(3);
  });
});
