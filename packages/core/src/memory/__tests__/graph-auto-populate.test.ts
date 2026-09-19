/**
 * Tests for T945 Stage A universal semantic graph hooks in
 * graph-auto-populate.ts.
 *
 * Covers:
 *   - ensureTaskNode creates a `task:T###` node
 *   - ensureTaskNode is idempotent on repeat calls
 *   - ensureLlmtxtNode creates `llmtxt:<sha>` + `embeds` edge
 *   - ensureMessageNode extracts T### refs from content and emits
 *     `discusses` edges
 *   - ensureCommitNode creates `commit:<sha>` + `touches_code` edge
 *   - All five new edge types (blocks, discusses, cites, embeds,
 *     touches_code) accept inserts via addGraphEdge
 *
 * @task T945
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force-pass-through the real modules so any leaked mocks from earlier shard
// files cannot pollute this integration test.
vi.mock('../../paths.js', async () => await vi.importActual('../../paths.js'));
vi.mock(
  '../../store/memory-sqlite.js',
  async () => await vi.importActual('../../store/memory-sqlite.js'),
);
vi.mock('../../config.js', async () => await vi.importActual('../../config.js'));

let tempDir: string;
let cleoDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-graph-autopop-'));
  cleoDir = join(tempDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
  // E6-L4 (T11524): point CLEO_HOME at a SEPARATE global dir, not the project
  // `.cleo`. The global nexus domain now consolidates into `<CLEO_HOME>/cleo.db`
  // (openDualScopeDb('global')) while the project brain/tasks domains use
  // `<CLEO_DIR>/cleo.db` (openDualScopeDb('project')). Pointing both at the same
  // dir collapses them onto ONE physical `cleo.db`, where the global consolidation
  // migration would re-create `brain_attention` (present in both scope schemas)
  // and throw "table already exists". Production always separates these dirs.
  const homeDir = join(tempDir, 'cleo-home');
  await mkdir(homeDir, { recursive: true });
  process.env['CLEO_HOME'] = homeDir;
  // Create project-info.json and register in nexus so resolveProjectByCwd validates.
  const { canonicalProjectId } = await import('../../nexus/identity.js');
  const { id: projectId } = await canonicalProjectId(tempDir);
  await writeFile(
    join(cleoDir, 'project-info.json'),
    JSON.stringify({
      $schema: './schemas/project-info.schema.json',
      schemaVersion: '1.0.0',
      projectId,
      projectHash: projectId,
      cleoVersion: 'test',
      lastUpdated: new Date().toISOString(),
    }),
  );
  const { registerProjectOnEncounter } = await import('../../paths.js');
  await registerProjectOnEncounter(tempDir, projectId);
  // Enable autoCapture so graph writes actually fire.
  await writeFile(join(cleoDir, 'config.json'), JSON.stringify({ brain: { autoCapture: true } }));
});

afterEach(async () => {
  const { closeBrainDb } = await import('../../store/memory-sqlite.js');
  closeBrainDb();
  delete process.env['CLEO_DIR'];
  delete process.env['CLEO_HOME'];
  await rm(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('ensureTaskNode', () => {
  it('creates a task:T### node at creation time', async () => {
    const { ensureTaskNode } = await import('../graph-auto-populate.js');
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    const { brainPageNodes } = await import('../../store/schema/memory-schema.js');

    await ensureTaskNode(tempDir, 'T945', 'Universal semantic graph', {
      status: 'pending',
      priority: 'high',
    });

    const db = await getBrainDb(tempDir);
    const nodes = await db.select().from(brainPageNodes);
    const taskNode = nodes.find((n) => n.id === 'task:T945');

    expect(taskNode).toBeDefined();
    expect(taskNode?.nodeType).toBe('task');
    expect(taskNode?.label).toContain('T945');
    expect(taskNode?.label).toContain('Universal semantic graph');
    expect(taskNode?.qualityScore).toBe(0.7);
  });

  it('is idempotent — calling twice does not create duplicate nodes', async () => {
    const { ensureTaskNode } = await import('../graph-auto-populate.js');
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    const { brainPageNodes } = await import('../../store/schema/memory-schema.js');

    await ensureTaskNode(tempDir, 'T100', 'First call');
    await ensureTaskNode(tempDir, 'T100', 'Second call');

    const db = await getBrainDb(tempDir);
    const nodes = await db.select().from(brainPageNodes);
    const matches = nodes.filter((n) => n.id === 'task:T100');

    expect(matches).toHaveLength(1);
    // Second call updates the label — upsert semantics.
    expect(matches[0]?.label).toContain('Second call');
  });
});

describe('ensureLlmtxtNode', () => {
  it('creates an llmtxt:<sha> node and an embeds edge from the owner', async () => {
    const { ensureLlmtxtNode } = await import('../graph-auto-populate.js');
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    const { brainPageEdges, brainPageNodes } = await import('../../store/schema/memory-schema.js');

    const sha = 'abcd1234ef567890abcd1234ef567890abcd1234ef567890abcd1234ef567890';
    await ensureLlmtxtNode(tempDir, sha, 'task:T945', 'design-spec.md');

    const db = await getBrainDb(tempDir);

    const nodes = await db.select().from(brainPageNodes);
    const blobNode = nodes.find((n) => n.id === `llmtxt:${sha}`);
    expect(blobNode).toBeDefined();
    expect(blobNode?.nodeType).toBe('llmtxt');
    expect(blobNode?.label).toBe('design-spec.md');

    const edges = await db.select().from(brainPageEdges);
    const embedsEdge = edges.find(
      (e) => e.fromId === 'task:T945' && e.toId === `llmtxt:${sha}` && e.edgeType === 'embeds',
    );
    expect(embedsEdge).toBeDefined();
    expect(embedsEdge?.provenance).toBe('auto:docs-add');
  });
});

describe('ensureMessageNode', () => {
  it('creates a msg:<id> node with no edges when content has no task refs', async () => {
    const { ensureMessageNode } = await import('../graph-auto-populate.js');
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    const { brainPageEdges, brainPageNodes } = await import('../../store/schema/memory-schema.js');

    await ensureMessageNode(tempDir, 'msg_abc', 'just a plain chat without ids');

    const db = await getBrainDb(tempDir);
    const nodes = await db.select().from(brainPageNodes);
    const msgNode = nodes.find((n) => n.id === 'msg:msg_abc');
    expect(msgNode).toBeDefined();
    expect(msgNode?.nodeType).toBe('msg');

    const edges = await db.select().from(brainPageEdges);
    const discussEdges = edges.filter((e) => e.fromId === 'msg:msg_abc');
    expect(discussEdges).toHaveLength(0);
  });

  it('extracts T### task references and emits discusses edges for each', async () => {
    const { ensureMessageNode } = await import('../graph-auto-populate.js');
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    const { brainPageEdges } = await import('../../store/schema/memory-schema.js');

    await ensureMessageNode(
      tempDir,
      'msg_ref',
      'Discussing T945 and T832 — also T945 again, plus T99 which is too short.',
    );

    const db = await getBrainDb(tempDir);
    const edges = await db.select().from(brainPageEdges);
    const discussEdges = edges.filter(
      (e) => e.fromId === 'msg:msg_ref' && e.edgeType === 'discusses',
    );

    // T945 and T832 are valid (3+ digits); T99 has only 2 and is filtered out.
    // T945 appearing twice must collapse to one edge.
    const targets = discussEdges.map((e) => e.toId).sort();
    expect(targets).toEqual(['task:T832', 'task:T945']);
  });
});

describe('ensureCommitNode', () => {
  it('creates a commit:<sha> node and a touches_code edge from the task', async () => {
    const { ensureCommitNode } = await import('../graph-auto-populate.js');
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    const { brainPageEdges, brainPageNodes } = await import('../../store/schema/memory-schema.js');

    const sha = '04021568adeadbeefcafef00d1234567890abcde';
    await ensureCommitNode(tempDir, sha, 'T945');

    const db = await getBrainDb(tempDir);

    const nodes = await db.select().from(brainPageNodes);
    const commitNode = nodes.find((n) => n.id === `commit:${sha}`);
    expect(commitNode).toBeDefined();
    expect(commitNode?.nodeType).toBe('commit');
    expect(commitNode?.qualityScore).toBe(1.0);

    const edges = await db.select().from(brainPageEdges);
    const touchesEdge = edges.find(
      (e) =>
        e.fromId === 'task:T945' && e.toId === `commit:${sha}` && e.edgeType === 'touches_code',
    );
    expect(touchesEdge).toBeDefined();
    expect(touchesEdge?.provenance).toBe('auto:commit-hook');
  });
});

describe('new edge types accept inserts', () => {
  it('accepts all five T945 Stage A edge types via addGraphEdge', async () => {
    const { addGraphEdge, upsertGraphNode } = await import('../graph-auto-populate.js');
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    const { brainPageEdges } = await import('../../store/schema/memory-schema.js');

    // Seed distinct source/target nodes so each PK (from, to, type) is unique.
    await upsertGraphNode(tempDir, 'task:T001', 'task', 'Source task', 0.7, 'one');
    await upsertGraphNode(tempDir, 'task:T002', 'task', 'Target task', 0.7, 'two');
    await upsertGraphNode(tempDir, 'msg:m1', 'msg', 'Chat', 0.5, 'x');
    await upsertGraphNode(tempDir, 'decision:D1', 'decision', 'Decision', 0.9, 'y');
    await upsertGraphNode(tempDir, 'llmtxt:deadbeef', 'llmtxt', 'Spec', 0.8, 'deadbeef');
    await upsertGraphNode(tempDir, 'symbol:src/foo.ts::bar', 'symbol', 'bar', 0.7, '');

    // Exercise all five new edge types.
    await addGraphEdge(tempDir, 'task:T001', 'task:T002', 'blocks', 1.0, 't945-test');
    await addGraphEdge(tempDir, 'msg:m1', 'task:T001', 'discusses', 0.8, 't945-test');
    await addGraphEdge(tempDir, 'decision:D1', 'llmtxt:deadbeef', 'cites', 0.9, 't945-test');
    await addGraphEdge(tempDir, 'task:T001', 'llmtxt:deadbeef', 'embeds', 1.0, 't945-test');
    await addGraphEdge(
      tempDir,
      'task:T001',
      'symbol:src/foo.ts::bar',
      'touches_code',
      1.0,
      't945-test',
    );

    const db = await getBrainDb(tempDir);
    const edges = await db.select().from(brainPageEdges);

    const expected: readonly ('blocks' | 'discusses' | 'cites' | 'embeds' | 'touches_code')[] = [
      'blocks',
      'discusses',
      'cites',
      'embeds',
      'touches_code',
    ];
    for (const edgeType of expected) {
      expect(edges.some((e) => e.edgeType === edgeType)).toBe(true);
    }
  });
});

describe('scoped document graph projection', () => {
  async function contextForRoot(signal?: AbortSignal) {
    const { createOperationExecutionContext } = await import('../../store/background-ops.js');
    return createOperationExecutionContext(
      {
        projectId: 'captured-project',
        projectRoot: tempDir,
        actor: 'fixture',
        operation: 'docs.graph',
        idempotencyKey: 'fixture-projection',
      },
      { signal, budgetMs: 10000 },
    );
  }

  it('pins writes to captured A even when CLEO_DIR changes to B during config reads', async () => {
    const registry = await import('../../config/registry.js');
    const original = registry.resolveCleoConfig;
    const otherDir = join(tempDir, 'other', '.cleo');
    const spy = vi.spyOn(registry, 'resolveCleoConfig').mockImplementation(async (options) => {
      const result = await original(options);
      process.env['CLEO_DIR'] = otherDir;
      return result;
    });
    const { ensureLlmtxtNodeScoped } = await import('../graph-auto-populate.js');
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    const { brainPageNodes, brainPageEdges } = await import('../../store/schema/memory-schema.js');
    const { access } = await import('node:fs/promises');
    const context = await contextForRoot();
    try {
      expect(await ensureLlmtxtNodeScoped(context, 'scoped-a', 'task:T945', 'A document')).toEqual({
        status: 'completed',
        projectId: 'captured-project',
        projectRoot: tempDir,
      });
      process.env['CLEO_DIR'] = cleoDir;
      const db = await getBrainDb(tempDir);
      expect((await db.select().from(brainPageNodes)).map((row) => row.id)).toContain(
        'llmtxt:scoped-a',
      );
      expect((await db.select().from(brainPageEdges)).map((row) => row.toId)).toContain(
        'llmtxt:scoped-a',
      );
      await expect(access(otherDir)).rejects.toThrow();
    } finally {
      context.close();
      spy.mockRestore();
    }
  });

  it('reports disabled policy explicitly and rejects malformed policy', async () => {
    const { ensureLlmtxtNodeScoped } = await import('../graph-auto-populate.js');
    const context = await contextForRoot();
    try {
      await writeFile(
        join(cleoDir, 'config.json'),
        JSON.stringify({ brain: { autoCapture: false } }),
      );
      expect(
        (await ensureLlmtxtNodeScoped(context, 'disabled', 'task:T945', 'Disabled')).status,
      ).toBe('disabled');
      await writeFile(join(cleoDir, 'config.json'), '{bad JSON');
      await expect(ensureLlmtxtNodeScoped(context, 'bad', 'task:T945', 'Bad')).rejects.toThrow();
      await writeFile(
        join(cleoDir, 'config.json'),
        JSON.stringify({ brain: { autoCapture: 'true' } }),
      );
      await expect(ensureLlmtxtNodeScoped(context, 'bad', 'task:T945', 'Bad')).rejects.toThrow(
        'Invalid brain.autoCapture',
      );
    } finally {
      context.close();
    }
  });

  it('rejects cancellation after handle acquisition before any graph write', async () => {
    const storage = await import('../../store/memory-sqlite.js');
    const original = storage.getBrainDb;
    const controller = new AbortController();
    const context = await contextForRoot(controller.signal);
    const spy = vi.spyOn(storage, 'getBrainDb').mockImplementation(async (root) => {
      const db = await original(root);
      controller.abort();
      return db;
    });
    const { ensureLlmtxtNodeScoped } = await import('../graph-auto-populate.js');
    const { brainPageNodes } = await import('../../store/schema/memory-schema.js');
    try {
      await expect(
        ensureLlmtxtNodeScoped(context, 'cancelled', 'task:T945', 'Cancelled'),
      ).rejects.toThrow();
      expect(await (await original(tempDir)).select().from(brainPageNodes)).toHaveLength(0);
    } finally {
      context.close();
      spy.mockRestore();
    }
  });

  it('does not join an unrelated native transaction or falsely report committed projection', async () => {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(tempDir);
    const native = getBrainNativeDb(tempDir)!;
    const { ensureLlmtxtNodeScoped } = await import('../graph-auto-populate.js');
    const context = await contextForRoot();
    native.exec('BEGIN');
    try {
      await expect(
        ensureLlmtxtNodeScoped(context, 'unowned', 'task:T945', 'Unowned'),
      ).rejects.toThrow();
      expect(native.prepare('SELECT COUNT(*) AS n FROM brain_page_nodes').get()?.n).toBe(0);
      native.exec('ROLLBACK');
    } finally {
      context.close();
    }
  });

  it('surfaces an edge-write fault and resumes its committed node idempotently', async () => {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(tempDir);
    const native = getBrainNativeDb(tempDir)!;
    const { ensureLlmtxtNodeScoped } = await import('../graph-auto-populate.js');
    const { execFileSync } = await import('node:child_process');
    const context = await contextForRoot();
    native.exec(
      "CREATE TRIGGER fail_projection BEFORE INSERT ON brain_page_edges BEGIN SELECT RAISE(ABORT, 'projection edge fault'); END",
    );
    try {
      await expect(
        ensureLlmtxtNodeScoped(context, 'resumable', 'task:T945', 'Resumable'),
      ).rejects.toThrow();
      const read = () =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1], { readOnly: true }); process.stdout.write(JSON.stringify([db.prepare('SELECT id FROM brain_page_nodes').all(), db.prepare('SELECT to_id FROM brain_page_edges').all()])); db.close();",
              join(cleoDir, 'cleo.db'),
            ],
            { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
          ),
        );
      expect(read()).toEqual([[{ id: 'llmtxt:resumable' }], []]);
      native.exec('DROP TRIGGER fail_projection');
      expect(
        (await ensureLlmtxtNodeScoped(context, 'resumable', 'task:T945', 'Resumable')).status,
      ).toBe('completed');
      expect(read()).toEqual([[{ id: 'llmtxt:resumable' }], [{ to_id: 'llmtxt:resumable' }]]);
    } finally {
      context.close();
    }
  });

  it('refuses escaped closed context before opening a handle', async () => {
    const storage = await import('../../store/memory-sqlite.js');
    const spy = vi.spyOn(storage, 'getBrainDb');
    const { ensureLlmtxtNodeScoped } = await import('../graph-auto-populate.js');
    const context = await contextForRoot();
    context.close();
    await expect(
      ensureLlmtxtNodeScoped(context, 'closed', 'task:T945', 'Closed'),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
