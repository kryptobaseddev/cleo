/**
 * Tests for community detection (Phase 5) and process detection (Phase 6).
 *
 * Covers:
 * - detectCommunities: empty graph, single community, multiple communities
 * - detectProcesses: empty graph, no entry points, multi-hop traces
 * - calculateEntryPointScore: score ranking, utility penalty, export bonus
 * - isTestFile: correct classification of test file paths
 *
 * @task T538
 */

import type { GraphNode, GraphRelation } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { detectCommunities } from '../pipeline/community-processor.js';
import {
  calculateEntryPointScore,
  isTestFile,
  isUtilityFile,
} from '../pipeline/entry-point-scoring.js';
import { createKnowledgeGraph } from '../pipeline/knowledge-graph.js';
import { detectProcesses } from '../pipeline/process-processor.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNode(
  partial: Partial<GraphNode> & { id: string; kind: GraphNode['kind'] },
): GraphNode {
  return {
    name: partial.id,
    filePath: 'src/unknown.ts',
    startLine: 1,
    endLine: 10,
    language: 'typescript',
    exported: false,
    ...partial,
  };
}

function makeRel(
  source: string,
  target: string,
  type: GraphRelation['type'],
  confidence = 0.9,
): GraphRelation {
  return { source, target, type, confidence };
}

// ---------------------------------------------------------------------------
// Entry point scoring
// ---------------------------------------------------------------------------

describe('calculateEntryPointScore', () => {
  it('returns score 0 when calleeCount is 0', () => {
    const { score } = calculateEntryPointScore('handleLogin', false, 0, 0);
    expect(score).toBe(0);
  });

  it('exported functions score higher than unexported', () => {
    const exported = calculateEntryPointScore('processPayment', true, 1, 5);
    const unexported = calculateEntryPointScore('processPayment', false, 1, 5);
    expect(exported.score).toBeGreaterThan(unexported.score);
  });

  it('utility pattern functions get penalised', () => {
    const util = calculateEntryPointScore('getUser', false, 1, 5);
    const handler = calculateEntryPointScore('handleUser', false, 1, 5);
    expect(util.score).toBeLessThan(handler.score);
  });

  it('entry point name patterns get a bonus', () => {
    const base = calculateEntryPointScore('doSomething', false, 1, 5);
    const handler = calculateEntryPointScore('handleSomething', false, 1, 5);
    expect(handler.score).toBeGreaterThan(base.score);
  });

  it('high callees-to-callers ratio increases score', () => {
    const highRatio = calculateEntryPointScore('processData', false, 0, 10);
    const lowRatio = calculateEntryPointScore('processData', false, 10, 1);
    expect(highRatio.score).toBeGreaterThan(lowRatio.score);
  });
});

// ---------------------------------------------------------------------------
// isTestFile / isUtilityFile
// ---------------------------------------------------------------------------

describe('isTestFile', () => {
  it('returns true for .test.ts files', () => {
    expect(isTestFile('src/auth.test.ts')).toBe(true);
  });

  it('returns true for .spec.ts files', () => {
    expect(isTestFile('src/auth.spec.ts')).toBe(true);
  });

  it('returns true for __tests__ directory', () => {
    expect(isTestFile('src/__tests__/auth.ts')).toBe(true);
  });

  it('returns false for normal source files', () => {
    expect(isTestFile('src/auth.ts')).toBe(false);
  });

  it('returns false for files that mention "test" in their name but are not test files', () => {
    expect(isTestFile('src/testament.ts')).toBe(false);
  });
});

describe('isUtilityFile', () => {
  it('returns true for /utils/ paths', () => {
    expect(isUtilityFile('src/utils/format.ts')).toBe(true);
  });

  it('returns false for non-utility paths', () => {
    expect(isUtilityFile('src/commands/auth.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectCommunities — empty graph
// ---------------------------------------------------------------------------

describe('detectCommunities — empty graph', () => {
  it('returns empty result when graph has no nodes', async () => {
    const graph = createKnowledgeGraph();
    const result = await detectCommunities(graph);

    expect(result.communities).toHaveLength(0);
    expect(result.memberships).toHaveLength(0);
    expect(result.stats.totalCommunities).toBe(0);
    expect(result.stats.nodesProcessed).toBe(0);
  });

  it('returns empty result when graph has nodes but no CALLS edges', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(makeNode({ id: 'nodeA', kind: 'function' }));
    graph.addNode(makeNode({ id: 'nodeB', kind: 'function' }));

    const result = await detectCommunities(graph);

    expect(result.communities).toHaveLength(0);
    expect(result.memberships).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectCommunities — two connected clusters
// ---------------------------------------------------------------------------

describe('detectCommunities — two clusters', () => {
  it('processes connected graph and returns valid results', async () => {
    const graph = createKnowledgeGraph();

    // Cluster A: fully connected 4-node clique (all call each other)
    for (let i = 1; i <= 4; i++) {
      graph.addNode(makeNode({ id: `a${i}`, kind: 'function', filePath: 'src/auth/auth.ts' }));
    }
    for (let i = 1; i <= 4; i++) {
      for (let j = i + 1; j <= 4; j++) {
        graph.addRelation(makeRel(`a${i}`, `a${j}`, 'calls'));
      }
    }

    // Cluster B: fully connected 4-node clique (isolated from A)
    for (let i = 1; i <= 4; i++) {
      graph.addNode(
        makeNode({ id: `b${i}`, kind: 'function', filePath: 'src/billing/billing.ts' }),
      );
    }
    for (let i = 1; i <= 4; i++) {
      for (let j = i + 1; j <= 4; j++) {
        graph.addRelation(makeRel(`b${i}`, `b${j}`, 'calls'));
      }
    }

    const result = await detectCommunities(graph);

    // Leiden should process the connected graph
    expect(result.stats.nodesProcessed).toBeGreaterThanOrEqual(6);
    expect(result.stats.modularity).toBeGreaterThanOrEqual(0);
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.stats.refinementIterations).toBeGreaterThanOrEqual(0);

    // Community nodes added to graph should match detected communities
    const communityNodes = Array.from(graph.nodes.values()).filter((n) => n.kind === 'community');
    expect(communityNodes.length).toBe(result.communities.length);

    // If communities were detected (non-singleton), MEMBER_OF edges should exist
    if (result.communities.length > 0) {
      expect(result.memberships.length).toBeGreaterThan(0);
      const memberOfEdges = graph.relations.filter((r) => r.type === 'member_of');
      expect(memberOfEdges.length).toBe(result.memberships.length);
    }
  });
});

// ---------------------------------------------------------------------------
// detectProcesses — empty graph
// ---------------------------------------------------------------------------

describe('detectProcesses — empty graph', () => {
  it('returns empty result when graph has no CALLS edges', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(makeNode({ id: 'fn1', kind: 'function' }));

    const result = await detectProcesses(graph, []);

    expect(result.processes).toHaveLength(0);
    expect(result.steps).toHaveLength(0);
    expect(result.stats.totalProcesses).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectProcesses — multi-hop trace
// ---------------------------------------------------------------------------

describe('detectProcesses — multi-hop trace', () => {
  it('detects a 3-step execution flow from an entry point', async () => {
    const graph = createKnowledgeGraph();

    // handleRequest (exported, calls many, called by none) → parseRequest → validateInput
    graph.addNode(
      makeNode({
        id: 'handleRequest',
        kind: 'function',
        name: 'handleRequest',
        exported: true,
        filePath: 'src/api/handler.ts',
      }),
    );
    graph.addNode(
      makeNode({
        id: 'parseRequest',
        kind: 'function',
        name: 'parseRequest',
        exported: false,
        filePath: 'src/api/parser.ts',
      }),
    );
    graph.addNode(
      makeNode({
        id: 'validateInput',
        kind: 'function',
        name: 'validateInput',
        exported: false,
        filePath: 'src/api/validator.ts',
      }),
    );

    // handleRequest → parseRequest → validateInput (3-hop chain)
    graph.addRelation(makeRel('handleRequest', 'parseRequest', 'calls', 0.9));
    graph.addRelation(makeRel('parseRequest', 'validateInput', 'calls', 0.9));

    const communityResult = await detectCommunities(graph);
    const result = await detectProcesses(graph, communityResult.memberships);

    // Should detect at least one process with >= 3 steps
    expect(result.processes.length).toBeGreaterThanOrEqual(1);
    expect(result.stats.entryPointsFound).toBeGreaterThanOrEqual(1);

    const longProcess = result.processes.find((p) => p.stepCount >= 3);
    expect(longProcess).toBeDefined();

    // Process nodes added to graph
    const processNodes = Array.from(graph.nodes.values()).filter((n) => n.kind === 'process');
    expect(processNodes.length).toBeGreaterThanOrEqual(1);

    // STEP_IN_PROCESS edges created
    const stepEdges = graph.relations.filter((r) => r.type === 'step_in_process');
    expect(stepEdges.length).toBeGreaterThanOrEqual(3);

    // ENTRY_POINT_OF edge for handleRequest
    const entryEdges = graph.relations.filter((r) => r.type === 'entry_point_of');
    expect(entryEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('excludes traces from test files', async () => {
    const graph = createKnowledgeGraph();

    graph.addNode(
      makeNode({
        id: 'testEntry',
        kind: 'function',
        name: 'testHandleRequest',
        exported: true,
        filePath: 'src/__tests__/handler.test.ts',
      }),
    );
    graph.addNode(
      makeNode({
        id: 'a',
        kind: 'function',
        name: 'doA',
        filePath: 'src/api/a.ts',
      }),
    );
    graph.addNode(
      makeNode({
        id: 'b',
        kind: 'function',
        name: 'doB',
        filePath: 'src/api/b.ts',
      }),
    );
    graph.addRelation(makeRel('testEntry', 'a', 'calls', 0.9));
    graph.addRelation(makeRel('a', 'b', 'calls', 0.9));

    const result = await detectProcesses(graph, []);

    // testEntry is a test file — should not be picked as entry point
    // The process might still start from a/b but testEntry specifically must not be entry
    const entryPointIds = result.processes.map((p) => p.entryPointId);
    expect(entryPointIds).not.toContain('testEntry');
  });
});
