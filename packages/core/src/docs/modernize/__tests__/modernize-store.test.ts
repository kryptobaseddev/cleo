/**
 * `cleo docs modernize --store` (T14118): re-kind, re-slug with alias, ADR
 * number collisions and rollback, on a fixture store in a temp project.
 *
 * @task T14118
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { runDocsModernize } from '../index.js';
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
    // Alpha was born first but edited last: its live row is the newest, yet it keeps 051.
    const { updateDocBySlug } = await import('../../docs-update.js');
    const edited = await updateDocBySlug(projectRoot, {
      slug: 'adr-051-alpha',
      content: '# ADR 051 alpha\n\nedited later\n',
    });
    expect(edited.ok).toBe(true);
    // A decision linked under beta's old slug follows the renumbering.
    const { linkDecisionToAdr, listDecisionLinksForAdr } = await import(
      '../../../store/decision-adr-links.js'
    );
    await linkDecisionToAdr(projectRoot, { decisionId: 'D9001', adrSlug: 'adr-051-beta' });
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
    expect((plan.storeRows ?? []).some((r) => r.slug === 'adr-051-alpha')).toBe(false);
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
    expect(
      (await listDecisionLinksForAdr(projectRoot, 'adr-052-beta')).map((l) => l.decisionId),
    ).toEqual(['D9001']);
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

  /** Write a reviewed store-mode plan file renaming `[slug, newSlug, task?]` rows (T14578). */
  async function writeStorePlan(rows: ReadonlyArray<readonly [string, string, string?]>) {
    const store = createAttachmentStore();
    const storeRows = [];
    for (const [slug, newSlug, task] of rows) {
      const found = await store.findBySlug(slug, projectRoot);
      if (!found) throw new Error(`fixture slug ${slug} missing`);
      storeRows.push({
        attachmentId: found.metadata.id,
        sha256: found.metadata.sha256,
        slug,
        newSlug,
        kind: 'note',
        newKind: 'note',
        ownerTasks: task ? [task] : [],
        reasons: ['reviewed rename'],
        judgments: [],
      });
    }
    const plan = {
      root: projectRoot,
      generatedAt: '2026-11-14T00:00:00Z',
      rows: [],
      counts: { keep: 0, rename: 0, 'merge-into': 0, delete: 0 },
      mode: 'store',
      storeRows,
    };
    const file = join(projectRoot, 'store-plan.json');
    writeFileSync(file, JSON.stringify(plan));
    return file;
  }

  it('applies a saved two-row store plan through --plan, and rollback restores both slugs (T14578)', async () => {
    await seed('t100-alpha-notes', '# Alpha\n', 'note', '2026-01-01T00:00:00Z');
    await seed('t200-beta-notes', '# Beta\n', 'note', '2026-01-02T00:00:00Z');
    const planFile = await writeStorePlan([
      ['t100-alpha-notes', 'alpha-notes', 'T100'],
      ['t200-beta-notes', 'beta-notes', 'T200'],
    ]);
    const result = await runDocsModernize(projectRoot, { planFile, apply: true });
    expect(result.mode).toBe('apply');
    const receipt = result.receipt;
    if (!receipt) throw new Error('no receipt');
    expect(receipt.ops.map((o) => o.op).sort()).toEqual([
      'link-task',
      'link-task',
      'reslug',
      'reslug',
    ]);
    expect(await resolveDocSlug(projectRoot, 't100-alpha-notes')).toBe('alpha-notes');
    expect(await resolveDocSlug(projectRoot, 't200-beta-notes')).toBe('beta-notes');

    await runDocsModernize(projectRoot, { rollback: receipt.runId });
    const store = createAttachmentStore();
    expect(await store.findBySlug('t100-alpha-notes', projectRoot)).not.toBeNull();
    expect(await store.findBySlug('t200-beta-notes', projectRoot)).not.toBeNull();
    // Every rename keeps the previous slug as an alias, so the new one now resolves back.
    expect(await resolveDocSlug(projectRoot, 'alpha-notes')).toBe('t100-alpha-notes');
    expect(await resolveDocSlug(projectRoot, 'beta-notes')).toBe('t200-beta-notes');
  });

  it('refuses a saved store plan whose new slug is taken, before any write (T14578)', async () => {
    await seed('t300-gamma-notes', '# Gamma\n', 'note', '2026-01-01T00:00:00Z');
    await seed('t301-delta-notes', '# Delta\n', 'note', '2026-01-01T00:00:00Z');
    await seed('gamma-notes', '# Another gamma\n', 'note', '2026-01-02T00:00:00Z');
    // The first row is valid; the second collides. Nothing may be renamed.
    const planFile = await writeStorePlan([
      ['t301-delta-notes', 'delta-notes'],
      ['t300-gamma-notes', 'gamma-notes'],
    ]);
    await expect(runDocsModernize(projectRoot, { planFile, apply: true })).rejects.toThrow(
      /already taken/,
    );
    const store = createAttachmentStore();
    expect(await store.findBySlug('t301-delta-notes', projectRoot)).not.toBeNull();
    expect(await store.findBySlug('delta-notes', projectRoot)).toBeNull();
  });

  it('refuses a saved store plan whose new slug breaks the naming rule (T14578)', async () => {
    await seed('t500-epsilon-notes', '# Epsilon\n', 'note', '2026-01-01T00:00:00Z');
    const planFile = await writeStorePlan([['t500-epsilon-notes', 't500-epsilon']]);
    await expect(runDocsModernize(projectRoot, { planFile, apply: true })).rejects.toThrow(
      /naming rule/,
    );
  });

  it('refuses a stale saved store plan whose slug names another doc now (T14578)', async () => {
    await seed('t600-zeta-notes', '# Zeta\n', 'note', '2026-01-01T00:00:00Z');
    const planFile = await writeStorePlan([['t600-zeta-notes', 'zeta-notes']]);
    const { readFileSync } = await import('node:fs');
    const stale = JSON.parse(readFileSync(planFile, 'utf-8')) as {
      storeRows: Array<{ attachmentId: string }>;
    };
    const row = stale.storeRows[0];
    if (row) row.attachmentId = createHash('sha256').update('not this doc').digest('hex');
    writeFileSync(planFile, JSON.stringify(stale));
    await expect(runDocsModernize(projectRoot, { planFile, apply: true })).rejects.toThrow(
      /no longer names this doc/,
    );
  });
});
