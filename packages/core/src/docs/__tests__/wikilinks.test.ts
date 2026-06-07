/**
 * T11826 — `docs_wikilinks` derived edge table + bidirectional query, and
 * T11825 — `docs.read` core-SDK API (body + frontmatter + base64 blobs).
 *
 * Two suites:
 *   1. Pure derivation unit tests for {@link deriveWikilinkEdges} — no DB.
 *   2. End-to-end tests against a real temp project root exercising the live
 *      migration (table creation), {@link rebuildDocsWikilinks},
 *      {@link getDocsWikilinks} (bidirectional), and {@link readDoc}.
 *
 * @task T11826 · T11825
 * @epic T11781
 * @saga T11778
 */

import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { closeDb, getDb } from '../../store/sqlite.js';
import { attachments } from '../../store/tasks-schema.js';
import { DocNotFoundError, readDoc } from '../read-doc.js';
import { deriveWikilinkEdges, getDocsWikilinks, rebuildDocsWikilinks } from '../wikilinks.js';

describe('T11826 — deriveWikilinkEdges (pure)', () => {
  it('derives supersedes + superseded-by doc→doc edges', () => {
    const edges = deriveWikilinkEdges([
      {
        slug: 'adr-002',
        supersedesSlug: 'adr-001',
        supersededBySlug: null,
        relatedTasks: null,
        topics: null,
      },
      {
        slug: 'adr-001',
        supersedesSlug: null,
        supersededBySlug: 'adr-002',
        relatedTasks: null,
        topics: null,
      },
    ]);
    expect(edges).toContainEqual({
      fromSlug: 'adr-002',
      toSlug: 'adr-001',
      relation: 'supersedes',
      toIsTask: false,
    });
    expect(edges).toContainEqual({
      fromSlug: 'adr-001',
      toSlug: 'adr-002',
      relation: 'superseded-by',
      toIsTask: false,
    });
  });

  it('derives related-task edges from the JSON array and marks toIsTask', () => {
    const edges = deriveWikilinkEdges([
      {
        slug: 'spec-foo',
        supersedesSlug: null,
        supersededBySlug: null,
        relatedTasks: JSON.stringify(['T100', 'T200', 'not-a-task']),
        topics: null,
      },
    ]);
    const taskEdges = edges.filter((e) => e.relation === 'related-task');
    expect(taskEdges).toHaveLength(2);
    expect(taskEdges.every((e) => e.toIsTask)).toBe(true);
    expect(taskEdges.map((e) => e.toSlug).sort()).toEqual(['T100', 'T200']);
  });

  it('derives symmetric topic edges between co-members of a topic', () => {
    const edges = deriveWikilinkEdges([
      {
        slug: 'doc-a',
        supersedesSlug: null,
        supersededBySlug: null,
        relatedTasks: null,
        topics: JSON.stringify(['vault']),
      },
      {
        slug: 'doc-b',
        supersedesSlug: null,
        supersededBySlug: null,
        relatedTasks: null,
        topics: JSON.stringify(['vault']),
      },
    ]);
    const topicEdges = edges.filter((e) => e.relation === 'topic');
    // Symmetric: a→b and b→a.
    expect(topicEdges).toContainEqual({
      fromSlug: 'doc-a',
      toSlug: 'doc-b',
      relation: 'topic',
      toIsTask: false,
    });
    expect(topicEdges).toContainEqual({
      fromSlug: 'doc-b',
      toSlug: 'doc-a',
      relation: 'topic',
      toIsTask: false,
    });
  });

  it('tolerates malformed JSON and dedupes', () => {
    const edges = deriveWikilinkEdges([
      {
        slug: 'doc-x',
        supersedesSlug: 'doc-y',
        supersededBySlug: null,
        relatedTasks: '{not json',
        topics: 'also not json',
      },
      // Duplicate supersedes edge should be deduped.
      {
        slug: 'doc-x',
        supersedesSlug: 'doc-y',
        supersededBySlug: null,
        relatedTasks: null,
        topics: null,
      },
    ]);
    expect(edges.filter((e) => e.relation === 'supersedes')).toHaveLength(1);
  });
});

describe('T11826/T11825 — end-to-end (live DB + migration)', () => {
  let tmpRoot: string;
  let prevCwd: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'cleo-wikilinks-test-'));
    prevCwd = process.cwd();
    await mkdir(join(tmpRoot, '.cleo'), { recursive: true });
    await mkdir(join(tmpRoot, '.git'), { recursive: true });
    process.chdir(tmpRoot);
  });

  afterEach(async () => {
    closeDb();
    process.chdir(prevCwd);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function seedDoc(slug: string, body: string, mime = 'text/markdown'): Promise<string> {
    const store = createAttachmentStore();
    const result = await store.put(
      Buffer.from(body, 'utf8'),
      { kind: 'blob', mime } as Parameters<typeof store.put>[1],
      'task',
      'T11826',
      'wikilinks-test',
      tmpRoot,
      { slug, type: 'adr' },
    );
    return result.id;
  }

  it('creates docs_wikilinks via the live migration and derives bidirectional edges', async () => {
    const idOld = await seedDoc('adr-001', '# ADR 001\nold decision');
    const idNew = await seedDoc('adr-002', '# ADR 002\nnew decision');
    await seedDoc('note-alpha', '# Note Alpha');
    await seedDoc('note-beta', '# Note Beta');

    const db = await getDb(tmpRoot);
    // Wire a supersession edge + topic co-membership + a related task.
    await db
      .update(attachments)
      .set({ supersedes: idOld, supersededBy: null, relatedTasks: JSON.stringify(['T999']) })
      .where(eq(attachments.id, idNew))
      .run();
    await db
      .update(attachments)
      .set({ supersededBy: idNew })
      .where(eq(attachments.id, idOld))
      .run();
    await db
      .update(attachments)
      .set({ topics: JSON.stringify(['vault']) })
      .where(eq(attachments.slug, 'note-alpha'))
      .run();
    await db
      .update(attachments)
      .set({ topics: JSON.stringify(['vault']) })
      .where(eq(attachments.slug, 'note-beta'))
      .run();

    const result = await rebuildDocsWikilinks({ projectRoot: tmpRoot });
    expect(result.edgeCount).toBeGreaterThan(0);
    expect(result.byRelation.supersedes).toBe(1);
    expect(result.byRelation['superseded-by']).toBe(1);
    expect(result.byRelation['related-task']).toBe(1);
    expect(result.byRelation.topic).toBe(2); // symmetric

    // Bidirectional query: adr-001 is the target of a supersedes edge and the
    // source of a superseded-by edge.
    const adr001Edges = await getDocsWikilinks('adr-001', { projectRoot: tmpRoot });
    expect(adr001Edges).toContainEqual({
      fromSlug: 'adr-002',
      toSlug: 'adr-001',
      relation: 'supersedes',
      toIsTask: false,
    });
    expect(adr001Edges).toContainEqual({
      fromSlug: 'adr-001',
      toSlug: 'adr-002',
      relation: 'superseded-by',
      toIsTask: false,
    });

    // Direction filters.
    const outOnly = await getDocsWikilinks('adr-001', { direction: 'out', projectRoot: tmpRoot });
    expect(outOnly.every((e) => e.fromSlug === 'adr-001')).toBe(true);
    const inOnly = await getDocsWikilinks('adr-001', { direction: 'in', projectRoot: tmpRoot });
    expect(inOnly.every((e) => e.toSlug === 'adr-001')).toBe(true);
  });

  it('rebuild is idempotent — re-running converges to the same edge set', async () => {
    await seedDoc('doc-a', 'a', 'text/markdown');
    await seedDoc('doc-b', 'b', 'text/markdown');
    const db = await getDb(tmpRoot);
    await db
      .update(attachments)
      .set({ topics: JSON.stringify(['shared']) })
      .where(eq(attachments.slug, 'doc-a'))
      .run();
    await db
      .update(attachments)
      .set({ topics: JSON.stringify(['shared']) })
      .where(eq(attachments.slug, 'doc-b'))
      .run();

    const first = await rebuildDocsWikilinks({ projectRoot: tmpRoot });
    const second = await rebuildDocsWikilinks({ projectRoot: tmpRoot });
    expect(second.edgeCount).toBe(first.edgeCount);
    expect(second.byRelation).toEqual(first.byRelation);
  });

  it('readDoc returns body + full provenance frontmatter (T11825 AC1)', async () => {
    const idOld = await seedDoc('adr-010', '# old');
    const idNew = await seedDoc('adr-011', '# ADR 011\n\nbody text');
    const db = await getDb(tmpRoot);
    await db
      .update(attachments)
      .set({
        supersedes: idOld,
        topics: JSON.stringify(['governance']),
        relatedTasks: JSON.stringify(['T42']),
        ownerVersion: 'v2026.6.7',
      })
      .where(eq(attachments.id, idNew))
      .run();
    await db
      .update(attachments)
      .set({ supersededBy: idNew })
      .where(eq(attachments.id, idOld))
      .run();

    const doc = await readDoc('adr-011', { projectRoot: tmpRoot });
    expect(doc.frontmatter.slug).toBe('adr-011');
    expect(doc.frontmatter.kind).toBe('adr');
    expect(doc.frontmatter.docVersion).toBe(1);
    expect(doc.frontmatter.ownerVersion).toBe('v2026.6.7');
    expect(doc.frontmatter.supersedes).toBe('adr-010'); // FK resolved to slug
    expect(doc.frontmatter.topics).toEqual(['governance']);
    expect(doc.frontmatter.relatedTasks).toEqual(['T42']);
    expect(doc.body.encoding).toBe('utf-8');
    expect(doc.body.text).toContain('body text');
  });

  it('readDoc surfaces non-UTF-8 blobs as base64 (T11825 AC2)', async () => {
    // 0xFF 0xFE is an invalid UTF-8 sequence — must round-trip via base64.
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x42]);
    const store = createAttachmentStore();
    await store.put(
      binary,
      { kind: 'blob', mime: 'application/octet-stream' } as Parameters<typeof store.put>[1],
      'task',
      'T11826',
      'wikilinks-test',
      tmpRoot,
      { slug: 'blob-bin', type: 'note' },
    );
    const doc = await readDoc('blob-bin', { projectRoot: tmpRoot });
    expect(doc.body.encoding).toBe('base64');
    expect(doc.body.base64).toBeDefined();
    // Decoding the base64 recovers the original bytes.
    const decoded = Buffer.from(doc.body.base64 ?? '', 'base64');
    expect([...decoded]).toEqual([0xff, 0xfe, 0x00, 0x42]);
  });

  it('readDoc throws DocNotFoundError for an unknown slug', async () => {
    await expect(readDoc('nope-does-not-exist', { projectRoot: tmpRoot })).rejects.toBeInstanceOf(
      DocNotFoundError,
    );
  });
});
