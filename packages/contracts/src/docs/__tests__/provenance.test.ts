/**
 * Unit + snapshot tests for the Docs Provenance Graph contract (T10166).
 *
 * Coverage:
 *   - Round-trip Zod parse for each node variant + edge variant + envelope.
 *   - Discriminator rejection for unknown `kind` / `relation` / lifecycle values.
 *   - Type-guard narrowing for all five node variants.
 *   - Snapshot test for a typical-sized graph (5 docs, 8 tasks, 4 decisions,
 *     2 sessions) — locks the wire shape consumed by the renderer.
 *
 * @task T10166
 */

import { describe, expect, it } from 'vitest';
import {
  type DocProvenanceResponse,
  docLifecycleStatusSchema,
  docProvenanceResponseSchema,
  isDocProvenanceResponse,
  isProvenanceDecisionNode,
  isProvenanceDocNode,
  isProvenanceMemoryNode,
  isProvenanceSessionNode,
  isProvenanceTaskNode,
  type ProvenanceDecisionNode,
  type ProvenanceDocNode,
  type ProvenanceEdge,
  type ProvenanceMemoryNode,
  type ProvenanceNode,
  type ProvenanceSessionNode,
  type ProvenanceTaskNode,
  provenanceDocNodeSchema,
  provenanceEdgeRelationSchema,
  provenanceEdgeSchema,
  provenanceNodeKindSchema,
  provenanceNodeSchema,
} from '../provenance.js';

// ─── Enum schemas ─────────────────────────────────────────────────────────────

describe('provenanceNodeKindSchema', () => {
  it('accepts every canonical node kind', () => {
    expect(provenanceNodeKindSchema.parse('doc')).toBe('doc');
    expect(provenanceNodeKindSchema.parse('task')).toBe('task');
    expect(provenanceNodeKindSchema.parse('decision')).toBe('decision');
    expect(provenanceNodeKindSchema.parse('session')).toBe('session');
    expect(provenanceNodeKindSchema.parse('memory')).toBe('memory');
  });

  it('rejects an unknown node kind', () => {
    expect(() => provenanceNodeKindSchema.parse('artifact')).toThrow();
  });
});

describe('provenanceEdgeRelationSchema', () => {
  it('accepts every canonical edge relation', () => {
    for (const rel of [
      'attached-to',
      'supersedes',
      'superseded-by',
      'related-task',
      'linked-decision',
      'derived-from',
    ] as const) {
      expect(provenanceEdgeRelationSchema.parse(rel)).toBe(rel);
    }
  });

  it('rejects an unknown edge relation', () => {
    expect(() => provenanceEdgeRelationSchema.parse('mentions')).toThrow();
  });
});

describe('docLifecycleStatusSchema', () => {
  it('accepts every canonical lifecycle status', () => {
    for (const s of ['active', 'superseded', 'archived', 'draft'] as const) {
      expect(docLifecycleStatusSchema.parse(s)).toBe(s);
    }
  });

  it('rejects an unknown lifecycle status', () => {
    expect(() => docLifecycleStatusSchema.parse('retired')).toThrow();
  });
});

// ─── Node variants ────────────────────────────────────────────────────────────

describe('provenanceDocNodeSchema', () => {
  it('round-trips a minimal doc node', () => {
    const node: ProvenanceDocNode = {
      kind: 'doc',
      id: 'adr-078-docs-provenance-graph',
      slug: 'adr-078-docs-provenance-graph',
      docKind: 'adr',
      title: 'ADR 078 — Docs Provenance Graph',
      lifecycleStatus: 'active',
      publishedAt: '2026-05-22T18:00:00.000Z',
    };
    const parsed = provenanceDocNodeSchema.parse(node);
    expect(parsed).toEqual(node);
  });

  it('round-trips a superseded doc node with optional fields', () => {
    const node: ProvenanceDocNode = {
      kind: 'doc',
      id: 'adr-066-task-creation-axes',
      slug: 'adr-066-task-creation-axes',
      docKind: 'adr',
      title: 'ADR 066 — Task Creation Axes',
      lifecycleStatus: 'superseded',
      publishedAt: '2026-03-01T00:00:00.000Z',
      supersededAt: '2026-05-22T18:00:00.000Z',
      summary: 'Original 3-axis task creation model',
      metadata: { author: 'cleo-prime' },
    };
    const parsed = provenanceDocNodeSchema.parse(node);
    expect(parsed).toEqual(node);
  });

  it('rejects a doc node with the wrong discriminator', () => {
    expect(() =>
      provenanceDocNodeSchema.parse({
        kind: 'task',
        id: 'T1',
        title: 't',
        slug: 's',
        docKind: 'adr',
        lifecycleStatus: 'active',
        publishedAt: '2026-05-22T18:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('provenanceNodeSchema (discriminated union)', () => {
  it('parses a task node', () => {
    const node: ProvenanceTaskNode = {
      kind: 'task',
      id: 'T10166',
      title: 'C9: Provenance graph contract',
      taskType: 'task',
      status: 'in_progress',
    };
    expect(provenanceNodeSchema.parse(node)).toEqual(node);
  });

  it('parses a decision node', () => {
    const node: ProvenanceDecisionNode = {
      kind: 'decision',
      id: 'D-arch-001',
      title: 'Adopt evidence-based gate ritual',
      outcome: 'accepted',
      decidedAt: '2026-04-12T14:30:00.000Z',
    };
    expect(provenanceNodeSchema.parse(node)).toEqual(node);
  });

  it('parses a session node', () => {
    const node: ProvenanceSessionNode = {
      kind: 'session',
      id: 'ses_2026-05-22_abc123',
      title: 'Session 2026-05-22 — T10166 implementation',
      startedAt: '2026-05-22T18:00:00.000Z',
    };
    expect(provenanceNodeSchema.parse(node)).toEqual(node);
  });

  it('parses a memory node', () => {
    const node: ProvenanceMemoryNode = {
      kind: 'memory',
      id: 'O-2026-05-22-001',
      title: 'Observed spawn contention under parallel sessions',
      memoryType: 'observation',
      recordedAt: '2026-05-22T19:15:00.000Z',
    };
    expect(provenanceNodeSchema.parse(node)).toEqual(node);
  });

  it('rejects an unknown discriminator', () => {
    expect(() =>
      provenanceNodeSchema.parse({
        kind: 'artifact',
        id: 'a-1',
        title: 'unknown',
      }),
    ).toThrow();
  });
});

// ─── Edges ────────────────────────────────────────────────────────────────────

describe('provenanceEdgeSchema', () => {
  it('round-trips a minimal edge', () => {
    const edge: ProvenanceEdge = {
      relation: 'attached-to',
      from: 'adr-078-docs-provenance-graph',
      fromKind: 'doc',
      to: 'T10157',
      toKind: 'task',
      addedAt: '2026-05-22T18:00:00.000Z',
    };
    expect(provenanceEdgeSchema.parse(edge)).toEqual(edge);
  });

  it('round-trips an edge with optional summary', () => {
    const edge: ProvenanceEdge = {
      relation: 'supersedes',
      from: 'adr-078-docs-provenance-graph',
      fromKind: 'doc',
      to: 'adr-066-task-creation-axes',
      toKind: 'doc',
      addedAt: '2026-05-22T18:00:00.000Z',
      summary: 'replaces 3-axis model with full cross-entity graph',
    };
    expect(provenanceEdgeSchema.parse(edge)).toEqual(edge);
  });

  it('rejects an edge with an unknown relation', () => {
    expect(() =>
      provenanceEdgeSchema.parse({
        relation: 'mentions',
        from: 'a',
        fromKind: 'doc',
        to: 'b',
        toKind: 'doc',
        addedAt: '2026-05-22T18:00:00.000Z',
      }),
    ).toThrow();
  });
});

// ─── Envelope ─────────────────────────────────────────────────────────────────

describe('docProvenanceResponseSchema', () => {
  it('validates an empty graph', () => {
    const empty: DocProvenanceResponse = {
      nodes: [],
      edges: [],
      totalNodes: 0,
      totalEdges: 0,
    };
    expect(docProvenanceResponseSchema.parse(empty)).toEqual(empty);
  });

  it('validates a single-node graph', () => {
    const single: DocProvenanceResponse = {
      nodes: [
        {
          kind: 'doc',
          id: 'adr-078-docs-provenance-graph',
          slug: 'adr-078-docs-provenance-graph',
          docKind: 'adr',
          title: 'ADR 078',
          lifecycleStatus: 'active',
          publishedAt: '2026-05-22T18:00:00.000Z',
        },
      ],
      edges: [],
      totalNodes: 1,
      totalEdges: 0,
    };
    expect(docProvenanceResponseSchema.parse(single)).toEqual(single);
  });

  it('rejects negative totals', () => {
    expect(() =>
      docProvenanceResponseSchema.parse({
        nodes: [],
        edges: [],
        totalNodes: -1,
        totalEdges: 0,
      }),
    ).toThrow();
  });

  it('isDocProvenanceResponse narrows a valid envelope', () => {
    const candidate: unknown = {
      nodes: [],
      edges: [],
      totalNodes: 0,
      totalEdges: 0,
    };
    expect(isDocProvenanceResponse(candidate)).toBe(true);
  });

  it('isDocProvenanceResponse rejects a non-object', () => {
    expect(isDocProvenanceResponse(null)).toBe(false);
    expect(isDocProvenanceResponse('graph')).toBe(false);
    expect(isDocProvenanceResponse({ nodes: 'oops' })).toBe(false);
  });
});

// ─── Type guards ──────────────────────────────────────────────────────────────

describe('type guards', () => {
  const doc: ProvenanceDocNode = {
    kind: 'doc',
    id: 'adr-078-docs-provenance-graph',
    slug: 'adr-078-docs-provenance-graph',
    docKind: 'adr',
    title: 'ADR 078',
    lifecycleStatus: 'active',
    publishedAt: '2026-05-22T18:00:00.000Z',
  };
  const task: ProvenanceTaskNode = {
    kind: 'task',
    id: 'T10166',
    title: 'C9',
    taskType: 'task',
    status: 'in_progress',
  };
  const decision: ProvenanceDecisionNode = {
    kind: 'decision',
    id: 'D-arch-001',
    title: 'Adopt EBG ritual',
    outcome: 'accepted',
    decidedAt: '2026-04-12T14:30:00.000Z',
  };
  const session: ProvenanceSessionNode = {
    kind: 'session',
    id: 'ses_x',
    title: 's',
    startedAt: '2026-05-22T18:00:00.000Z',
  };
  const memory: ProvenanceMemoryNode = {
    kind: 'memory',
    id: 'O-1',
    title: 'm',
    memoryType: 'observation',
    recordedAt: '2026-05-22T18:00:00.000Z',
  };

  it('isProvenanceDocNode narrows correctly', () => {
    expect(isProvenanceDocNode(doc)).toBe(true);
    expect(isProvenanceDocNode(task)).toBe(false);
    expect(isProvenanceDocNode(decision)).toBe(false);
    expect(isProvenanceDocNode(session)).toBe(false);
    expect(isProvenanceDocNode(memory)).toBe(false);
  });

  it('isProvenanceTaskNode narrows correctly', () => {
    expect(isProvenanceTaskNode(task)).toBe(true);
    expect(isProvenanceTaskNode(doc)).toBe(false);
  });

  it('isProvenanceDecisionNode narrows correctly', () => {
    expect(isProvenanceDecisionNode(decision)).toBe(true);
    expect(isProvenanceDecisionNode(doc)).toBe(false);
  });

  it('isProvenanceSessionNode narrows correctly', () => {
    expect(isProvenanceSessionNode(session)).toBe(true);
    expect(isProvenanceSessionNode(doc)).toBe(false);
  });

  it('isProvenanceMemoryNode narrows correctly', () => {
    expect(isProvenanceMemoryNode(memory)).toBe(true);
    expect(isProvenanceMemoryNode(doc)).toBe(false);
  });
});

// ─── Snapshot: typical-sized graph (AC4) ──────────────────────────────────────

describe('typical-sized graph (AC4)', () => {
  /**
   * Build the AC4 fixture: 5 docs, 8 tasks, 4 decisions, 2 sessions.
   * Memory nodes are not part of the AC4 fixture but the contract supports
   * them — see {@link provenanceMemoryNodeSchema} tests above.
   */
  const buildFixture = (): DocProvenanceResponse => {
    const docs: ProvenanceDocNode[] = [
      {
        kind: 'doc',
        id: 'adr-078-docs-provenance-graph',
        slug: 'adr-078-docs-provenance-graph',
        docKind: 'adr',
        title: 'ADR 078 — Docs Provenance Graph',
        lifecycleStatus: 'active',
        publishedAt: '2026-05-22T18:00:00.000Z',
      },
      {
        kind: 'doc',
        id: 'spec-t10157-e12-provenance',
        slug: 'spec-t10157-e12-provenance',
        docKind: 'spec',
        title: 'E12 Docs Provenance Specification',
        lifecycleStatus: 'active',
        publishedAt: '2026-05-22T18:05:00.000Z',
      },
      {
        kind: 'doc',
        id: 'research-provenance-graph-design',
        slug: 'research-provenance-graph-design',
        docKind: 'research',
        title: 'Research — Cross-entity provenance graph design',
        lifecycleStatus: 'active',
        publishedAt: '2026-05-21T10:00:00.000Z',
      },
      {
        kind: 'doc',
        id: 'adr-066-task-creation-axes',
        slug: 'adr-066-task-creation-axes',
        docKind: 'adr',
        title: 'ADR 066 — Task Creation Axes',
        lifecycleStatus: 'superseded',
        publishedAt: '2026-03-01T00:00:00.000Z',
        supersededAt: '2026-05-22T18:00:00.000Z',
      },
      {
        kind: 'doc',
        id: 'handoff-sg-template-config-ssot-session-1',
        slug: 'handoff-sg-template-config-ssot-session-1',
        docKind: 'handoff',
        title: 'SG-TEMPLATE-CONFIG-SSOT handoff — session 1',
        lifecycleStatus: 'active',
        publishedAt: '2026-05-22T19:30:00.000Z',
      },
    ];
    const tasks: ProvenanceTaskNode[] = [
      { kind: 'task', id: 'T9855', title: 'Saga T9855', taskType: 'saga', status: 'in_progress' },
      {
        kind: 'task',
        id: 'T10157',
        title: 'E12 — Provenance Graph',
        taskType: 'epic',
        status: 'in_progress',
      },
      {
        kind: 'task',
        id: 'T10158',
        title: 'C1 — attachments-table migration',
        taskType: 'task',
        status: 'done',
      },
      {
        kind: 'task',
        id: 'T10162',
        title: 'C5 — supersede verb',
        taskType: 'task',
        status: 'pending',
      },
      { kind: 'task', id: 'T10164', title: 'C7 — graph CLI', taskType: 'task', status: 'pending' },
      {
        kind: 'task',
        id: 'T10166',
        title: 'C9 — provenance graph contract',
        taskType: 'task',
        status: 'in_progress',
      },
      {
        kind: 'task',
        id: 'T10138',
        title: 'TreeResponse contract',
        taskType: 'task',
        status: 'done',
      },
      {
        kind: 'task',
        id: 'T10166-sub1',
        title: 'Snapshot test fixture',
        taskType: 'subtask',
        status: 'in_progress',
      },
    ];
    const decisions: ProvenanceDecisionNode[] = [
      {
        kind: 'decision',
        id: 'D-prov-001',
        title: 'Cross-entity graph (not doc-only)',
        outcome: 'accepted',
        decidedAt: '2026-05-21T12:00:00.000Z',
      },
      {
        kind: 'decision',
        id: 'D-prov-002',
        title: 'Discriminated unions over inheritance',
        outcome: 'accepted',
        decidedAt: '2026-05-21T13:00:00.000Z',
      },
      {
        kind: 'decision',
        id: 'D-prov-003',
        title: 'Edge carries fromKind/toKind for disambiguation',
        outcome: 'accepted',
        decidedAt: '2026-05-21T14:00:00.000Z',
      },
      {
        kind: 'decision',
        id: 'D-prov-004',
        title: 'Compatible with TreeResponse renderer',
        outcome: 'proposed',
        decidedAt: '2026-05-22T18:00:00.000Z',
      },
    ];
    const sessions: ProvenanceSessionNode[] = [
      {
        kind: 'session',
        id: 'ses_2026-05-21_research',
        title: 'Research session — provenance graph design',
        startedAt: '2026-05-21T10:00:00.000Z',
        endedAt: '2026-05-21T14:30:00.000Z',
      },
      {
        kind: 'session',
        id: 'ses_2026-05-22_impl',
        title: 'Implementation session — T10166',
        startedAt: '2026-05-22T18:00:00.000Z',
      },
    ];
    const nodes: ProvenanceNode[] = [...docs, ...tasks, ...decisions, ...sessions];
    const edges: ProvenanceEdge[] = [
      // ADR-078 supersedes ADR-066
      {
        relation: 'supersedes',
        from: 'adr-078-docs-provenance-graph',
        fromKind: 'doc',
        to: 'adr-066-task-creation-axes',
        toKind: 'doc',
        addedAt: '2026-05-22T18:00:00.000Z',
      },
      {
        relation: 'superseded-by',
        from: 'adr-066-task-creation-axes',
        fromKind: 'doc',
        to: 'adr-078-docs-provenance-graph',
        toKind: 'doc',
        addedAt: '2026-05-22T18:00:00.000Z',
      },
      // ADR-078 attached-to T10157
      {
        relation: 'attached-to',
        from: 'adr-078-docs-provenance-graph',
        fromKind: 'doc',
        to: 'T10157',
        toKind: 'task',
        addedAt: '2026-05-22T18:00:00.000Z',
      },
      // spec attached-to T10157
      {
        relation: 'attached-to',
        from: 'spec-t10157-e12-provenance',
        fromKind: 'doc',
        to: 'T10157',
        toKind: 'task',
        addedAt: '2026-05-22T18:05:00.000Z',
      },
      // research attached-to T10157
      {
        relation: 'attached-to',
        from: 'research-provenance-graph-design',
        fromKind: 'doc',
        to: 'T10157',
        toKind: 'task',
        addedAt: '2026-05-21T10:00:00.000Z',
      },
      // handoff attached-to T9855
      {
        relation: 'attached-to',
        from: 'handoff-sg-template-config-ssot-session-1',
        fromKind: 'doc',
        to: 'T9855',
        toKind: 'task',
        addedAt: '2026-05-22T19:30:00.000Z',
      },
      // T10157 related-task T9855
      {
        relation: 'related-task',
        from: 'T10157',
        fromKind: 'task',
        to: 'T9855',
        toKind: 'task',
        addedAt: '2026-05-22T18:00:00.000Z',
      },
      // T10166 related-task T10138 (TreeResponse compatibility)
      {
        relation: 'related-task',
        from: 'T10166',
        fromKind: 'task',
        to: 'T10138',
        toKind: 'task',
        addedAt: '2026-05-22T18:00:00.000Z',
        summary: 'Compatible with TreeResponse renderer (AC3)',
      },
      // ADR-078 linked-decision D-prov-001
      {
        relation: 'linked-decision',
        from: 'adr-078-docs-provenance-graph',
        fromKind: 'doc',
        to: 'D-prov-001',
        toKind: 'decision',
        addedAt: '2026-05-21T12:00:00.000Z',
      },
      // spec linked-decision D-prov-002
      {
        relation: 'linked-decision',
        from: 'spec-t10157-e12-provenance',
        fromKind: 'doc',
        to: 'D-prov-002',
        toKind: 'decision',
        addedAt: '2026-05-21T13:00:00.000Z',
      },
      // research derived-from session ses_2026-05-21_research
      {
        relation: 'derived-from',
        from: 'research-provenance-graph-design',
        fromKind: 'doc',
        to: 'ses_2026-05-21_research',
        toKind: 'session',
        addedAt: '2026-05-21T10:00:00.000Z',
      },
      // handoff derived-from session ses_2026-05-22_impl
      {
        relation: 'derived-from',
        from: 'handoff-sg-template-config-ssot-session-1',
        fromKind: 'doc',
        to: 'ses_2026-05-22_impl',
        toKind: 'session',
        addedAt: '2026-05-22T19:30:00.000Z',
      },
    ];
    return {
      nodes,
      edges,
      totalNodes: nodes.length,
      totalEdges: edges.length,
    };
  };

  it('matches the AC4 fixture snapshot (5 docs + 8 tasks + 4 decisions + 2 sessions)', () => {
    const graph = buildFixture();

    // Sanity: AC4 cardinalities exactly.
    expect(graph.nodes.filter((n) => n.kind === 'doc')).toHaveLength(5);
    expect(graph.nodes.filter((n) => n.kind === 'task')).toHaveLength(8);
    expect(graph.nodes.filter((n) => n.kind === 'decision')).toHaveLength(4);
    expect(graph.nodes.filter((n) => n.kind === 'session')).toHaveLength(2);
    expect(graph.totalNodes).toBe(graph.nodes.length);
    expect(graph.totalEdges).toBe(graph.edges.length);

    // Round-trip through the Zod envelope schema — guarantees the snapshot
    // is also wire-valid.
    const parsed = docProvenanceResponseSchema.parse(graph);
    expect(parsed.totalNodes).toBe(graph.totalNodes);
    expect(parsed.totalEdges).toBe(graph.totalEdges);

    expect(graph).toMatchSnapshot();
  });
});
