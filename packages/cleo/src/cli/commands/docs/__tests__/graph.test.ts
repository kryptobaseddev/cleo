/**
 * Tests for the `cleo docs graph --root` verb + the underlying
 * `buildDocProvenanceGraph` core function (T10164).
 *
 * Covers:
 *   1. CLI command surface — exported with the correct meta + args.
 *   2. Single doc with no relations → 1 node, 0 edges.
 *   3. Doc that supersedes 2 others → 3 nodes, 2 edges.
 *   4. depth=1 traversal bound.
 *   5. depth=0 returns the root alone.
 *   6. DOT format output emits valid Graphviz syntax.
 *   7. Unknown root throws DocProvenanceRootNotFoundError.
 *   8. Negative depth throws TypeError before any DB access.
 *
 * Each DB-touching test uses an isolated `CLEO_DIR` tmp dir + closes the
 * tasks.db singleton in beforeEach so AttachmentStore writes go to a fresh
 * SQLite file. Mirrors the pattern in
 * packages/core/src/store/__tests__/attachment-store.test.ts.
 *
 * @task T10164
 * @epic T10157
 * @saga T9855
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDocProvenanceGraph,
  DocProvenanceRootNotFoundError,
  renderProvenanceGraphAsDot,
} from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { graphCommand } from '../graph.js';

// ─── CLI surface (no DB needed) ─────────────────────────────────────────────

describe('graphCommand (T10164) — CLI surface', () => {
  it('exports a defineCommand with name "graph"', () => {
    expect(graphCommand).toBeDefined();
    expect(graphCommand.meta).toBeDefined();
    const meta = graphCommand.meta as { name?: string; description?: string };
    expect(meta.name).toBe('graph');
    expect(meta.description).toContain('provenance graph');
  });

  it('declares required --root + optional --depth + --format args', () => {
    const args = graphCommand.args as Record<
      string,
      { type: string; required?: boolean; description?: string }
    >;
    expect(args['root']).toBeDefined();
    expect(args['root']?.type).toBe('string');
    expect(args['root']?.required).toBe(true);
    expect(args['depth']).toBeDefined();
    expect(args['depth']?.type).toBe('string');
    expect(args['depth']?.required).not.toBe(true);
    expect(args['format']).toBeDefined();
    expect(args['format']?.type).toBe('string');
  });
});

// ─── DOT rendering (no DB needed) ────────────────────────────────────────────

describe('renderProvenanceGraphAsDot (T10164) — pure rendering', () => {
  it('renders an empty graph as a syntactically valid digraph', () => {
    const dot = renderProvenanceGraphAsDot({
      nodes: [],
      edges: [],
      totalNodes: 0,
      totalEdges: 0,
    });
    expect(dot.startsWith('digraph DocProvenance {')).toBe(true);
    expect(dot.endsWith('}')).toBe(true);
    expect(dot).toContain('rankdir=LR');
  });

  it('renders nodes + edges with kind-prefixed IDs and quoted labels', () => {
    const dot = renderProvenanceGraphAsDot({
      nodes: [
        {
          kind: 'doc',
          id: 'adr-001',
          slug: 'adr-001',
          docKind: 'adr',
          title: 'Adopt X',
          lifecycleStatus: 'active',
          publishedAt: '2026-05-01T00:00:00.000Z',
        },
        {
          kind: 'task',
          id: 'T1234',
          title: 'T1234',
          taskType: 'task',
          status: 'pending',
        },
      ],
      edges: [
        {
          relation: 'attached-to',
          from: 'adr-001',
          fromKind: 'doc',
          to: 'T1234',
          toKind: 'task',
          addedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
      totalNodes: 2,
      totalEdges: 1,
    });

    // Disambiguated kind:id node IDs so two entities with the same string ID
    // (rare but legal) never collide in the DOT graph.
    expect(dot).toContain('"doc:adr-001"');
    expect(dot).toContain('"task:T1234"');
    expect(dot).toContain('-> "task:T1234"');
    expect(dot).toContain('[label="attached-to"]');
    // Labels carry the doc kind in upper-case + lifecycle status.
    expect(dot).toContain('ADR: Adopt X (active)');
  });

  it('escapes embedded double-quotes in titles', () => {
    const dot = renderProvenanceGraphAsDot({
      nodes: [
        {
          kind: 'doc',
          id: 'a',
          slug: 'a',
          docKind: 'note',
          title: 'Has "quotes" in it',
          lifecycleStatus: 'draft',
          publishedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
      edges: [],
      totalNodes: 1,
      totalEdges: 0,
    });
    expect(dot).toContain('\\"quotes\\"');
  });
});

// ─── Graph traversal (real tasks.db) ─────────────────────────────────────────

interface TestDocSpec {
  readonly slug: string;
  readonly type: string;
  readonly ownerTaskId: string;
}

let tempDir: string;

async function seedDoc(spec: TestDocSpec, content: string): Promise<{ attachmentId: string }> {
  const { createAttachmentStore } = await import('@cleocode/core/internal');
  const store = createAttachmentStore();
  const bytes = Buffer.from(content, 'utf-8');
  const meta = await store.put(
    bytes,
    {
      kind: 'blob',
      storageKey: '',
      mime: 'text/markdown',
      size: bytes.length,
    },
    'task',
    spec.ownerTaskId,
    'test',
    undefined,
    { slug: spec.slug, type: spec.type },
  );
  return { attachmentId: meta.id };
}

/**
 * Write provenance fields directly via drizzle. The AttachmentStore.put API
 * does not yet surface a typed setter for the T10158 provenance columns
 * (those ship via the T10161/T10162 update/supersede verbs). Tests use the
 * drizzle update API so parameter binding stays safe.
 */
async function setProvenance(
  attachmentId: string,
  fields: Partial<{
    supersedes: string;
    supersededBy: string;
    relatedTasks: readonly string[];
    summary: string;
    lifecycleStatus: string;
  }>,
): Promise<void> {
  const { getDb, attachments } = await import('@cleocode/core/internal');
  const { eq } = await import('drizzle-orm');
  const db = await getDb();
  const update: Record<string, unknown> = {};
  if (fields.supersedes !== undefined) update['supersedes'] = fields.supersedes;
  if (fields.supersededBy !== undefined) update['supersededBy'] = fields.supersededBy;
  if (fields.relatedTasks !== undefined)
    update['relatedTasks'] = JSON.stringify(fields.relatedTasks);
  if (fields.summary !== undefined) update['summary'] = fields.summary;
  if (fields.lifecycleStatus !== undefined) update['lifecycleStatus'] = fields.lifecycleStatus;
  await db.update(attachments).set(update).where(eq(attachments.id, attachmentId));
}

describe('buildDocProvenanceGraph (T10164) — DB-backed traversal', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-graph-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
    const { closeDb } = await import('@cleocode/core/internal');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('@cleocode/core/internal');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('single doc with no lineage → 1 node, 0 supersession edges', async () => {
    await seedDoc({ slug: 'adr-loner', type: 'adr', ownerTaskId: 'T0001' }, '# loner\n');
    const graph = await buildDocProvenanceGraph({ root: 'adr-loner', depth: 2 });

    const docNodes = graph.nodes.filter((n) => n.kind === 'doc');
    expect(docNodes).toHaveLength(1);
    expect(docNodes[0]?.kind === 'doc' && docNodes[0].slug).toBe('adr-loner');

    const lineageEdges = graph.edges.filter(
      (e) => e.relation === 'supersedes' || e.relation === 'superseded-by',
    );
    expect(lineageEdges).toHaveLength(0);
    const attachedEdges = graph.edges.filter((e) => e.relation === 'attached-to');
    expect(attachedEdges).toHaveLength(1);
    expect(attachedEdges[0]?.to).toBe('T0001');

    expect(graph.totalNodes).toBe(graph.nodes.length);
    expect(graph.totalEdges).toBe(graph.edges.length);
  });

  it('doc that supersedes 2 priors → 3 doc nodes + 2 supersedes edges', async () => {
    // Chain: newest → middle → oldest.
    const oldest = await seedDoc({ slug: 'adr-v1', type: 'adr', ownerTaskId: 'T1' }, '# v1\n');
    const middle = await seedDoc({ slug: 'adr-v2', type: 'adr', ownerTaskId: 'T2' }, '# v2\n');
    const newest = await seedDoc({ slug: 'adr-v3', type: 'adr', ownerTaskId: 'T3' }, '# v3\n');

    await setProvenance(middle.attachmentId, {
      supersedes: oldest.attachmentId,
      supersededBy: newest.attachmentId,
    });
    await setProvenance(oldest.attachmentId, { supersededBy: middle.attachmentId });
    await setProvenance(newest.attachmentId, { supersedes: middle.attachmentId });

    const graph = await buildDocProvenanceGraph({ root: 'adr-v3', depth: 5 });

    const docNodes = graph.nodes.filter((n) => n.kind === 'doc');
    const slugs = new Set(docNodes.map((n) => (n.kind === 'doc' ? n.slug : '')));
    expect(slugs.has('adr-v1')).toBe(true);
    expect(slugs.has('adr-v2')).toBe(true);
    expect(slugs.has('adr-v3')).toBe(true);

    const supersedeEdges = graph.edges.filter((e) => e.relation === 'supersedes');
    expect(supersedeEdges.length).toBeGreaterThanOrEqual(2);
    for (const e of supersedeEdges) {
      expect(e.fromKind).toBe('doc');
      expect(e.toKind).toBe('doc');
    }
  });

  it('depth=1 from root bounds traversal to direct neighbors only', async () => {
    const oldest = await seedDoc({ slug: 'adr-d1', type: 'adr', ownerTaskId: 'T10' }, '# d1\n');
    const middle = await seedDoc({ slug: 'adr-d2', type: 'adr', ownerTaskId: 'T11' }, '# d2\n');
    const newest = await seedDoc({ slug: 'adr-d3', type: 'adr', ownerTaskId: 'T12' }, '# d3\n');

    await setProvenance(middle.attachmentId, {
      supersedes: oldest.attachmentId,
      supersededBy: newest.attachmentId,
    });
    await setProvenance(oldest.attachmentId, { supersededBy: middle.attachmentId });
    await setProvenance(newest.attachmentId, { supersedes: middle.attachmentId });

    const graph = await buildDocProvenanceGraph({ root: 'adr-d3', depth: 1 });
    const docSlugs = new Set(
      graph.nodes.filter((n) => n.kind === 'doc').map((n) => (n.kind === 'doc' ? n.slug : '')),
    );
    expect(docSlugs.has('adr-d3')).toBe(true);
    expect(docSlugs.has('adr-d2')).toBe(true);
    expect(docSlugs.has('adr-d1')).toBe(false);
  });

  it('depth=0 returns the root alone (no neighbor expansion)', async () => {
    const oldest = await seedDoc({ slug: 'adr-z1', type: 'adr', ownerTaskId: 'T20' }, '# z1\n');
    const newest = await seedDoc({ slug: 'adr-z2', type: 'adr', ownerTaskId: 'T21' }, '# z2\n');
    await setProvenance(newest.attachmentId, { supersedes: oldest.attachmentId });
    await setProvenance(oldest.attachmentId, { supersededBy: newest.attachmentId });

    const graph = await buildDocProvenanceGraph({ root: 'adr-z2', depth: 0 });
    expect(graph.nodes.filter((n) => n.kind === 'doc')).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });

  it('unknown root → DocProvenanceRootNotFoundError', async () => {
    await expect(
      buildDocProvenanceGraph({ root: 'does-not-exist', depth: 1 }),
    ).rejects.toBeInstanceOf(DocProvenanceRootNotFoundError);
  });

  it('rejects negative depth before any DB access', async () => {
    await expect(buildDocProvenanceGraph({ root: 'whatever', depth: -1 })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('task-ID root resolves via attachment_refs', async () => {
    await seedDoc({ slug: 'note-anchored', type: 'note', ownerTaskId: 'T999' }, '# anchored\n');
    const graph = await buildDocProvenanceGraph({ root: 'T999', depth: 1 });
    const docNodes = graph.nodes.filter((n) => n.kind === 'doc');
    expect(docNodes).toHaveLength(1);
    expect(docNodes[0]?.kind === 'doc' && docNodes[0].slug).toBe('note-anchored');
  });
});
