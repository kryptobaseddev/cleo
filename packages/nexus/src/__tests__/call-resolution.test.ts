/**
 * Tests for T536 — Call resolution (Tier 1+2a) and heritage processing.
 *
 * Covers:
 * - extractCalls: call expression extraction from TypeScript AST
 * - Heritage processing: EXTENDS/IMPLEMENTS edge emission
 * - HeritageMap: directParents and implementorFiles indexes
 * - resolveCalls: Tier 1 (same-file), Tier 2a (named-import), Tier 3 (global)
 * - emitClassMemberEdges: HAS_METHOD and HAS_PROPERTY edge emission
 *
 * @task T536
 */

import type { GraphNode } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { emitClassMemberEdges, resolveCalls } from '../pipeline/call-processor.js';
import type {
  ExtractedCall,
  ExtractedHeritage,
} from '../pipeline/extractors/typescript-extractor.js';
import { buildHeritageMap, processHeritage } from '../pipeline/heritage-processor.js';
import type { NamedImportMap } from '../pipeline/import-processor.js';
import { createKnowledgeGraph } from '../pipeline/knowledge-graph.js';
import { createResolutionContext } from '../pipeline/resolution-context.js';
import { createSymbolTable } from '../pipeline/symbol-table.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNode(
  id: string,
  kind: GraphNode['kind'],
  name: string,
  filePath: string,
  parent?: string,
): GraphNode {
  return {
    id,
    kind,
    name,
    filePath,
    startLine: 1,
    endLine: 10,
    language: 'typescript',
    exported: true,
    ...(parent !== undefined ? { parent } : {}),
  };
}

// ---------------------------------------------------------------------------
// Heritage processing tests
// ---------------------------------------------------------------------------

describe('processHeritage', () => {
  it('emits EXTENDS edge for extends clause', () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    // Register parent class in symbol table
    ctx.symbols.add('src/base.ts', 'Base', 'src/base.ts::Base', 'class');
    // Register child class in symbol table
    ctx.symbols.add('src/child.ts', 'Child', 'src/child.ts::Child', 'class');

    const heritage: ExtractedHeritage[] = [
      {
        filePath: 'src/child.ts',
        typeName: 'Child',
        typeNodeId: 'src/child.ts::Child',
        kind: 'extends',
        parentName: 'Base',
      },
    ];

    const result = processHeritage(heritage, graph, ctx);

    expect(result.extendsCount).toBe(1);
    expect(result.implementsCount).toBe(0);
    expect(result.skippedCount).toBe(0);

    const extendsEdges = graph.relations.filter((r) => r.type === 'extends');
    expect(extendsEdges).toHaveLength(1);
    expect(extendsEdges[0]!.source).toBe('src/child.ts::Child');
    expect(extendsEdges[0]!.target).toBe('src/base.ts::Base');
    expect(extendsEdges[0]!.confidence).toBeGreaterThan(0.5);
  });

  it('emits IMPLEMENTS edge for implements clause', () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    ctx.symbols.add('src/iface.ts', 'IFoo', 'src/iface.ts::IFoo', 'interface');
    ctx.symbols.add('src/class.ts', 'FooImpl', 'src/class.ts::FooImpl', 'class');

    const heritage: ExtractedHeritage[] = [
      {
        filePath: 'src/class.ts',
        typeName: 'FooImpl',
        typeNodeId: 'src/class.ts::FooImpl',
        kind: 'implements',
        parentName: 'IFoo',
      },
    ];

    const result = processHeritage(heritage, graph, ctx);

    expect(result.implementsCount).toBe(1);
    expect(result.extendsCount).toBe(0);

    const implEdges = graph.relations.filter((r) => r.type === 'implements');
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0]!.source).toBe('src/class.ts::FooImpl');
    expect(implEdges[0]!.target).toBe('src/iface.ts::IFoo');
  });

  it('uses stub ID for unresolvable parent type', () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    // Only register child — parent is external
    ctx.symbols.add('src/child.ts', 'Child', 'src/child.ts::Child', 'class');

    const heritage: ExtractedHeritage[] = [
      {
        filePath: 'src/child.ts',
        typeName: 'Child',
        typeNodeId: 'src/child.ts::Child',
        kind: 'extends',
        parentName: 'ExternalBase',
      },
    ];

    const result = processHeritage(heritage, graph, ctx);

    // Should still emit the edge with a stub target
    expect(result.extendsCount).toBe(1);
    const edges = graph.relations.filter((r) => r.type === 'extends');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe('__heritage__ExternalBase');
    expect(edges[0]!.confidence).toBeLessThanOrEqual(0.95);
  });

  it('skips record when child type not found in symbol table', () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    // Register only parent — child extraction failed
    ctx.symbols.add('src/base.ts', 'Base', 'src/base.ts::Base', 'class');

    const heritage: ExtractedHeritage[] = [
      {
        filePath: 'src/child.ts',
        typeName: 'MissingChild',
        typeNodeId: 'src/child.ts::MissingChild',
        kind: 'extends',
        parentName: 'Base',
      },
    ];

    const result = processHeritage(heritage, graph, ctx);

    expect(result.skippedCount).toBe(1);
    expect(result.extendsCount).toBe(0);
    expect(graph.relations).toHaveLength(0);
  });

  it('skips self-referencing heritage', () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    ctx.symbols.add('src/foo.ts', 'Foo', 'src/foo.ts::Foo', 'class');

    const heritage: ExtractedHeritage[] = [
      {
        filePath: 'src/foo.ts',
        typeName: 'Foo',
        typeNodeId: 'src/foo.ts::Foo',
        kind: 'extends',
        parentName: 'Foo', // self-reference
      },
    ];

    const result = processHeritage(heritage, graph, ctx);
    expect(result.skippedCount).toBe(1);
    expect(graph.relations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HeritageMap tests
// ---------------------------------------------------------------------------

describe('buildHeritageMap', () => {
  it('tracks direct parents via nodeId', () => {
    const ctx = createResolutionContext();

    ctx.symbols.add('src/base.ts', 'Base', 'src/base.ts::Base', 'class');
    ctx.symbols.add('src/child.ts', 'Child', 'src/child.ts::Child', 'class');

    const heritage: ExtractedHeritage[] = [
      {
        filePath: 'src/child.ts',
        typeName: 'Child',
        typeNodeId: 'src/child.ts::Child',
        kind: 'extends',
        parentName: 'Base',
      },
    ];

    const map = buildHeritageMap(heritage, ctx);
    const parents = map.getParents('src/child.ts::Child');
    expect(parents).toContain('src/base.ts::Base');
  });

  it('returns empty array for unknown child', () => {
    const ctx = createResolutionContext();
    const map = buildHeritageMap([], ctx);
    expect(map.getParents('nonexistent')).toHaveLength(0);
  });

  it('tracks implementor files for interface name', () => {
    const ctx = createResolutionContext();

    ctx.symbols.add('src/iface.ts', 'IRepo', 'src/iface.ts::IRepo', 'interface');
    ctx.symbols.add('src/impl.ts', 'RepoImpl', 'src/impl.ts::RepoImpl', 'class');

    const heritage: ExtractedHeritage[] = [
      {
        filePath: 'src/impl.ts',
        typeName: 'RepoImpl',
        typeNodeId: 'src/impl.ts::RepoImpl',
        kind: 'implements',
        parentName: 'IRepo',
      },
    ];

    const map = buildHeritageMap(heritage, ctx);
    const implementors = map.getImplementorFiles('IRepo');
    expect(implementors.has('src/impl.ts')).toBe(true);
  });

  it('getAncestors returns full chain', () => {
    const ctx = createResolutionContext();

    ctx.symbols.add('src/a.ts', 'A', 'src/a.ts::A', 'class');
    ctx.symbols.add('src/b.ts', 'B', 'src/b.ts::B', 'class');
    ctx.symbols.add('src/c.ts', 'C', 'src/c.ts::C', 'class');

    const heritage: ExtractedHeritage[] = [
      {
        filePath: 'src/b.ts',
        typeName: 'B',
        typeNodeId: 'src/b.ts::B',
        kind: 'extends',
        parentName: 'A',
      },
      {
        filePath: 'src/c.ts',
        typeName: 'C',
        typeNodeId: 'src/c.ts::C',
        kind: 'extends',
        parentName: 'B',
      },
    ];

    const map = buildHeritageMap(heritage, ctx);
    const ancestors = map.getAncestors('src/c.ts::C');
    expect(ancestors).toContain('src/b.ts::B');
    expect(ancestors).toContain('src/a.ts::A');
  });
});

// ---------------------------------------------------------------------------
// Call resolution tests
// ---------------------------------------------------------------------------

describe('resolveCalls', () => {
  it('resolves Tier 1 (same-file) call', async () => {
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();
    const namedImportMap: NamedImportMap = new Map();

    // Register a function in the same file
    symbolTable.add('src/foo.ts', 'helper', 'src/foo.ts::helper', 'function');

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/foo.ts',
        calledName: 'helper',
        sourceId: 'src/foo.ts::main',
        callForm: 'free',
      },
    ];

    const result = await resolveCalls(calls, graph, symbolTable, namedImportMap);

    expect(result.tier1Count).toBe(1);
    expect(result.tier2aCount).toBe(0);
    expect(result.tier3Count).toBe(0);

    const callsEdges = graph.relations.filter((r) => r.type === 'calls');
    expect(callsEdges).toHaveLength(1);
    expect(callsEdges[0]!.source).toBe('src/foo.ts::main');
    expect(callsEdges[0]!.target).toBe('src/foo.ts::helper');
    expect(callsEdges[0]!.confidence).toBe(0.95);
  });

  it('resolves Tier 2a (named-import) call', async () => {
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();

    // Register the function in its source file
    symbolTable.add('src/utils.ts', 'parseDate', 'src/utils.ts::parseDate', 'function');

    // Build a namedImportMap: bar.ts imports parseDate from utils.ts
    const namedImportMap: NamedImportMap = new Map([
      [
        'src/bar.ts',
        new Map([['parseDate', { sourcePath: 'src/utils.ts', exportedName: 'parseDate' }]]),
      ],
    ]);

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/bar.ts',
        calledName: 'parseDate',
        sourceId: 'src/bar.ts::process',
        callForm: 'free',
      },
    ];

    const result = await resolveCalls(calls, graph, symbolTable, namedImportMap);

    expect(result.tier2aCount).toBe(1);
    expect(result.tier1Count).toBe(0);

    const callsEdges = graph.relations.filter((r) => r.type === 'calls');
    expect(callsEdges).toHaveLength(1);
    expect(callsEdges[0]!.target).toBe('src/utils.ts::parseDate');
    expect(callsEdges[0]!.confidence).toBe(0.9);
  });

  it('resolves Tier 3 (global) when only one candidate', async () => {
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();
    const namedImportMap: NamedImportMap = new Map();

    // Register the function in a different file (global callable)
    symbolTable.add('src/lib.ts', 'uniqueHelper', 'src/lib.ts::uniqueHelper', 'function');

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.ts',
        calledName: 'uniqueHelper',
        sourceId: 'src/consumer.ts::run',
        callForm: 'free',
      },
    ];

    const result = await resolveCalls(calls, graph, symbolTable, namedImportMap);

    expect(result.tier3Count).toBe(1);
    expect(result.tier1Count).toBe(0);
    expect(result.tier2aCount).toBe(0);

    const callsEdges = graph.relations.filter((r) => r.type === 'calls');
    expect(callsEdges).toHaveLength(1);
    expect(callsEdges[0]!.confidence).toBe(0.5);
  });

  it('skips Tier 3 when multiple global candidates (ambiguous)', async () => {
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();
    const namedImportMap: NamedImportMap = new Map();

    // Register the same function name in two different files
    symbolTable.add('src/a.ts', 'process', 'src/a.ts::process', 'function');
    symbolTable.add('src/b.ts', 'process', 'src/b.ts::process', 'function');

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.ts',
        calledName: 'process',
        sourceId: 'src/consumer.ts::run',
        callForm: 'free',
      },
    ];

    const result = await resolveCalls(calls, graph, symbolTable, namedImportMap);

    expect(result.unresolvedCount).toBe(1);
    expect(result.tier3Count).toBe(0);
    expect(graph.relations).toHaveLength(0);
  });

  it('applies arity filter in Tier 3', async () => {
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();
    const namedImportMap: NamedImportMap = new Map();

    // Register a function that takes exactly 2 params
    symbolTable.add('src/lib.ts', 'compute', 'src/lib.ts::compute', 'function', {
      parameterCount: 2,
      requiredParameterCount: 2,
    });

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/consumer.ts',
        calledName: 'compute',
        sourceId: 'src/consumer.ts::run',
        callForm: 'free',
        argCount: 5, // Wrong arity
      },
    ];

    const result = await resolveCalls(calls, graph, symbolTable, namedImportMap);

    // Should be unresolved because arity doesn't match
    expect(result.unresolvedCount).toBe(1);
    expect(result.tier3Count).toBe(0);
  });

  it('counts unresolved calls', async () => {
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();
    const namedImportMap: NamedImportMap = new Map();

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/foo.ts',
        calledName: 'nonExistentFunction',
        sourceId: 'src/foo.ts::main',
        callForm: 'free',
      },
    ];

    const result = await resolveCalls(calls, graph, symbolTable, namedImportMap);

    expect(result.unresolvedCount).toBe(1);
    expect(result.tier1Count).toBe(0);
    expect(result.tier2aCount).toBe(0);
    expect(result.tier3Count).toBe(0);
    expect(graph.relations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// emitClassMemberEdges tests
// ---------------------------------------------------------------------------

describe('emitClassMemberEdges', () => {
  it('emits HAS_METHOD edges for method nodes', () => {
    const graph = createKnowledgeGraph();

    // Add a class node
    graph.addNode(makeNode('src/foo.ts::Foo', 'class', 'Foo', 'src/foo.ts'));

    // Add a method node with parent reference
    graph.addNode(
      makeNode('src/foo.ts::Foo.bar', 'method', 'bar', 'src/foo.ts', 'src/foo.ts::Foo'),
    );

    const result = emitClassMemberEdges(graph);

    expect(result.hasMethodCount).toBe(1);
    expect(result.hasPropertyCount).toBe(0);

    const hasMethodEdges = graph.relations.filter((r) => r.type === 'has_method');
    expect(hasMethodEdges).toHaveLength(1);
    expect(hasMethodEdges[0]!.source).toBe('src/foo.ts::Foo');
    expect(hasMethodEdges[0]!.target).toBe('src/foo.ts::Foo.bar');
    expect(hasMethodEdges[0]!.confidence).toBe(0.99);
  });

  it('emits HAS_PROPERTY edges for property nodes', () => {
    const graph = createKnowledgeGraph();

    graph.addNode(makeNode('src/foo.ts::Foo', 'class', 'Foo', 'src/foo.ts'));
    graph.addNode(
      makeNode('src/foo.ts::Foo.name', 'property', 'name', 'src/foo.ts', 'src/foo.ts::Foo'),
    );

    const result = emitClassMemberEdges(graph);

    expect(result.hasPropertyCount).toBe(1);
    const hasPropEdges = graph.relations.filter((r) => r.type === 'has_property');
    expect(hasPropEdges).toHaveLength(1);
    expect(hasPropEdges[0]!.source).toBe('src/foo.ts::Foo');
    expect(hasPropEdges[0]!.target).toBe('src/foo.ts::Foo.name');
  });

  it('emits HAS_METHOD edge for constructor nodes', () => {
    const graph = createKnowledgeGraph();

    graph.addNode(makeNode('src/foo.ts::Foo', 'class', 'Foo', 'src/foo.ts'));
    graph.addNode(
      makeNode(
        'src/foo.ts::Foo.constructor',
        'constructor',
        'constructor',
        'src/foo.ts',
        'src/foo.ts::Foo',
      ),
    );

    const result = emitClassMemberEdges(graph);

    expect(result.hasMethodCount).toBe(1);
    const methodEdges = graph.relations.filter((r) => r.type === 'has_method');
    expect(methodEdges[0]!.target).toBe('src/foo.ts::Foo.constructor');
  });

  it('skips nodes without parent', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(makeNode('src/foo.ts::bar', 'function', 'bar', 'src/foo.ts'));

    const result = emitClassMemberEdges(graph);
    expect(result.hasMethodCount).toBe(0);
    expect(result.hasPropertyCount).toBe(0);
    expect(graph.relations).toHaveLength(0);
  });

  it('handles empty graph', () => {
    const graph = createKnowledgeGraph();
    const result = emitClassMemberEdges(graph);
    expect(result.hasMethodCount).toBe(0);
    expect(result.hasPropertyCount).toBe(0);
  });
});
