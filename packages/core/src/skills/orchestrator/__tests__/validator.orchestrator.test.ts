/** Independent current-store and explicit historical-file validator oracles. */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BlobAttachment } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pipelineManifestAppend } from '../../../memory/pipeline-manifest-sqlite.js';
import { createTestDb, type TestDbEnv } from '../../../store/__tests__/test-db-helper.js';
import { bindTasksDomain } from '../../../store/sqlite.js';
import type { ManifestEntry } from '../../types.js';
import * as validator from '../validator.js';

let env: TestDbEnv;
let historicalPath: string;
const entry: ManifestEntry = {
  id: 'evidence-one',
  file: 'result.md',
  title: 'Task evidence',
  date: '2026-09-20',
  status: 'completed',
  agent_type: 'implementation',
  topics: ['validation'],
  key_findings: ['Changed exact artifact', 'Executed independent check', 'Retained result'],
  actionable: true,
  needs_followup: [],
  linked_tasks: ['T1'],
};
beforeEach(async () => {
  env = await createTestDb();
  historicalPath = join(env.tempDir, 'selected-history.jsonl');
  mkdirSync(join(env.cleoDir, 'agent-outputs'), { recursive: true });
  writeFileSync(join(env.cleoDir, 'agent-outputs', entry.file), 'Authentic historical output');
  writeFileSync(join(env.tempDir, entry.file), 'Authentic current output');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await env.cleanup();
});

function history(lines: string[] = [JSON.stringify(entry)]) {
  writeFileSync(historicalPath, lines.join('\n'));
}
async function current() {
  const { native } = await bindTasksDomain(env.tempDir);
  native.exec('PRAGMA foreign_keys=ON');
  expect(native.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  native
    .prepare(
      "INSERT INTO tasks_tasks(id,title,status,created_at,updated_at) VALUES ('T1','Worker','pending','2026-09-20','2026-09-20')",
    )
    .run();
  expect(
    await pipelineManifestAppend(
      { ...entry, status: 'completed', agent_type: 'implementation', linked_tasks: ['T1'] },
      env.tempDir,
    ),
  ).toMatchObject({ success: true });
  return native;
}

describe('explicit synchronous history', () => {
  it('does not claim absent retired defaults validate the current manifest', () => {
    expect(validator.validateManifestIntegrity(env.tempDir)).toMatchObject({
      exists: false,
      passed: false,
      issues: [expect.stringContaining('CURRENT_MANIFEST_REQUIRES_ASYNC')],
    });
    expect(validator.validateSubagentOutput(entry.id, env.tempDir)).toMatchObject({
      passed: false,
      issues: [expect.stringContaining('CURRENT_MANIFEST_REQUIRES_ASYNC')],
    });
    expect(validator.verifyCompliance('T1', undefined, env.tempDir)).toMatchObject({
      canSpawnNext: false,
      violations: [expect.stringContaining('CURRENT_MANIFEST_REQUIRES_ASYNC')],
    });
  });
  it('retains synchronous returns and validates only the explicitly selected history', () => {
    history();
    const result = validator.validateManifestIntegrity(env.tempDir, historicalPath);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toMatchObject({
      exists: true,
      passed: true,
      stats: { validEntries: 1, invalidEntries: 0 },
    });
    expect(validator.validateSubagentOutput(entry.id, env.tempDir, historicalPath).passed).toBe(
      true,
    );
    expect(
      validator.verifyCompliance('T1', undefined, env.tempDir, historicalPath).canSpawnNext,
    ).toBe(true);
  });
  it.each([
    '{',
    'null',
    '[]',
    JSON.stringify({ ...entry, topics: ['valid', 1] }),
  ])('does not skip invalid historical lines: %s', (invalid) => {
    history([JSON.stringify(entry), invalid]);
    expect(validator.validateManifestIntegrity(env.tempDir, historicalPath)).toMatchObject({
      passed: false,
      stats: { invalidEntries: 1 },
      issues: expect.arrayContaining([expect.stringContaining('LINE_2_INVALID')]),
    });
    expect(validator.validateSubagentOutput(entry.id, env.tempDir, historicalPath).passed).toBe(
      false,
    );
    expect(
      validator.verifyCompliance('T1', undefined, env.tempDir, historicalPath).canSpawnNext,
    ).toBe(false);
  });
  it('reports a missing explicitly selected file as failure', () => {
    expect(validator.validateManifestIntegrity(env.tempDir, historicalPath)).toMatchObject({
      exists: false,
      passed: false,
      issues: expect.arrayContaining([expect.stringContaining('ENOENT')]),
    });
  });
  it('rejects duplicate identities and missing output files', () => {
    history([JSON.stringify(entry), JSON.stringify({ ...entry, file: 'missing.md' })]);
    expect(validator.validateManifestIntegrity(env.tempDir, historicalPath)).toMatchObject({
      passed: false,
      issues: expect.arrayContaining([expect.stringContaining('DUPLICATE_ID')]),
    });
    history([JSON.stringify({ ...entry, file: 'missing.md' })]);
    expect(validator.validateSubagentOutput(entry.id, env.tempDir, historicalPath).passed).toBe(
      false,
    );
    expect(validator.validateManifestIntegrity(env.tempDir, historicalPath).passed).toBe(false);
    expect(
      validator.verifyCompliance('T1', undefined, env.tempDir, historicalPath).canSpawnNext,
    ).toBe(false);
  });
  it('refuses T1/T10 name-only and follow-up-only compliance matches', () => {
    history([
      JSON.stringify({ ...entry, id: 'T10-output', linked_tasks: ['T10'], needs_followup: ['T1'] }),
    ]);
    expect(validator.verifyCompliance('T1', undefined, env.tempDir, historicalPath)).toMatchObject({
      canSpawnNext: false,
      researchId: null,
    });
    expect(
      validator.verifyCompliance('T1', 'T10-output', env.tempDir, historicalPath),
    ).toMatchObject({ canSpawnNext: false, checks: { researchLinkedToTask: false } });
  });
});

describe('canonical asynchronous current validation', () => {
  it('validates actual modern evidence without any retired JSONL file', async () => {
    await current();
    await expect(
      validator.validateCurrentSubagentOutput(entry.id, env.tempDir),
    ).resolves.toMatchObject({ passed: true });
    await expect(validator.validateCurrentManifestIntegrity(env.tempDir)).resolves.toMatchObject({
      passed: true,
      exists: true,
      stats: { validEntries: 1 },
    });
    await expect(
      validator.verifyCurrentCompliance('T1', undefined, env.tempDir),
    ).resolves.toMatchObject({ canSpawnNext: true, researchId: entry.id });
    await expect(
      validator.verifyCurrentCompliance('T10', undefined, env.tempDir),
    ).resolves.toMatchObject({ canSpawnNext: false, researchId: null });
  });
  it('verifies a canonical docs reference and retains unavailable-content diagnostics', async () => {
    const native = await current();
    const { createAttachmentStore } = await import('../../../store/attachment-store.js');
    const { createDocsReadModel, DocsReadModel } = await import('../../../docs/docs-read-model.js');
    const { reserveSlug } = await import('../../../docs/slug-allocator.js');
    const content = 'Canonical Unicode evidence π | retained.\n';
    const slug = 'validator-authentic-document';
    expect(await reserveSlug('note', slug, { cwd: env.tempDir })).toMatchObject({ ok: true });
    vi.stubEnv('CLEO_STRICT_SLUG_ALLOCATOR', '1');
    const attachment: Omit<BlobAttachment, 'sha256'> = {
      kind: 'blob',
      mime: 'text/markdown',
      storageKey: 'pending',
      size: Buffer.byteLength(content),
    };
    await createAttachmentStore().put(
      content,
      attachment,
      'task',
      'T1',
      'validator-test',
      env.tempDir,
      { slug, type: 'note' },
    );
    const model = createDocsReadModel(env.tempDir);
    const doc = await model.resolveLatest(slug);
    expect(doc?.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    if (!doc) throw new Error('Canonical fixture document not found');
    expect(await model.fetchContent(doc)).toBe(content);
    native
      .prepare('UPDATE docs_pipeline_manifest SET metadata_json=? WHERE id=?')
      .run(JSON.stringify({ ...entry, file: `cleo://docs/${slug}` }), entry.id);
    await expect(
      validator.validateCurrentSubagentOutput(entry.id, env.tempDir),
    ).resolves.toMatchObject({ passed: true });
    vi.spyOn(DocsReadModel.prototype, 'fetchContent').mockResolvedValue(null);
    await expect(validator.validateCurrentManifestIntegrity(env.tempDir)).rejects.toMatchObject({
      code: 'E_MANIFEST_DOC_CONTENT_UNAVAILABLE',
      details: { entryId: entry.id },
    });
  });

  it('fails empty current evidence and missing actual outputs', async () => {
    await expect(validator.validateCurrentManifestIntegrity(env.tempDir)).resolves.toMatchObject({
      passed: false,
      issues: expect.arrayContaining([expect.stringContaining('MANIFEST_EMPTY')]),
    });
    const native = await current();
    native
      .prepare('UPDATE docs_pipeline_manifest SET metadata_json=? WHERE id=?')
      .run(JSON.stringify({ ...entry, file: 'missing.md' }), entry.id);
    await expect(
      validator.validateCurrentSubagentOutput(entry.id, env.tempDir),
    ).resolves.toMatchObject({ passed: false });
    await expect(validator.validateCurrentManifestIntegrity(env.tempDir)).resolves.toMatchObject({
      passed: false,
    });
    await expect(
      validator.verifyCurrentCompliance('T1', undefined, env.tempDir),
    ).resolves.toMatchObject({ canSpawnNext: false });
  });
  it('preserves malformed metadata and native store diagnostic failures', async () => {
    const native = await current();
    native
      .prepare('UPDATE docs_pipeline_manifest SET metadata_json=? WHERE id=?')
      .run('{', entry.id);
    await expect(validator.validateCurrentManifestIntegrity(env.tempDir)).rejects.toMatchObject({
      code: 'E_MANIFEST_METADATA_INVALID',
    });
    await expect(
      validator.verifyCurrentCompliance('T1', undefined, env.tempDir),
    ).rejects.toMatchObject({ code: 'E_MANIFEST_METADATA_INVALID' });
    native.exec('DROP TABLE docs_pipeline_manifest');
    await expect(
      validator.validateCurrentSubagentOutput(entry.id, env.tempDir),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('no such table') }),
    });
  });
  it('retains legacy provenance and rejects conflicting identities', async () => {
    const native = await current();
    native
      .prepare(
        'INSERT INTO pipeline_manifest(id,type,content,status,metadata_json,created_at) SELECT id,type,content,status,metadata_json,created_at FROM docs_pipeline_manifest',
      )
      .run();
    native.exec('DELETE FROM docs_pipeline_manifest');
    await expect(
      validator.validateCurrentSubagentOutput(entry.id, env.tempDir),
    ).resolves.toMatchObject({ passed: true });
    native
      .prepare(
        'INSERT INTO docs_pipeline_manifest(id,type,content,status,metadata_json,created_at) SELECT id,type,?,status,metadata_json,created_at FROM pipeline_manifest',
      )
      .run('Conflicting content');
    await expect(validator.validateCurrentManifestIntegrity(env.tempDir)).rejects.toMatchObject({
      code: 'E_MANIFEST_ID_CONFLICT',
    });
  });
  it('canonical orchestrator compliance rejects failed task access instead of skipping it', async () => {
    const native = await current();
    native.exec('DROP TABLE tasks_tasks');
    await expect(validator.validateOrchestratorCompliance('T0', env.tempDir)).rejects.toMatchObject(
      { cause: expect.objectContaining({ message: expect.stringContaining('tasks_tasks') }) },
    );
  });
  it('canonical orchestrator compliance rejects an unassessed missing epic', async () => {
    await current();
    await expect(
      validator.validateOrchestratorCompliance('T404', env.tempDir),
    ).resolves.toMatchObject({
      compliant: false,
      violations: expect.arrayContaining([expect.stringContaining('ORC_EPIC_NOT_FOUND')]),
    });
  });

  it('canonical orchestrator compliance distinguishes empty evidence from valid evidence', async () => {
    await expect(
      validator.validateOrchestratorCompliance(undefined, env.tempDir),
    ).resolves.toMatchObject({
      compliant: false,
      violations: expect.arrayContaining([expect.stringContaining('MANIFEST_EMPTY')]),
    });
    await current();
    await expect(
      validator.validateOrchestratorCompliance(undefined, env.tempDir),
    ).resolves.toMatchObject({ compliant: true });
  });
});
