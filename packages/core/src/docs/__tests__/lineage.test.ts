/**
 * T14110 — a doc's lineage: what it serves, what it replaced, what replaced
 * it, and the current doc at the end of its supersession chain. `docs fetch`
 * carries it, so a superseded doc points at the doc to read instead.
 *
 * @task T14110
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobAttachment } from '@cleocode/contracts';
import type { SearchBrainCompactResult } from '@cleocode/contracts/memory/search.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { closeDb } from '../../store/sqlite.js';
import { createDocsReadModel } from '../docs-read-model.js';
import { buildDocsFetchResult } from '../fetch-result.js';
import {
  attachCurrentDocs,
  currentDocsForTask,
  readDocLineage,
  supersededDecisionsOf,
} from '../lineage.js';
import { supersedeDoc } from '../supersede.js';

describe('T14110 — doc lineage', () => {
  let projectRoot: string;
  let prevCleoDir: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-lineage-'));
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

  async function seed(slug: string, body: string, owner: string): Promise<void> {
    const bytes = Buffer.from(body, 'utf-8');
    const blob: Omit<BlobAttachment, 'sha256'> = {
      kind: 'blob',
      storageKey: '',
      mime: 'text/markdown',
      size: bytes.byteLength,
    };
    await createAttachmentStore().put(bytes, blob, 'task', owner, 'test', projectRoot, {
      slug,
      type: 'plan',
    });
  }

  it('follows a supersession chain to the current doc and lists the tasks served', async () => {
    await seed('plan-draft', '# Draft\n\nfor T100\n', 'T100');
    await seed('plan-revised', '# Revised\n', 'T100');
    await seed('plan', '# Plan\n\nalso serves T200\n', 'T100');
    await supersedeDoc(projectRoot, { oldSlug: 'plan-draft', newSlug: 'plan-revised' });
    await supersedeDoc(projectRoot, { oldSlug: 'plan-revised', newSlug: 'plan' });

    expect(await readDocLineage(projectRoot, 'plan-draft')).toEqual({
      lifecycleStatus: 'superseded',
      supersedes: null,
      supersededBy: 'plan-revised',
      currentSlug: 'plan',
      servesTasks: ['T100'],
    });
    expect(await readDocLineage(projectRoot, 'plan')).toMatchObject({
      supersedes: 'plan-revised',
      supersededBy: null,
      currentSlug: 'plan',
      servesTasks: ['T100', 'T200'],
    });
    expect(await readDocLineage(projectRoot, 'no-such-doc')).toBeNull();
  });

  it('docs fetch of a superseded doc points at the current doc', async () => {
    await seed('old-guide', '# Old guide\n', 'T300');
    await seed('guide', '# Guide\n', 'T300');
    await supersedeDoc(projectRoot, { oldSlug: 'old-guide', newSlug: 'guide' });

    const model = createDocsReadModel(projectRoot);
    const doc = await model.resolveLatest('old-guide');
    expect(doc).not.toBeNull();
    if (!doc) return;
    const fetched = await buildDocsFetchResult({ doc, content: '# Old guide\n', projectRoot });
    expect(fetched.lineage).toMatchObject({
      lifecycleStatus: 'superseded',
      supersededBy: 'guide',
      currentSlug: 'guide',
    });
  });

  it('memory search attaches current docs for decisions and named tasks, never superseded ones', async () => {
    await seed('old-guide', '# Old guide\n', 'T300');
    await seed('guide', '# Guide\n', 'T300');
    await supersedeDoc(projectRoot, { oldSlug: 'old-guide', newSlug: 'guide' });
    const { storeDecision } = await import('../../memory/decisions.js');
    const decision = await storeDecision(projectRoot, {
      type: 'technical',
      decision: 'Guides live under docs/guide',
      rationale: 'One home per kind keeps docs findable.',
      confidence: 'high',
      confirmationState: 'accepted',
    });
    const { linkDecisionToAdr } = await import('../../store/decision-adr-links.js');
    await linkDecisionToAdr(projectRoot, { decisionId: decision.id, adrSlug: 'old-guide' });

    expect(await currentDocsForTask(projectRoot, 'T300')).toEqual(['guide']);
    const result: SearchBrainCompactResult = {
      results: [{ id: decision.id, type: 'decision', title: 'Guides', date: '2026-10-29' }],
      total: 1,
      tokensEstimated: 10,
    };
    await attachCurrentDocs(projectRoot, 'guides for T300', result);
    expect(result.results[0]?.docs).toEqual(['guide']);
    expect(result.taskDocs).toEqual([{ taskId: 'T300', docs: ['guide'] }]);
  });

  it('derives the decisions a doc supersedes from its linked decisions', async () => {
    const { storeDecision } = await import('../../memory/decisions.js');
    const older = await storeDecision(projectRoot, {
      type: 'technical',
      decision: 'Plans live under docs/plans',
      rationale: 'The first layout.',
      confidence: 'medium',
      confirmationState: 'accepted',
    });
    const newer = await storeDecision(projectRoot, {
      type: 'technical',
      decision: 'Plans live under docs/plan',
      rationale: 'Singular kind folders (T14107).',
      confidence: 'high',
      confirmationState: 'accepted',
      supersedes: older.id,
    });
    expect(await supersededDecisionsOf(projectRoot, [newer.id])).toEqual([older.id]);
  });
});
