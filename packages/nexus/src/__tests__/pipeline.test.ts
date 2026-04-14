/**
 * Tests for the code intelligence ingestion pipeline.
 *
 * Covers:
 * - Language detection from file extensions
 * - Filesystem walker: exclusions, large file skipping, monorepo structure
 * - Structure processor: File/Folder node creation, CONTAINS edges
 * - KnowledgeGraph: deduplication, flush interface
 * - Pipeline entry point: runPipeline integration
 *
 * @task T532
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScannedFile } from '../pipeline/filesystem-walker.js';
import { walkRepositoryPaths } from '../pipeline/filesystem-walker.js';
import { runPipeline } from '../pipeline/index.js';
import { createKnowledgeGraph } from '../pipeline/knowledge-graph.js';
import { detectLanguageFromPath, isIndexableFile } from '../pipeline/language-detection.js';
import { processStructure } from '../pipeline/structure-processor.js';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/** Create a temporary directory that is cleaned up after each test. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'nexus-pipeline-test-'));
}

/** Write a file inside tmpDir (creates parent dirs automatically). */
function writeFile(root: string, relPath: string, content = 'x'): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

describe('detectLanguageFromPath', () => {
  it('detects TypeScript from .ts extension', () => {
    expect(detectLanguageFromPath('src/foo.ts')).toBe('typescript');
  });

  it('detects TypeScript from .tsx extension', () => {
    expect(detectLanguageFromPath('src/App.tsx')).toBe('typescript');
  });

  it('detects JavaScript from .js extension', () => {
    expect(detectLanguageFromPath('dist/index.js')).toBe('javascript');
  });

  it('detects Python from .py extension', () => {
    expect(detectLanguageFromPath('scripts/run.py')).toBe('python');
  });

  it('detects Go from .go extension', () => {
    expect(detectLanguageFromPath('main.go')).toBe('go');
  });

  it('detects Rust from .rs extension', () => {
    expect(detectLanguageFromPath('src/lib.rs')).toBe('rust');
  });

  it('detects JSON from .json extension', () => {
    expect(detectLanguageFromPath('package.json')).toBe('json');
  });

  it('returns null for unknown extensions', () => {
    expect(detectLanguageFromPath('binary.bin')).toBeNull();
    expect(detectLanguageFromPath('image.png')).toBeNull();
  });

  it('returns null for files without extension', () => {
    expect(detectLanguageFromPath('Makefile')).toBeNull();
    expect(detectLanguageFromPath('Dockerfile')).toBeNull();
  });

  it('is case-insensitive for extensions', () => {
    expect(detectLanguageFromPath('Foo.TS')).toBe('typescript');
    expect(detectLanguageFromPath('Bar.JS')).toBe('javascript');
  });
});

describe('isIndexableFile', () => {
  it('returns true for known source extensions', () => {
    expect(isIndexableFile('src/index.ts')).toBe(true);
    expect(isIndexableFile('main.py')).toBe(true);
    expect(isIndexableFile('README.md')).toBe(true);
  });

  it('returns false for unknown extensions', () => {
    expect(isIndexableFile('logo.png')).toBe(false);
    expect(isIndexableFile('data.bin')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Filesystem walker
// ---------------------------------------------------------------------------

describe('walkRepositoryPaths', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers files in nested directories', async () => {
    writeFile(tmpDir, 'src/index.ts');
    writeFile(tmpDir, 'src/utils/helpers.ts');
    writeFile(tmpDir, 'package.json');

    const files = await walkRepositoryPaths(tmpDir);
    const paths = files.map((f) => f.path).sort();

    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/utils/helpers.ts');
    expect(paths).toContain('package.json');
  });

  it('excludes node_modules directory', async () => {
    writeFile(tmpDir, 'src/index.ts');
    writeFile(tmpDir, 'node_modules/lodash/index.js');

    const files = await walkRepositoryPaths(tmpDir);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('src/index.ts');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('excludes dist directory', async () => {
    writeFile(tmpDir, 'src/index.ts');
    writeFile(tmpDir, 'dist/index.js');

    const files = await walkRepositoryPaths(tmpDir);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('src/index.ts');
    expect(paths.some((p) => p.includes('dist'))).toBe(false);
  });

  it('excludes .cleo directory', async () => {
    writeFile(tmpDir, 'src/index.ts');
    writeFile(tmpDir, '.cleo/tasks.db', 'binary');

    const files = await walkRepositoryPaths(tmpDir);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('src/index.ts');
    expect(paths.some((p) => p.includes('.cleo'))).toBe(false);
  });

  it('excludes .git directory', async () => {
    writeFile(tmpDir, 'src/index.ts');
    writeFile(tmpDir, '.git/HEAD', 'ref: refs/heads/main');

    const files = await walkRepositoryPaths(tmpDir);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('src/index.ts');
    expect(paths.some((p) => p.includes('.git'))).toBe(false);
  });

  it('skips files larger than 512KB', async () => {
    writeFile(tmpDir, 'small.ts', 'const x = 1;');
    // Write a file just over the 512KB limit
    const bigContent = 'a'.repeat(513 * 1024);
    writeFile(tmpDir, 'large.ts', bigContent);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const files = await walkRepositoryPaths(tmpDir);
    warnSpy.mockRestore();

    const paths = files.map((f) => f.path);
    expect(paths).toContain('small.ts');
    expect(paths).not.toContain('large.ts');
  });

  it('includes ScannedFile with language detection', async () => {
    writeFile(tmpDir, 'src/parser.ts', 'export const x = 1;');

    const files = await walkRepositoryPaths(tmpDir);
    const tsFile = files.find((f) => f.path === 'src/parser.ts');

    expect(tsFile).toBeDefined();
    expect(tsFile?.language).toBe('typescript');
    expect(tsFile?.size).toBeGreaterThan(0);
  });

  it('returns null language for unknown file types', async () => {
    writeFile(tmpDir, 'Makefile', '# make');

    const files = await walkRepositoryPaths(tmpDir);
    const makeFile = files.find((f) => f.path === 'Makefile');

    expect(makeFile).toBeDefined();
    expect(makeFile?.language).toBeNull();
  });

  it('calls onProgress for each processed file', async () => {
    writeFile(tmpDir, 'a.ts');
    writeFile(tmpDir, 'b.ts');

    const progressCalls: number[] = [];
    await walkRepositoryPaths(tmpDir, (current) => {
      progressCalls.push(current);
    });

    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it('excludes files matching .cleoignore patterns', async () => {
    writeFile(tmpDir, 'src/index.ts');
    writeFile(tmpDir, 'temp/build.tmp', 'temp');
    writeFile(tmpDir, 'src/config.local.json', 'config');
    // Create .cleoignore file with patterns
    writeFileSync(`${tmpDir}/.cleoignore`, 'temp/\n*.local.json\n');

    const files = await walkRepositoryPaths(tmpDir);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('src/index.ts');
    expect(paths).not.toContain('temp/build.tmp');
    expect(paths).not.toContain('src/config.local.json');
  });

  it('handles empty repository', async () => {
    const files = await walkRepositoryPaths(tmpDir);
    expect(files).toHaveLength(0);
  });

  it('scans 10,000 files in under 2 seconds', { timeout: 10000 }, async () => {
    // Create a directory structure with 10,000 empty TypeScript files
    // using a batched approach for efficiency
    const startTime = performance.now();

    // Create files in subdirectories to simulate realistic repo structure
    // 10 directories x 1000 files each
    for (let dir = 0; dir < 10; dir++) {
      for (let file = 0; file < 1000; file++) {
        const dirName = `src${dir}`;
        const fileName = `file${file}.ts`;
        const relPath = `${dirName}/${fileName}`;
        writeFile(tmpDir, relPath);
      }
    }

    const setupTime = performance.now() - startTime;

    // Now measure the walker performance
    const walkStart = performance.now();
    const files = await walkRepositoryPaths(tmpDir);
    const walkTime = performance.now() - walkStart;

    // Verify we got all 10,000 files
    expect(files).toHaveLength(10000);

    // Assert performance criterion: walker completes in under 2 seconds
    expect(walkTime).toBeLessThan(2000);

    // Log performance metrics for validation
    console.log(`  [T514-B] Setup: ${setupTime.toFixed(2)}ms, Walk: ${walkTime.toFixed(2)}ms`);
  });
});

// ---------------------------------------------------------------------------
// Structure processor
// ---------------------------------------------------------------------------

describe('processStructure', () => {
  it('creates File node for each scanned file', () => {
    const files: ScannedFile[] = [{ path: 'src/index.ts', size: 100, language: 'typescript' }];
    const graph = createKnowledgeGraph();
    processStructure(files, graph);

    expect(graph.nodes.has('src/index.ts')).toBe(true);
    const node = graph.nodes.get('src/index.ts')!;
    expect(node.kind).toBe('file');
    expect(node.name).toBe('index.ts');
    expect(node.language).toBe('typescript');
  });

  it('creates Folder nodes for intermediate directories', () => {
    const files: ScannedFile[] = [
      { path: 'packages/core/src/index.ts', size: 100, language: 'typescript' },
    ];
    const graph = createKnowledgeGraph();
    processStructure(files, graph);

    expect(graph.nodes.has('packages/')).toBe(true);
    expect(graph.nodes.has('packages/core/')).toBe(true);
    expect(graph.nodes.has('packages/core/src/')).toBe(true);
    expect(graph.nodes.has('packages/core/src/index.ts')).toBe(true);
  });

  it('creates CONTAINS edges between parent folder and child', () => {
    const files: ScannedFile[] = [{ path: 'src/index.ts', size: 50, language: 'typescript' }];
    const graph = createKnowledgeGraph();
    processStructure(files, graph);

    const containsEdges = graph.relations.filter(
      (r) => r.source === 'src/' && r.target === 'src/index.ts' && r.type === 'contains',
    );
    expect(containsEdges).toHaveLength(1);
    expect(containsEdges[0]!.confidence).toBe(1.0);
  });

  it('deduplicates shared parent folders across multiple files', () => {
    const files: ScannedFile[] = [
      { path: 'src/a.ts', size: 10, language: 'typescript' },
      { path: 'src/b.ts', size: 10, language: 'typescript' },
    ];
    const graph = createKnowledgeGraph();
    processStructure(files, graph);

    // 'src/' folder should appear only once despite two children
    const srcNodes = [...graph.nodes.values()].filter((n) => n.id === 'src/');
    expect(srcNodes).toHaveLength(1);
  });

  it('uses "unknown" language for files with null language', () => {
    const files: ScannedFile[] = [{ path: 'Makefile', size: 200, language: null }];
    const graph = createKnowledgeGraph();
    processStructure(files, graph);

    const node = graph.nodes.get('Makefile')!;
    expect(node.language).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// KnowledgeGraph
// ---------------------------------------------------------------------------

describe('createKnowledgeGraph', () => {
  it('starts empty', () => {
    const graph = createKnowledgeGraph();
    expect(graph.nodes.size).toBe(0);
    expect(graph.relations).toHaveLength(0);
  });

  it('deduplicates nodes by ID', () => {
    const graph = createKnowledgeGraph();
    const node = {
      id: 'src/index.ts',
      kind: 'file' as const,
      name: 'index.ts',
      filePath: 'src/index.ts',
      startLine: 1,
      endLine: 1,
      language: 'typescript',
      exported: false,
    };
    graph.addNode(node);
    graph.addNode({ ...node, name: 'different' }); // should be ignored
    expect(graph.nodes.size).toBe(1);
    expect(graph.nodes.get('src/index.ts')!.name).toBe('index.ts');
  });

  it('deduplicates relations by source + target + type', () => {
    const graph = createKnowledgeGraph();
    const rel = {
      source: 'src/',
      target: 'src/index.ts',
      type: 'contains' as const,
      confidence: 1.0,
    };
    graph.addRelation(rel);
    graph.addRelation(rel);
    expect(graph.relations).toHaveLength(1);
  });

  it('flush calls db.insert with nodes and relations', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'src/foo.ts',
      kind: 'file',
      name: 'foo.ts',
      filePath: 'src/foo.ts',
      startLine: 1,
      endLine: 1,
      language: 'typescript',
      exported: false,
    });
    graph.addRelation({
      source: 'src/',
      target: 'src/foo.ts',
      type: 'contains',
      confidence: 1.0,
    });

    const insertedRows: unknown[][] = [];
    const mockOnConflict = { onConflictDoNothing: () => Promise.resolve() };
    const mockDb = {
      insert: (_table: unknown) => ({
        values: (rows: unknown[]) => {
          insertedRows.push(rows);
          return mockOnConflict;
        },
      }),
    };

    await graph.flush('project-abc', mockDb, {
      nexusNodes: 'nodes-table',
      nexusRelations: 'relations-table',
    });

    // Both nodes and relations should have been inserted
    expect(insertedRows.length).toBeGreaterThanOrEqual(2);
    // First insert batch should contain the file node
    const nodeRows = insertedRows[0] as Array<{ id: string; kind: string }>;
    expect(nodeRows.some((r) => r.id === 'src/foo.ts' && r.kind === 'file')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runPipeline integration
// ---------------------------------------------------------------------------

describe('runPipeline', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns counts from a simple repository', async () => {
    writeFile(tmpDir, 'src/index.ts', 'export const x = 1;');
    writeFile(tmpDir, 'src/utils/helpers.ts', 'export function help() {}');
    writeFile(tmpDir, 'package.json', '{}');

    const insertedRows: unknown[][] = [];
    const mockOnConflict = { onConflictDoNothing: () => Promise.resolve() };
    const mockDb = {
      insert: (_table: unknown) => ({
        values: (rows: unknown[]) => {
          insertedRows.push(rows);
          return mockOnConflict;
        },
      }),
    };

    const result = await runPipeline(tmpDir, 'proj-1', mockDb, {
      nexusNodes: 'nodes',
      nexusRelations: 'relations',
    });

    expect(result.fileCount).toBe(3);
    // Nodes: src/, src/index.ts, src/utils/, src/utils/helpers.ts, package.json = 5
    expect(result.nodeCount).toBeGreaterThanOrEqual(5);
    // CONTAINS edges: src/→src/index.ts, src/→src/utils/, src/utils/→src/utils/helpers.ts
    expect(result.relationCount).toBeGreaterThanOrEqual(3);
  });

  it('excludes node_modules from pipeline result', async () => {
    writeFile(tmpDir, 'src/index.ts', 'export const x = 1;');
    writeFile(tmpDir, 'node_modules/pkg/index.js', 'module.exports = {}');

    const mockOnConflict = { onConflictDoNothing: () => Promise.resolve() };
    const mockDb = {
      insert: (_table: unknown) => ({
        values: (_rows: unknown[]) => mockOnConflict,
      }),
    };

    const result = await runPipeline(tmpDir, 'proj-2', mockDb, {
      nexusNodes: 'nodes',
      nexusRelations: 'relations',
    });

    expect(result.fileCount).toBe(1);
    expect(result.nodeCount).toBe(2); // src/ + src/index.ts
  });

  it('handles empty repository', async () => {
    const mockOnConflict = { onConflictDoNothing: () => Promise.resolve() };
    const mockDb = {
      insert: (_table: unknown) => ({
        values: (_rows: unknown[]) => mockOnConflict,
      }),
    };

    const result = await runPipeline(tmpDir, 'proj-3', mockDb, {
      nexusNodes: 'nodes',
      nexusRelations: 'relations',
    });

    expect(result.fileCount).toBe(0);
    expect(result.nodeCount).toBe(0);
    expect(result.relationCount).toBe(0);
  });
});
