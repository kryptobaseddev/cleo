/**
 * Tests for T617 — NEXUS barrel export re-export tracing.
 *
 * Covers:
 * - extractReExports: named and wildcard re-export extraction from AST
 * - buildBarrelExportMap: barrel map construction from re-export records
 * - resolveBarrelBinding: transitive chain tracing through barrel files
 * - resolveCalls: Tier 2a barrel-resolved CALLS edge emission
 *
 * @task T617
 */

import { describe, expect, it } from 'vitest';
import { resolveCalls } from '../pipeline/call-processor.js';
import type { ExtractedCall } from '../pipeline/extractors/typescript-extractor.js';
import {
  buildBarrelExportMap,
  buildImportResolutionContext,
  resolveBarrelBinding,
  type BarrelExportMap,
  type ExtractedReExportRecord,
} from '../pipeline/import-processor.js';
import type { NamedImportMap } from '../pipeline/import-processor.js';
import { createKnowledgeGraph } from '../pipeline/knowledge-graph.js';
import { createSymbolTable } from '../pipeline/symbol-table.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ImportResolutionContext from a list of file paths.
 * Used by buildBarrelExportMap for import resolution during tests.
 */
function makeImportCtx(filePaths: string[]) {
  return buildImportResolutionContext(filePaths);
}

// ---------------------------------------------------------------------------
// buildBarrelExportMap tests
// ---------------------------------------------------------------------------

describe('buildBarrelExportMap', () => {
  it('maps named re-export to canonical file', () => {
    const reExports: ExtractedReExportRecord[] = [
      {
        filePath: 'src/index.ts',
        rawSourcePath: './tasks/find.ts',
        exportedName: 'findTasks',
        localName: 'findTasks',
      },
    ];

    const ctx = makeImportCtx(['src/index.ts', 'src/tasks/find.ts']);
    const map = buildBarrelExportMap(reExports, ctx, null);

    expect(map.has('src/index.ts')).toBe(true);
    const entry = map.get('src/index.ts')?.get('findTasks');
    expect(entry).toBeDefined();
    expect(entry?.canonicalFile).toBe('src/tasks/find.ts');
    expect(entry?.canonicalName).toBe('findTasks');
  });

  it('maps aliased re-export correctly (export { X as Y })', () => {
    const reExports: ExtractedReExportRecord[] = [
      {
        filePath: 'src/index.ts',
        rawSourcePath: './utils/session.ts',
        exportedName: 'endSession', // external name callers use
        localName: 'endSession', // internal name in source file
      },
    ];

    const ctx = makeImportCtx(['src/index.ts', 'src/utils/session.ts']);
    const map = buildBarrelExportMap(reExports, ctx, null);

    const entry = map.get('src/index.ts')?.get('endSession');
    expect(entry?.canonicalFile).toBe('src/utils/session.ts');
    expect(entry?.canonicalName).toBe('endSession');
  });

  it('stores wildcard re-exports under *0, *1, ... keys', () => {
    const reExports: ExtractedReExportRecord[] = [
      {
        filePath: 'src/index.ts',
        rawSourcePath: './contracts/index.ts',
        exportedName: null,
        localName: null,
      },
    ];

    const ctx = makeImportCtx(['src/index.ts', 'src/contracts/index.ts']);
    const map = buildBarrelExportMap(reExports, ctx, null);

    expect(map.has('src/index.ts')).toBe(true);
    // Wildcard stored under *0
    const wildcardEntry = map.get('src/index.ts')?.get('*0');
    expect(wildcardEntry).toBeDefined();
    expect(wildcardEntry?.canonicalFile).toBe('src/contracts/index.ts');
    expect(wildcardEntry?.canonicalName).toBe('*');
  });

  it('handles multiple re-exports from the same barrel', () => {
    const reExports: ExtractedReExportRecord[] = [
      {
        filePath: 'src/index.ts',
        rawSourcePath: './tasks/find.ts',
        exportedName: 'findTasks',
        localName: 'findTasks',
      },
      {
        filePath: 'src/index.ts',
        rawSourcePath: './tasks/add.ts',
        exportedName: 'addTask',
        localName: 'addTask',
      },
    ];

    const ctx = makeImportCtx(['src/index.ts', 'src/tasks/find.ts', 'src/tasks/add.ts']);
    const map = buildBarrelExportMap(reExports, ctx, null);

    expect(map.get('src/index.ts')?.get('findTasks')?.canonicalFile).toBe('src/tasks/find.ts');
    expect(map.get('src/index.ts')?.get('addTask')?.canonicalFile).toBe('src/tasks/add.ts');
  });

  it('skips re-exports whose source path cannot be resolved', () => {
    const reExports: ExtractedReExportRecord[] = [
      {
        filePath: 'src/index.ts',
        rawSourcePath: './nonexistent.ts',
        exportedName: 'ghost',
        localName: 'ghost',
      },
    ];

    const ctx = makeImportCtx(['src/index.ts']);
    const map = buildBarrelExportMap(reExports, ctx, null);

    // The entry should not be present since the source couldn't be resolved
    expect(map.has('src/index.ts')).toBe(false);
  });

  it('returns empty map when given no re-exports', () => {
    const ctx = makeImportCtx(['src/index.ts']);
    const map = buildBarrelExportMap([], ctx, null);
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveBarrelBinding tests
// ---------------------------------------------------------------------------

describe('resolveBarrelBinding', () => {
  it('resolves direct named re-export', () => {
    const barrelMap: BarrelExportMap = new Map([
      [
        'src/index.ts',
        new Map([['findTasks', { canonicalFile: 'src/tasks/find.ts', canonicalName: 'findTasks' }]]),
      ],
    ]);

    const result = resolveBarrelBinding('src/index.ts', 'findTasks', barrelMap);
    expect(result).not.toBeNull();
    expect(result?.canonicalFile).toBe('src/tasks/find.ts');
    expect(result?.canonicalName).toBe('findTasks');
  });

  it('returns null when barrel has no entry for name', () => {
    const barrelMap: BarrelExportMap = new Map([
      [
        'src/index.ts',
        new Map([['findTasks', { canonicalFile: 'src/tasks/find.ts', canonicalName: 'findTasks' }]]),
      ],
    ]);

    const result = resolveBarrelBinding('src/index.ts', 'unknownFn', barrelMap);
    expect(result).toBeNull();
  });

  it('returns null when barrel file not in map', () => {
    const barrelMap: BarrelExportMap = new Map();
    const result = resolveBarrelBinding('src/index.ts', 'findTasks', barrelMap);
    expect(result).toBeNull();
  });

  it('follows transitive chain: barrel A re-exports from barrel B which has canonical', () => {
    // src/index.ts → re-exports from src/tasks/index.ts
    // src/tasks/index.ts → re-exports findTasks from src/tasks/find.ts
    const barrelMap: BarrelExportMap = new Map([
      [
        'src/index.ts',
        new Map([
          ['findTasks', { canonicalFile: 'src/tasks/index.ts', canonicalName: 'findTasks' }],
        ]),
      ],
      [
        'src/tasks/index.ts',
        new Map([
          ['findTasks', { canonicalFile: 'src/tasks/find.ts', canonicalName: 'findTasks' }],
        ]),
      ],
    ]);

    const result = resolveBarrelBinding('src/index.ts', 'findTasks', barrelMap);
    expect(result).not.toBeNull();
    // Should follow chain to canonical file
    expect(result?.canonicalFile).toBe('src/tasks/find.ts');
    expect(result?.canonicalName).toBe('findTasks');
  });

  it('resolves wildcard re-export by returning candidate from wildcard source', () => {
    // src/index.ts does `export * from './tasks/find.ts'`
    const barrelMap: BarrelExportMap = new Map([
      [
        'src/index.ts',
        new Map([['*0', { canonicalFile: 'src/tasks/find.ts', canonicalName: '*' }]]),
      ],
    ]);

    const result = resolveBarrelBinding('src/index.ts', 'findTasks', barrelMap);
    expect(result).not.toBeNull();
    expect(result?.canonicalFile).toBe('src/tasks/find.ts');
    // canonicalName matches the requested name (wildcard passes it through)
    expect(result?.canonicalName).toBe('findTasks');
  });
});

// ---------------------------------------------------------------------------
// resolveCalls with barrel tracing (Tier 2a) tests
// ---------------------------------------------------------------------------

describe('resolveCalls — barrel tracing (T617)', () => {
  it('resolves call through barrel re-export at Tier 2a', async () => {
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();

    // findTasks is defined in src/tasks/find.ts
    symbolTable.add('src/tasks/find.ts', 'findTasks', 'src/tasks/find.ts::findTasks', 'function');

    // caller.ts imports { findTasks } from '@pkg/core' → resolves to src/index.ts (barrel)
    const namedImportMap: NamedImportMap = new Map([
      [
        'src/caller.ts',
        new Map([['findTasks', { sourcePath: 'src/index.ts', exportedName: 'findTasks' }]]),
      ],
    ]);

    // Barrel map: src/index.ts re-exports findTasks from src/tasks/find.ts
    const barrelMap: BarrelExportMap = new Map([
      [
        'src/index.ts',
        new Map([
          ['findTasks', { canonicalFile: 'src/tasks/find.ts', canonicalName: 'findTasks' }],
        ]),
      ],
    ]);

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/caller.ts',
        calledName: 'findTasks',
        sourceId: 'src/caller.ts::main',
        callForm: 'free',
      },
    ];

    const result = await resolveCalls(calls, graph, symbolTable, namedImportMap, barrelMap);

    // Should resolve at Tier 2a (import-scoped) by tracing through barrel
    expect(result.tier2aCount).toBe(1);
    expect(result.tier1Count).toBe(0);
    expect(result.unresolvedCount).toBe(0);

    const callsEdges = graph.relations.filter((r) => r.type === 'calls');
    expect(callsEdges).toHaveLength(1);
    expect(callsEdges[0]!.source).toBe('src/caller.ts::main');
    expect(callsEdges[0]!.target).toBe('src/tasks/find.ts::findTasks');
    expect(callsEdges[0]!.confidence).toBe(0.9);
  });

  it('resolves call through transitive barrel chain', async () => {
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();

    // endSession defined in packages/core/src/sessions/end.ts
    symbolTable.add(
      'packages/core/src/sessions/end.ts',
      'endSession',
      'packages/core/src/sessions/end.ts::endSession',
      'function',
    );

    // caller imports { endSession } from @cleocode/core → resolves to packages/core/src/index.ts
    const namedImportMap: NamedImportMap = new Map([
      [
        'packages/cleo/src/dispatch/engines/session-engine.ts',
        new Map([
          [
            'endSession',
            {
              sourcePath: 'packages/core/src/index.ts',
              exportedName: 'endSession',
            },
          ],
        ]),
      ],
    ]);

    // Transitive chain:
    // packages/core/src/index.ts → packages/core/src/sessions/index.ts → packages/core/src/sessions/end.ts
    const barrelMap: BarrelExportMap = new Map([
      [
        'packages/core/src/index.ts',
        new Map([
          [
            'endSession',
            {
              canonicalFile: 'packages/core/src/sessions/index.ts',
              canonicalName: 'endSession',
            },
          ],
        ]),
      ],
      [
        'packages/core/src/sessions/index.ts',
        new Map([
          [
            'endSession',
            {
              canonicalFile: 'packages/core/src/sessions/end.ts',
              canonicalName: 'endSession',
            },
          ],
        ]),
      ],
    ]);

    const calls: ExtractedCall[] = [
      {
        filePath: 'packages/cleo/src/dispatch/engines/session-engine.ts',
        calledName: 'endSession',
        sourceId: 'packages/cleo/src/dispatch/engines/session-engine.ts::handleEnd',
        callForm: 'free',
      },
    ];

    const result = await resolveCalls(calls, graph, symbolTable, namedImportMap, barrelMap);

    expect(result.tier2aCount).toBe(1);
    expect(result.unresolvedCount).toBe(0);

    const callsEdges = graph.relations.filter((r) => r.type === 'calls');
    expect(callsEdges).toHaveLength(1);
    expect(callsEdges[0]!.target).toBe('packages/core/src/sessions/end.ts::endSession');
  });

  it('falls back to Tier 1 when symbol is defined in same file even if barrel exists', async () => {
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();

    // helper defined in caller file (Tier 1)
    symbolTable.add('src/caller.ts', 'helper', 'src/caller.ts::helper', 'function');

    const namedImportMap: NamedImportMap = new Map();
    const barrelMap: BarrelExportMap = new Map();

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/caller.ts',
        calledName: 'helper',
        sourceId: 'src/caller.ts::main',
        callForm: 'free',
      },
    ];

    const result = await resolveCalls(calls, graph, symbolTable, namedImportMap, barrelMap);

    expect(result.tier1Count).toBe(1);
    expect(result.tier2aCount).toBe(0);
  });

  it('remains unresolved when barrel chain has no canonical definition in symbol table', async () => {
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();
    // Symbol NOT added to symbol table

    const namedImportMap: NamedImportMap = new Map([
      [
        'src/caller.ts',
        new Map([['ghostFn', { sourcePath: 'src/index.ts', exportedName: 'ghostFn' }]]),
      ],
    ]);

    const barrelMap: BarrelExportMap = new Map([
      [
        'src/index.ts',
        new Map([['ghostFn', { canonicalFile: 'src/impl/ghost.ts', canonicalName: 'ghostFn' }]]),
      ],
    ]);

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/caller.ts',
        calledName: 'ghostFn',
        sourceId: 'src/caller.ts::main',
        callForm: 'free',
      },
    ];

    const result = await resolveCalls(calls, graph, symbolTable, namedImportMap, barrelMap);

    // Symbol not in symbol table → unresolved even after barrel tracing
    expect(result.unresolvedCount).toBe(1);
    expect(result.tier2aCount).toBe(0);
    expect(graph.relations.filter((r) => r.type === 'calls')).toHaveLength(0);
  });

  it('backward-compatible: works with no barrelMap argument (default empty)', async () => {
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();
    const namedImportMap: NamedImportMap = new Map();

    symbolTable.add('src/foo.ts', 'doThing', 'src/foo.ts::doThing', 'function');

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/foo.ts',
        calledName: 'doThing',
        sourceId: 'src/foo.ts::run',
        callForm: 'free',
      },
    ];

    // No barrelMap argument — should still work as before
    const result = await resolveCalls(calls, graph, symbolTable, namedImportMap);

    expect(result.tier1Count).toBe(1);
    expect(result.unresolvedCount).toBe(0);
  });
});
