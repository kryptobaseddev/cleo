/**
 * `cleo docs modernize --store` (T14118): re-kind, re-slug with alias, ADR
 * number collisions and rollback, on a fixture store in a temp project.
 *
 * @task T14118
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobAttachment } from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttachmentStore } from '../../../store/attachment-store.js';
import { closeDb, getDb } from '../../../store/sqlite.js';
import { attachments } from '../../../store/tasks-schema.js';
import { createDocsReadModel } from '../../docs-read-model.js';
import { listDocSlugs, resolveDocSlug } from '../../slug-rename.js';
import { rollbackDocsModernize } from '../apply.js';
import { applyDocsStoreModernize, planDocsStoreModernize } from '../store.js';

describe('modernize --store (fixture store)', () => {
  let projectRoot: string;
  let prevCleoDir: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-modernize-store-'));
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    prevCleoDir = process.env['CLEO_DIR'];
    process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
    prevCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    closeDb();
    process.chdir(prevCwd);
    if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = prevCleoDir;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function seed(
    slug: string,
    body: string,
    type: string | undefined,
    createdAt: string,
  ): Promise<string> {
    const store = createAttachmentStore();
    const bytes = Buffer.from(body, 'utf-8');
    const attachment: Omit<BlobAttachment, 'sha256'> = {
      kind: 'blob',
      storageKey: '',
      mime: 'text/markdown',
      size: bytes.byteLength,
    };
    const meta = await store.put(
      bytes,
      attachment,
      'task',
      '__project__',
      'store-test',
      projectRoot,
      { slug, ...(type ? { type } : {}) },
    );
    const db = await getDb(projectRoot);
    await db.update(attachments).set({ createdAt }).where(eq(attachments.id, meta.id)).run();
    return meta.id;
  }

  it('plans re-kind, re-slug with task links and ADR renumbering; apply and rollback round-trip', async () => {
    const planId = await seed(
      't123-foo-plan-2026-01-01',
      '# Foo plan\n\nsteps\n',
      'plan',
      '2026-01-01T00:00:00Z',
    );
    const untypedId = await seed(
      'loose-requirements',
      '# Loose\n\n## Requirements\n- must\n',
      undefined,
      '1970-01-01T00:00:00Z',
    );
    await seed('adr-051-alpha', '# ADR 051 alpha\n', 'adr', '2026-01-02T00:00:00Z');
    const betaId = await seed('adr-051-beta', '# ADR 051 beta\n', 'adr', '2026-02-02T00:00:00Z');
    await seed('clean-note', '# Clean\n', 'note', '2026-01-03T00:00:00Z');

    const plan = await planDocsStoreModernize({ projectRoot, decide: { connection: null } });
    expect(plan.mode).toBe('store');
    const row = (id: string) => (plan.storeRows ?? []).find((r) => r.attachmentId === id);

    expect(row(planId)).toMatchObject({
      slug: 't123-foo-plan-2026-01-01',
      newSlug: 'foo-plan',
      newKind: 'plan',
      ownerTasks: ['T123'],
    });
    expect(row(untypedId)).toMatchObject({
      kind: null,
      newKind: 'spec',
      newSlug: 'loose-requirements',
    });
    expect(row(betaId)?.newSlug).toBe('adr-052-beta');
    expect(
      (plan.storeRows ?? []).some((r) => r.slug === 'adr-051-alpha' || r.slug === 'clean-note'),
    ).toBe(false);

    const receipt = await applyDocsStoreModernize(plan, projectRoot);
    expect(receipt.ops.map((o) => o.op).sort()).toEqual([
      'link-task',
      'rekind',
      'reslug',
      'reslug',
    ]);
    expect(typeof receipt.durationMs).toBe('number');

    // Old slug stays resolvable as an alias; fetch through the read model finds the doc.
    expect(await resolveDocSlug(projectRoot, 't123-foo-plan-2026-01-01')).toBe('foo-plan');
    expect(await listDocSlugs(projectRoot, 'foo-plan')).toEqual([
      'foo-plan',
      't123-foo-plan-2026-01-01',
    ]);
    const viaAlias = await createDocsReadModel().resolveLatest('t123-foo-plan-2026-01-01');
    expect(viaAlias?.slug).toBe('foo-plan');
    const store = createAttachmentStore();
    expect((await store.listRefs(planId, projectRoot)).map((r) => r.ownerId)).toContain('T123');
    expect((await store.findBySlug('loose-requirements', projectRoot))?.type).toBe('spec');

    await rollbackDocsModernize(projectRoot, receipt.runId);
    expect((await store.findBySlug('t123-foo-plan-2026-01-01', projectRoot))?.metadata.id).toBe(
      planId,
    );
    expect((await store.findBySlug('adr-051-beta', projectRoot))?.metadata.id).toBe(betaId);
    expect((await store.findBySlug('loose-requirements', projectRoot))?.type).toBeNull();
    expect((await store.listRefs(planId, projectRoot)).map((r) => r.ownerId)).not.toContain('T123');
  });
});
