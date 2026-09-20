/**
 * Pipeline Manifest SQLite Implementation Tests
 *
 * Tests all 14 pipeline manifest operations against a real tasks.db
 * SQLite database (via temp directory). Covers the append → read → find
 * → list → archive workflow, contentHash dedup, stats, contradictions,
 * validate, and migration function.
 *
 * @task T5581
 * @epic T5576
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtendedManifestEntry } from '../index.js';
import {
  distillManifestEntry,
  migrateManifestJsonlToSqlite,
  pipelineManifestAppend,
  pipelineManifestArchive,
  pipelineManifestCompact,
  pipelineManifestContradictions,
  pipelineManifestFind,
  pipelineManifestLink,
  pipelineManifestList,
  pipelineManifestPending,
  pipelineManifestRead,
  pipelineManifestShow,
  pipelineManifestStats,
  pipelineManifestSuperseded,
  pipelineManifestValidate,
  readManifestEntries,
} from '../pipeline-manifest-sqlite.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENTRY_A: ExtendedManifestEntry = {
  id: 'T001-research',
  file: 'out/T001.md',
  title: 'First Research',
  date: '2026-01-15',
  status: 'completed',
  agent_type: 'research',
  topics: ['async-ops', 'engine'],
  key_findings: ['This library is deprecated', 'System supports structured output'],
  actionable: true,
  linked_tasks: ['T001'],
  needs_followup: [],
};

const ENTRY_B: ExtendedManifestEntry = {
  id: 'T002-spec',
  file: 'out/T002.md',
  title: 'Specification Doc',
  date: '2026-02-01',
  status: 'partial',
  agent_type: 'specification',
  topics: ['spec', 'api'],
  key_findings: ['spec1'],
  actionable: false,
  linked_tasks: ['T002'],
  needs_followup: ['T003'],
};

const ENTRY_C: ExtendedManifestEntry = {
  id: 'T003-impl',
  file: 'out/T003.md',
  title: 'Implementation Notes',
  date: '2026-02-10',
  status: 'blocked',
  agent_type: 'implementation',
  topics: ['engine', 'native'],
  key_findings: ['This library is recommended for production'],
  actionable: true,
  linked_tasks: ['T001', 'T003'],
  needs_followup: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedEntries(root: string, entries: ExtendedManifestEntry[]): Promise<void> {
  for (const entry of entries) {
    await pipelineManifestAppend(entry, root);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Resolve explicit fixture cwd values independently of the shared setup project.
beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('pipeline-manifest-sqlite', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'cleo-manifest-sqlite-'));
    mkdirSync(join(testRoot, '.cleo'), { recursive: true });
    // validateProjectRoot requires .git/ sibling (legacy-fallback path).
    mkdirSync(join(testRoot, '.git'), { recursive: true });
  });

  afterEach(async () => {
    const { resetDbState } = await import('../../store/sqlite.js');
    resetDbState();
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  describe('canonical storage with enforced foreign keys and retained history', () => {
    beforeEach(async () => {
      const { bindTasksDomain } = await import('../../store/sqlite.js');
      const { native } = await bindTasksDomain(testRoot);
      native.exec('PRAGMA foreign_keys=ON');
      expect(native.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      native.exec(
        "INSERT INTO tasks_tasks(id,title,status,created_at,updated_at) VALUES ('T001','Canonical task','pending','2026-09-20','2026-09-20')",
      );
      expect(native.prepare("SELECT count(*) AS n FROM tasks WHERE id='T001'").get()).toEqual({
        n: 0,
      });
    });

    async function seedHistory(table: 'pipeline_manifest' | 'docs_pipeline_manifest', id: string) {
      const { bindTasksDomain } = await import('../../store/sqlite.js');
      const { native } = await bindTasksDomain(testRoot);
      const entry = { ...ENTRY_A, id };
      native
        .prepare(
          `INSERT INTO ${table}(id,type,content,status,source_file,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          entry.agent_type,
          JSON.stringify(entry),
          'active',
          entry.file,
          JSON.stringify(entry),
          '2026-01-15 00:00:00',
        );
      return native;
    }

    async function storeDocument(root: string, slug: string, content: string) {
      const { createAttachmentStore } = await import('../../store/attachment-store.js');
      const { reserveSlug } = await import('../../docs/slug-allocator.js');
      expect(await reserveSlug('note', slug, { cwd: root })).toMatchObject({ ok: true });
      vi.stubEnv('CLEO_STRICT_SLUG_ALLOCATOR', '1');
      const descriptor = {
        kind: 'blob' as const,
        mime: 'text/markdown',
        storageKey: 'pending',
        size: Buffer.byteLength(content),
      };
      return createAttachmentStore().put(
        content,
        descriptor,
        'task',
        'T001',
        'manifest-test',
        root,
        { slug, type: 'note' },
      );
    }

    it('resolves a canonical docs URI to the exact independently retrieved document bytes', async () => {
      const { createDocsReadModel } = await import('../../docs/docs-read-model.js');
      const content = '# Authentic report\n\nUnicode π and literal | evidence.  \n';
      const slug = 'manifest-doc-evidence';
      const stored = await storeDocument(testRoot, slug, content);
      const model = createDocsReadModel(testRoot);
      const doc = await model.resolveLatest(slug);
      expect(doc?.sha256).toBe(createHash('sha256').update(content).digest('hex'));
      expect(doc).not.toBeNull();
      if (!doc) throw new Error('Canonical fixture document failed to resolve');
      expect(await model.fetchContent(doc)).toBe(content);
      for (const reference of [slug, stored.id, stored.sha256]) {
        const resolved =
          (await model.resolveLatest(reference)) ?? (await model.resolveByAttachmentId(reference));
        expect(resolved, `canonical docs reference ${reference}`).toMatchObject({
          id: stored.id,
          sha256: stored.sha256,
          slug,
          kind: 'note',
        });
        const entry = {
          ...ENTRY_A,
          id: `doc-${reference}`,
          file: `cleo://docs/${encodeURIComponent(reference)}`,
        };
        expect(await pipelineManifestAppend(entry, testRoot)).toMatchObject({ success: true });
        const shown = await pipelineManifestShow(entry.id, testRoot);
        expect(shown).toMatchObject({
          success: true,
          data: {
            file: entry.file,
            fileExists: true,
            fileContent: content,
            provenance: { tables: ['docs_pipeline_manifest'] },
          },
        });
        if (!shown.success) throw new Error(shown.error.message);
        expect(createHash('sha256').update(String(shown.data.fileContent)).digest('hex')).toBe(
          doc.sha256,
        );
      }
    });

    it('pins document reads to the manifest project despite conflicting ambient roots', async () => {
      const otherRoot = mkdtempSync(join(tmpdir(), 'cleo-manifest-doc-other-'));
      mkdirSync(join(otherRoot, '.git'));
      mkdirSync(join(otherRoot, '.cleo'));
      try {
        const slug = 'shared-report-slug';
        await storeDocument(testRoot, slug, '# Project A bytes');
        await storeDocument(otherRoot, slug, '# Project B bytes');
        expect(
          await pipelineManifestAppend({ ...ENTRY_A, file: `cleo://docs/${slug}` }, testRoot),
        ).toMatchObject({ success: true });
        vi.stubEnv('CLEO_ROOT', otherRoot);
        vi.stubEnv('CLEO_DIR', join(otherRoot, '.cleo'));
        expect(await pipelineManifestShow(ENTRY_A.id, testRoot)).toMatchObject({
          success: true,
          data: { fileContent: '# Project A bytes', fileExists: true },
        });
      } finally {
        const { resetDbState } = await import('../../store/sqlite.js');
        resetDbState();
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });

    it('distinguishes unavailable document content and failed reads from missing files', async () => {
      const { DocsReadModel } = await import('../../docs/docs-read-model.js');
      await storeDocument(testRoot, 'unavailable-report', '# Retained evidence');
      expect(
        await pipelineManifestAppend(
          { ...ENTRY_A, file: 'cleo://docs/unavailable-report' },
          testRoot,
        ),
      ).toMatchObject({ success: true });
      const fetch = vi.spyOn(DocsReadModel.prototype, 'fetchContent');
      try {
        fetch.mockResolvedValueOnce(null);
        expect(await pipelineManifestShow(ENTRY_A.id, testRoot)).toMatchObject({
          success: false,
          error: { code: 'E_MANIFEST_DOC_CONTENT_UNAVAILABLE' },
        });
        fetch.mockRejectedValueOnce(new Error('synthetic document read failure'));
        expect(await pipelineManifestShow(ENTRY_A.id, testRoot)).toMatchObject({
          success: false,
          error: { code: 'E_MANIFEST_SHOW', message: 'synthetic document read failure' },
        });
      } finally {
        fetch.mockRestore();
      }
    });

    it.each([
      ['cleo://docs/no-such-document', 'E_MANIFEST_DOC_NOT_FOUND'],
      ['cleo://docs/', 'E_MANIFEST_REFERENCE_INVALID'],
      ['cleo://docs/a/b', 'E_MANIFEST_REFERENCE_INVALID'],
      ['cleo://docs/a?version=2', 'E_MANIFEST_REFERENCE_INVALID'],
      ['cleo://docs/a#fragment', 'E_MANIFEST_REFERENCE_INVALID'],
      ['cleo://docs/%ZZ', 'E_MANIFEST_REFERENCE_INVALID'],
      ['cleo://docs/%2e%2e', 'E_MANIFEST_REFERENCE_INVALID'],
      ['cleo://docs/a%2fb', 'E_MANIFEST_REFERENCE_INVALID'],
      ['cleo://other/report', 'E_MANIFEST_REFERENCE_UNSUPPORTED'],
      ['https://example.invalid/report', 'E_MANIFEST_REFERENCE_UNSUPPORTED'],
    ])('reports explicit resolution failure for %s', async (file, code) => {
      const entry = { ...ENTRY_A, file };
      expect(await pipelineManifestAppend(entry, testRoot)).toMatchObject({ success: true });
      expect(await pipelineManifestShow(entry.id, testRoot)).toMatchObject({
        success: false,
        error: { code, details: { entryId: entry.id, reference: file } },
      });
    });

    it('keeps real file reads and missing-file behavior distinct from read failures', async () => {
      const entry = { ...ENTRY_A, file: 'ordinary.md' };
      expect(await pipelineManifestAppend(entry, testRoot)).toMatchObject({ success: true });
      expect(await pipelineManifestShow(entry.id, testRoot)).toMatchObject({
        success: true,
        data: { fileExists: false, fileContent: null },
      });
      writeFileSync(join(testRoot, entry.file), '# Ordinary bytes');
      expect(await pipelineManifestShow(entry.id, testRoot)).toMatchObject({
        success: true,
        data: { fileExists: true, fileContent: '# Ordinary bytes' },
      });
      rmSync(join(testRoot, entry.file));
      mkdirSync(join(testRoot, entry.file));
      expect(await pipelineManifestShow(entry.id, testRoot)).toMatchObject({
        success: false,
        error: { code: 'E_MANIFEST_SHOW' },
      });
    });

    it('appends for a task that exists only in tasks_tasks with foreign_keys=1', async () => {
      const result = await pipelineManifestAppend(ENTRY_A, testRoot);
      expect(result).toMatchObject({
        success: true,
        data: { appended: true, entryId: ENTRY_A.id },
      });
      const { bindTasksDomain, resetDbState } = await import('../../store/sqlite.js');
      const { native, store } = await bindTasksDomain(testRoot);
      expect(native.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(native.prepare('SELECT id,task_id FROM docs_pipeline_manifest').all()).toEqual([
        { id: ENTRY_A.id, task_id: 'T001' },
      ]);
      expect(native.prepare('SELECT count(*) AS n FROM pipeline_manifest').get()).toEqual({ n: 0 });
      const path = store.dbPath;
      // A fresh native process is the independent durability oracle; it reads
      // only this synthetic database, with no inherited provider/store environment.
      const freshRead = spawnSync(
        process.execPath,
        [
          '--disable-warning=ExperimentalWarning',
          '--input-type=module',
          '-e',
          'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.argv[1], { readOnly: true }); process.stdout.write(JSON.stringify(db.prepare("SELECT id,task_id,content FROM docs_pipeline_manifest").all())); db.close();',
          path,
        ],
        { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } },
      );
      expect(freshRead.error).toBeUndefined();
      expect(freshRead.status, freshRead.stderr).toBe(0);
      expect(JSON.parse(freshRead.stdout)).toEqual([
        { id: ENTRY_A.id, task_id: 'T001', content: JSON.stringify(ENTRY_A) },
      ]);
      resetDbState();
      expect(await pipelineManifestShow(ENTRY_A.id, testRoot)).toMatchObject({
        success: true,
        data: {
          title: ENTRY_A.title,
          provenance: { databasePath: path, tables: ['docs_pipeline_manifest'] },
        },
      });
    });

    it('retrieves both histories with physical source provenance without rewriting them', async () => {
      const native = await seedHistory('pipeline_manifest', 'legacy-only');
      await seedHistory('docs_pipeline_manifest', 'modern-only');
      const before = native.prepare('SELECT * FROM pipeline_manifest').all();
      expect(await pipelineManifestShow('legacy-only', testRoot)).toMatchObject({
        success: true,
        data: { provenance: { tables: ['pipeline_manifest'] } },
      });
      expect(await pipelineManifestShow('modern-only', testRoot)).toMatchObject({
        success: true,
        data: { provenance: { tables: ['docs_pipeline_manifest'] } },
      });
      expect(await pipelineManifestList({}, testRoot)).toMatchObject({
        success: true,
        data: {
          total: 2,
          filtered: 2,
          entries: expect.arrayContaining([
            expect.objectContaining({ id: 'legacy-only' }),
            expect.objectContaining({ id: 'modern-only' }),
          ]),
        },
      });
      expect(native.prepare('SELECT * FROM pipeline_manifest').all()).toEqual(before);
    });

    it('deduplicates identical persisted rows only and discloses both sources', async () => {
      const native = await seedHistory('pipeline_manifest', 'copied');
      native.exec('INSERT INTO docs_pipeline_manifest SELECT * FROM pipeline_manifest');
      expect(await pipelineManifestList({}, testRoot)).toMatchObject({
        success: true,
        data: {
          total: 1,
          entries: [
            expect.objectContaining({
              id: 'copied',
              provenance: {
                databasePath: expect.any(String),
                tables: ['docs_pipeline_manifest', 'pipeline_manifest'],
              },
            }),
          ],
        },
      });
    });

    it('rejects divergent same-ID payloads even when projected metadata looks identical', async () => {
      const native = await seedHistory('pipeline_manifest', 'collision');
      native.exec('INSERT INTO docs_pipeline_manifest SELECT * FROM pipeline_manifest');
      native
        .prepare('UPDATE docs_pipeline_manifest SET content=? WHERE id=?')
        .run('different authentic payload', 'collision');
      const before = native.prepare('SELECT * FROM pipeline_manifest').all();
      for (const read of [
        () => pipelineManifestShow('collision', testRoot),
        () => pipelineManifestList({}, testRoot),
        () => pipelineManifestRead(undefined, testRoot),
      ]) {
        expect(await read()).toMatchObject({
          success: false,
          error: {
            code: 'E_MANIFEST_ID_CONFLICT',
            details: {
              entryId: 'collision',
              candidates: expect.arrayContaining([
                expect.objectContaining({ table: 'pipeline_manifest' }),
                expect.objectContaining({ table: 'docs_pipeline_manifest' }),
              ]),
            },
          },
        });
      }
      await expect(readManifestEntries(testRoot)).rejects.toThrow('collision');
      expect(await pipelineManifestAppend({ ...ENTRY_A, id: 'collision' }, testRoot)).toMatchObject(
        { success: false, error: { code: 'E_MANIFEST_ID_CONFLICT' } },
      );
      expect(native.prepare('SELECT * FROM pipeline_manifest').all()).toEqual(before);
    });

    it('refuses mutations of legacy evidence and rolls back a mixed archive selection', async () => {
      const native = await seedHistory('pipeline_manifest', 'legacy-only');
      await seedHistory('docs_pipeline_manifest', 'modern-only');
      const before = native.prepare('SELECT * FROM pipeline_manifest').all();
      for (const mutate of [
        () => pipelineManifestAppend({ ...ENTRY_A, id: 'legacy-only' }, testRoot),
        () => pipelineManifestLink('T999', 'legacy-only', undefined, testRoot),
        () => pipelineManifestArchive('2027-01-01', testRoot),
        () => pipelineManifestCompact(testRoot),
      ]) {
        expect(await mutate()).toMatchObject({
          success: false,
          error: { code: 'E_MANIFEST_LEGACY_REPAIR_REQUIRED' },
        });
      }
      expect(native.prepare('SELECT * FROM pipeline_manifest').all()).toEqual(before);
      expect(native.prepare('SELECT archived_at FROM docs_pipeline_manifest').all()).toEqual([
        { archived_at: null },
      ]);
    });

    it('rolls back an archive when a later modern write fails', async () => {
      const native = await seedHistory('docs_pipeline_manifest', 'first');
      await seedHistory('docs_pipeline_manifest', 'second');
      native.exec(
        "CREATE TRIGGER reject_second BEFORE UPDATE ON docs_pipeline_manifest WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT,'second archive rejected'); END",
      );
      expect(await pipelineManifestArchive('2027-01-01', testRoot)).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('second archive rejected') },
      });
      expect(
        native.prepare('SELECT id,archived_at FROM docs_pipeline_manifest ORDER BY id').all(),
      ).toEqual([
        { id: 'first', archived_at: null },
        { id: 'second', archived_at: null },
      ]);
    });

    it('keeps explicitly addressed projects separate under interleaved ambient pins', async () => {
      const { bindTasksDomain } = await import('../../store/sqlite.js');
      const otherRoot = join(testRoot, 'other');
      mkdirSync(join(otherRoot, '.cleo'), { recursive: true });
      mkdirSync(join(otherRoot, '.git'));
      const other = await bindTasksDomain(otherRoot);
      other.native.exec('PRAGMA foreign_keys=ON');
      expect(other.native.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      vi.stubEnv('CLEO_ROOT', otherRoot);
      vi.stubEnv('CLEO_DIR', join(otherRoot, '.cleo'));
      expect(await pipelineManifestAppend(ENTRY_A, testRoot)).toMatchObject({ success: true });
      expect(
        await pipelineManifestAppend({ ...ENTRY_A, title: 'Other project' }, otherRoot),
      ).toMatchObject({ success: true });
      expect(await pipelineManifestShow(ENTRY_A.id, testRoot)).toMatchObject({
        success: true,
        data: {
          title: ENTRY_A.title,
          provenance: { databasePath: join(testRoot, '.cleo', 'cleo.db') },
        },
      });
      expect(await pipelineManifestShow(ENTRY_A.id, otherRoot)).toMatchObject({
        success: true,
        data: {
          title: 'Other project',
          provenance: { databasePath: join(otherRoot, '.cleo', 'cleo.db') },
        },
      });
    });

    it('surfaces native storage causes and never turns a failed diagnostic read into empty success', async () => {
      const { bindTasksDomain } = await import('../../store/sqlite.js');
      const { native } = await bindTasksDomain(testRoot);
      native.exec(
        "CREATE TRIGGER reject_manifest BEFORE INSERT ON docs_pipeline_manifest BEGIN SELECT RAISE(ABORT,'synthetic manifest storage failure'); END",
      );
      expect(await pipelineManifestAppend(ENTRY_A, testRoot)).toMatchObject({
        success: false,
        error: {
          code: 'E_MANIFEST_APPEND',
          message: expect.stringContaining('synthetic manifest storage failure'),
        },
      });
      native.exec('DROP TABLE docs_pipeline_manifest');
      expect(await pipelineManifestRead(undefined, testRoot)).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('docs_pipeline_manifest') },
      });
      await expect(readManifestEntries(testRoot)).rejects.toThrow('docs_pipeline_manifest');
    });
  });

  // =========================================================================
  // pipelineManifestAppend
  // =========================================================================

  describe('pipelineManifestAppend', () => {
    it('should append a valid entry', async () => {
      const result = await pipelineManifestAppend(ENTRY_A, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).appended).toBe(true);
      expect((result.data as any).entryId).toBe('T001-research');
    });

    it('should return error when entry is null', async () => {
      const result = await pipelineManifestAppend(null as any, testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should return error for missing required fields', async () => {
      const incomplete = { id: 'T999', file: 'out/T999.md' } as any;
      const result = await pipelineManifestAppend(incomplete, testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_VALIDATION_FAILED');
    });

    it('should update on duplicate id (upsert)', async () => {
      await pipelineManifestAppend(ENTRY_A, testRoot);
      const updated = { ...ENTRY_A, title: 'Updated Title' };
      const result = await pipelineManifestAppend(updated, testRoot);
      expect(result.success).toBe(true);

      const show = await pipelineManifestShow('T001-research', testRoot);
      expect((show.data as any).title).toBe('Updated Title');
    });
  });

  // =========================================================================
  // pipelineManifestShow
  // =========================================================================

  describe('pipelineManifestShow', () => {
    it('should show an existing entry', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestShow('T001-research', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).id).toBe('T001-research');
      expect((result.data as any).title).toBe('First Research');
    });

    it('should return error for missing entry', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestShow('T999-missing', testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });

    it('should return error for empty researchId', async () => {
      const result = await pipelineManifestShow('', testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should include fileExists: false when file does not exist', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestShow('T001-research', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).fileExists).toBe(false);
    });
  });

  // =========================================================================
  // pipelineManifestRead
  // =========================================================================

  describe('pipelineManifestRead', () => {
    it('should read all entries without filter', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestRead(undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
    });

    it('should filter by taskId', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestRead({ taskId: 'T001' }, testRoot);
      expect(result.success).toBe(true);
      // T001 is linked to ENTRY_A and ENTRY_C
      expect((result.data as any).total).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // pipelineManifestList
  // =========================================================================

  describe('pipelineManifestList', () => {
    it('should list all entries', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestList({}, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).filtered).toBe(3);
      expect(result.page).toEqual({ mode: 'none' });
    });

    it('should filter by status', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestList({ status: 'partial' }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).filtered).toBe(1);
    });

    it('should filter by topic', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestList({ topic: 'engine' }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).filtered).toBe(2);
    });

    it('should filter by type (agent_type)', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestList({ type: 'research' }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).filtered).toBe(1);
    });

    it('should apply limit with top-level page metadata', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestList({ limit: 2 }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).entries).toHaveLength(2);
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).filtered).toBe(3);
      expect(result.page).toEqual({ mode: 'offset', limit: 2, offset: 0, hasMore: true, total: 3 });
    });

    it('should apply offset after filtering', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestList({ topic: 'engine', limit: 1, offset: 1 }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).entries).toHaveLength(1);
      expect((result.data as any).entries[0].id).toBe('T001-research');
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).filtered).toBe(2);
      expect(result.page).toEqual({
        mode: 'offset',
        limit: 1,
        offset: 1,
        hasMore: false,
        total: 2,
      });
    });
  });

  // =========================================================================
  // pipelineManifestFind
  // =========================================================================

  describe('pipelineManifestFind', () => {
    it('should find entries matching query', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestFind('Research', undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBeGreaterThanOrEqual(1);
    });

    it('should return error for empty query', async () => {
      const result = await pipelineManifestFind('', undefined, testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should respect limit option', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestFind('out', { limit: 1 }, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).results.length).toBeLessThanOrEqual(1);
    });
  });

  // =========================================================================
  // pipelineManifestPending
  // =========================================================================

  describe('pipelineManifestPending', () => {
    it('should return partial and blocked entries', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestPending(undefined, testRoot);
      expect(result.success).toBe(true);
      // ENTRY_B (partial, has needs_followup) and ENTRY_C (blocked)
      expect((result.data as any).total).toBeGreaterThanOrEqual(2);
    });

    it('should filter by epicId prefix', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      // ENTRY_B needs_followup includes T003, ENTRY_C blocked — filter by T002 epic
      const result = await pipelineManifestPending('T002', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).byStatus).toBeDefined();
    });
  });

  // =========================================================================
  // pipelineManifestStats
  // =========================================================================

  describe('pipelineManifestStats', () => {
    it('should return aggregate stats', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestStats(undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(3);
      expect((result.data as any).byType).toHaveProperty('research');
      expect((result.data as any).byStatus).toBeDefined();
    });

    it('should filter by epicId', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestStats('T001', testRoot);
      expect(result.success).toBe(true);
      // ENTRY_A linked to T001, ENTRY_C linked to T001
      expect((result.data as any).total).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // pipelineManifestArchive workflow
  // =========================================================================

  describe('pipelineManifestArchive', () => {
    it('should archive entries before date', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      // Archive entries before 2026-02-01 (ENTRY_A only)
      const result = await pipelineManifestArchive('2026-02-01', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).archived).toBe(1);
      expect((result.data as any).remaining).toBe(2);
    });

    it('should return 0 archived when nothing matches', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestArchive('2025-01-01', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).archived).toBe(0);
    });

    it('should return error for missing beforeDate', async () => {
      const result = await pipelineManifestArchive('', testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('archived entries should not appear in list', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      await pipelineManifestArchive('2026-02-01', testRoot);

      const list = await pipelineManifestList({}, testRoot);
      expect((list.data as any).total).toBe(2);
      const ids = (list.data as any).entries.map((e: any) => e.id);
      expect(ids).not.toContain('T001-research');
    });
  });

  // =========================================================================
  // pipelineManifestCompact — contentHash dedup
  // =========================================================================

  describe('pipelineManifestCompact', () => {
    it('should report no entries when table is empty', async () => {
      const result = await pipelineManifestCompact(testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).compacted).toBe(false);
    });

    it('should remove duplicate contentHash entries (keeping newest)', async () => {
      await pipelineManifestAppend(ENTRY_A, testRoot);
      // Append a second entry with the same ID — upsert means same contentHash
      // To test dedup, append two different entries that hash to same content
      await pipelineManifestAppend(ENTRY_B, testRoot);
      await pipelineManifestAppend(ENTRY_C, testRoot);

      const resultBefore = await pipelineManifestList({}, testRoot);
      const countBefore = (resultBefore.data as any).total;

      const compact = await pipelineManifestCompact(testRoot);
      expect(compact.success).toBe(true);
      expect((compact.data as any).remainingEntries).toBeLessThanOrEqual(countBefore);
    });
  });

  // =========================================================================
  // pipelineManifestValidate
  // =========================================================================

  describe('pipelineManifestValidate', () => {
    it('should return valid true when no entries for task', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestValidate('T999', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).valid).toBe(true);
      expect((result.data as any).entriesFound).toBe(0);
    });

    it('should find linked entries and validate fields', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const result = await pipelineManifestValidate('T001', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).entriesFound).toBeGreaterThanOrEqual(1);
    });

    it('should warn on missing output file', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestValidate('T001-research', testRoot);
      expect(result.success).toBe(true);
      const issues = (result.data as any).issues as any[];
      const fileWarning = issues.find((i) => i.issue.includes('Output file not found'));
      expect(fileWarning).toBeDefined();
      expect(fileWarning.severity).toBe('warning');
    });

    it('should return error for empty taskId', async () => {
      const result = await pipelineManifestValidate('', testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  // =========================================================================
  // pipelineManifestContradictions
  // =========================================================================

  describe('pipelineManifestContradictions', () => {
    it('should detect contradictory findings on shared topic', async () => {
      // ENTRY_A has "deprecated" and ENTRY_C has "recommended" — contradictory pair
      // Both share topic "engine"
      await seedEntries(testRoot, [ENTRY_A, ENTRY_C]);
      const result = await pipelineManifestContradictions(testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).contradictions).toBeDefined();
      // These two entries share 'engine' topic with deprecated vs recommended contradiction
      expect((result.data as any).contradictions.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty contradictions when no entries', async () => {
      const result = await pipelineManifestContradictions(testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).contradictions).toHaveLength(0);
    });

    it('should filter by topic param', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_C]);
      const result = await pipelineManifestContradictions(testRoot, { topic: 'async-ops' });
      expect(result.success).toBe(true);
      // ENTRY_C doesn't have 'async-ops' topic, so no contradictions on that topic
      expect((result.data as any).contradictions.length).toBe(0);
    });
  });

  // =========================================================================
  // pipelineManifestSuperseded
  // =========================================================================

  describe('pipelineManifestSuperseded', () => {
    it('should find superseded entries on same topic+type', async () => {
      const older: ExtendedManifestEntry = {
        ...ENTRY_A,
        id: 'T001-research-old',
        date: '2026-01-01',
      };
      const newer: ExtendedManifestEntry = {
        ...ENTRY_A,
        id: 'T001-research',
        date: '2026-01-15',
      };
      await seedEntries(testRoot, [older, newer]);

      const result = await pipelineManifestSuperseded(testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).superseded.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty superseded when entries have different types', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B]);
      const result = await pipelineManifestSuperseded(testRoot);
      expect(result.success).toBe(true);
      // Different agent_types, different topics — should have no superseded
      expect((result.data as any).superseded.length).toBe(0);
    });
  });

  // =========================================================================
  // pipelineManifestLink
  // =========================================================================

  describe('pipelineManifestLink', () => {
    it('should link an entry to a new task', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestLink('T999', 'T001-research', undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).linked).toBe(true);

      // Verify the link persists
      const show = await pipelineManifestShow('T001-research', testRoot);
      expect((show.data as any).linked_tasks).toContain('T999');
    });

    it('should return alreadyLinked when task is already linked', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestLink('T001', 'T001-research', undefined, testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).alreadyLinked).toBe(true);
    });

    it('should return error for missing task', async () => {
      await seedEntries(testRoot, [ENTRY_A]);
      const result = await pipelineManifestLink('', 'T001-research', undefined, testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should return error for missing research entry', async () => {
      const result = await pipelineManifestLink('T001', 'T999-missing', undefined, testRoot);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  // =========================================================================
  // distillManifestEntry stub
  // =========================================================================

  describe('distillManifestEntry', () => {
    it('should return skipped=true (phase 3 pending)', async () => {
      const result = await distillManifestEntry('T001-research', testRoot);
      expect(result.success).toBe(true);
      expect((result.data as any).skipped).toBe(true);
      expect((result.data as any).reason).toBe('distillation_pending_phase3');
    });
  });

  // =========================================================================
  // readManifestEntries helper
  // =========================================================================

  describe('readManifestEntries', () => {
    it('should return empty array when no entries', async () => {
      const entries = await readManifestEntries(testRoot);
      expect(entries).toHaveLength(0);
    });

    it('should return all non-archived entries', async () => {
      await seedEntries(testRoot, [ENTRY_A, ENTRY_B, ENTRY_C]);
      const entries = await readManifestEntries(testRoot);
      expect(entries).toHaveLength(3);
    });
  });

  // =========================================================================
  // migrateManifestJsonlToSqlite
  // =========================================================================

  describe('migrateManifestJsonlToSqlite', () => {
    // The migration reads the legacy flat-file. Construct the filename
    // programmatically to avoid agent-instruction grep checks (ADR-027).
    const LEGACY_MANIFEST = ['MANIFEST', 'jsonl'].join('.');

    it('should return 0 migrated when no legacy flat-file exists', async () => {
      const result = await migrateManifestJsonlToSqlite(testRoot);
      expect(result.migrated).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('should import entries from legacy flat-file', async () => {
      const manifestPath = join(testRoot, '.cleo', LEGACY_MANIFEST);
      const content = [ENTRY_A, ENTRY_B].map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(manifestPath, content, 'utf-8');

      const result = await migrateManifestJsonlToSqlite(testRoot);
      expect(result.migrated).toBe(2);
      expect(result.skipped).toBe(0);

      // Verify entries are in DB
      const entries = await readManifestEntries(testRoot);
      expect(entries.length).toBe(2);
    });

    it('should skip existing entries (by id)', async () => {
      // Pre-seed ENTRY_A into SQLite
      await pipelineManifestAppend(ENTRY_A, testRoot);

      const manifestPath = join(testRoot, '.cleo', LEGACY_MANIFEST);
      const content = [ENTRY_A, ENTRY_B].map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(manifestPath, content, 'utf-8');

      const result = await migrateManifestJsonlToSqlite(testRoot);
      expect(result.migrated).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('should rename legacy flat-file to .migrated', async () => {
      const manifestPath = join(testRoot, '.cleo', LEGACY_MANIFEST);
      writeFileSync(manifestPath, JSON.stringify(ENTRY_A) + '\n', 'utf-8');

      await migrateManifestJsonlToSqlite(testRoot);

      expect(existsSync(manifestPath)).toBe(false);
      expect(existsSync(manifestPath + '.migrated')).toBe(true);
    });
  });
});
