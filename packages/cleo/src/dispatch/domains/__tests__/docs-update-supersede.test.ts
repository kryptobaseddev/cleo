/**
 * `docs update --status superseded --superseded-by` through dispatch (T14660).
 *
 * A supersession refusal carries its remedy as the envelope's structured
 * `fix`, and a supersession writes the docs audit entry the deprecated
 * `docs supersede` wrote, naming the successor.
 *
 * @task T14660
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCS_AUDIT_FILE } from '@cleocode/core/docs/docs-audit';
import { awaitBackgroundOps } from '@cleocode/core/store/background-ops';
import { closeAllDatabases } from '@cleocode/core/store/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsHandler } from '../docs.js';

let tempDir: string;

/** Add an inline doc through the dispatch handler. */
async function add(slug: string): Promise<void> {
  const response = await new DocsHandler().mutate('add', {
    ownerId: 'T14660',
    attachedBy: 'supersede-test',
    content: `# ${slug}\n\nBody.\n`,
    slug,
  });
  expect(response.success, JSON.stringify(response.error)).toBe(true);
}

/** The summaries of the docs audit entries for `slug`. */
async function auditSummaries(slug: string): Promise<string[]> {
  const raw = await readFile(join(tempDir, DOCS_AUDIT_FILE), 'utf-8');
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { op: string; slug?: string; summary: string })
    .filter((entry) => entry.slug === slug)
    .map((entry) => `${entry.op}: ${entry.summary}`);
}

describe('docs.update --superseded-by through dispatch (T14660)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-update-supersede-'));
    vi.stubEnv('CLEO_ROOT', tempDir);
    vi.stubEnv('CLEO_DIR', join(tempDir, '.cleo'));
    vi.stubEnv('CLEO_BRAIN_BYPASS_WRITER_THREAD', '1');
    await mkdir(join(tempDir, '.cleo'));
    await writeFile(
      join(tempDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'supersede-test', projectRoot: tempDir }),
    );
  });

  afterEach(async () => {
    await awaitBackgroundOps();
    const { shutdownBrainWriter, _resetBrainWriterForTests } = await import(
      '@cleocode/core/memory/brain-writer-thread'
    );
    await shutdownBrainWriter();
    _resetBrainWriterForTests();
    await closeAllDatabases();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('refusals carry a structured fix; a supersession audits its successor', async () => {
    await add('retired-note');
    await add('successor-note');

    // No --status: refused with the full supersession command, not the
    // generic "--status accepted" prose.
    const bare = await new DocsHandler().mutate('update', {
      slug: 'retired-note',
      supersededBy: 'successor-note',
    });
    expect(bare.success).toBe(false);
    expect(bare.error?.fix).toBe(
      'cleo docs update retired-note --status superseded --superseded-by successor-note',
    );

    const refusals = [
      { status: 'accepted', supersededBy: 'successor-note' },
      { status: 'superseded', supersededBy: 'missing-note' },
      { status: 'superseded', supersededBy: 'retired-note' },
    ];
    for (const params of refusals) {
      const response = await new DocsHandler().mutate('update', {
        slug: 'retired-note',
        ...params,
      });
      expect(response.success, JSON.stringify(params)).toBe(false);
      expect(response.error?.fix, JSON.stringify(response.error)).toMatch(
        /^cleo docs (update|add) /,
      );
    }

    const updated = await new DocsHandler().mutate('update', {
      slug: 'retired-note',
      status: 'superseded',
      supersededBy: 'successor-note',
    });
    expect(updated.success, JSON.stringify(updated.error)).toBe(true);
    expect(await auditSummaries('retired-note')).toContain(
      "docs.update: Superseded 'retired-note' → 'successor-note'",
    );

    // A superseded doc refuses another status with the same structured fix.
    const reopened = await new DocsHandler().mutate('update', {
      slug: 'retired-note',
      status: 'accepted',
    });
    expect(reopened.success).toBe(false);
    expect(reopened.error?.fix).toBe(
      'cleo docs update retired-note --status superseded --superseded-by NEW_SLUG',
    );
  });
});
