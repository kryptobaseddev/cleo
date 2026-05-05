/**
 * Extractor regression tests — fixture-based snapshot suite.
 *
 * Each existing language extractor (TypeScript, Python, Go, Rust) is exercised
 * against a pinned fixture file located at:
 *
 *   packages/nexus/src/__tests__/fixtures/<lang>/sample.<ext>
 *
 * The tests assert:
 * 1. Total definition count (by kind) — ZERO tolerance drop
 * 2. Explicit import edge count — ZERO tolerance drop
 * 3. Heritage edge count — ZERO tolerance drop
 *
 * HOW TO UPDATE SNAPSHOTS
 * -----------------------
 * If an extractor improvement legitimately increases counts, re-run this suite
 * with `CLEO_UPDATE_EXTRACTOR_SNAPSHOTS=1 pnpm run test` and then commit the
 * updated snapshot values in this file.
 *
 * DO NOT decrease a snapshot value without a deliberate, reviewed decision.
 * Any count decrease fails CI (regression gate).
 *
 * @task T1841
 * @module __tests__/extractor-regression
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGo } from '../pipeline/extractors/go-extractor.js';
import { extractJava } from '../pipeline/extractors/java-extractor.js';
import { extractPython } from '../pipeline/extractors/python-extractor.js';
import { extractRust } from '../pipeline/extractors/rust-extractor.js';
import { extractTypeScript } from '../pipeline/extractors/typescript-extractor.js';
import { processHeritage } from '../pipeline/heritage-processor.js';
import { buildImportResolutionContext } from '../pipeline/import-processor.js';
import { createKnowledgeGraph } from '../pipeline/knowledge-graph.js';
import { runParseLoop } from '../pipeline/parse-loop.js';
import { extractAccesses } from '../pipeline/processors/access-processor.js';
import { createResolutionContext } from '../pipeline/resolution-context.js';
import { createSymbolTable } from '../pipeline/symbol-table.js';

// ---------------------------------------------------------------------------
// Tree-sitter loading
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

type NativeParser = {
  setLanguage(lang: unknown): void;
  parse(source: string): { rootNode: unknown };
};
type ParserConstructor = new () => NativeParser;

let ParserClass: ParserConstructor | null = null;

try {
  ParserClass = _require('tree-sitter') as ParserConstructor;
} catch {
  // parser unavailable in this environment — tests will be skipped
}

function loadGrammar(pkg: string, prop?: string): unknown | null {
  try {
    const mod = _require(pkg) as Record<string, unknown>;
    return prop ? (mod[prop] ?? null) : mod;
  } catch {
    return null;
  }
}

function parseSource(source: string, grammar: unknown): unknown | null {
  if (!ParserClass || !grammar) return null;
  try {
    const parser = new ParserClass();
    parser.setLanguage(grammar);
    return parser.parse(source).rootNode;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count definitions by kind, safely avoiding the 'constructor' key collision. */
function countByKind(defs: Array<{ kind: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of defs) {
    counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
  }
  return counts;
}

/** Assert that the actual count meets or exceeds the snapshot floor. */
function assertFloor(label: string, actual: number, floor: number): void {
  expect(
    actual,
    `REGRESSION: ${label} dropped from snapshot floor ${floor} to ${actual}`,
  ).toBeGreaterThanOrEqual(floor);
}

// ---------------------------------------------------------------------------
// v1 Snapshots — captured 2026-05-04 from fixture files at this commit.
// Update deliberately with CLEO_UPDATE_EXTRACTOR_SNAPSHOTS=1.
// ---------------------------------------------------------------------------

/**
 * Snapshot floor values for the TypeScript extractor.
 * Fixture: packages/nexus/src/__tests__/fixtures/typescript/sample.ts
 *
 * Updated by T1846:
 *   - UserRepository.toJSON() override added to fixture (+1 method)
 *   - extractHeritage bug fixed: nested class_heritage now traversed (+4 heritage)
 */
const TS_SNAPSHOT = {
  total: 31,
  byKind: new Map<string, number>([
    ['enum', 1],
    ['type', 1],
    ['interface', 2],
    ['class', 4],
    ['property', 5],
    ['constructor', 3],
    ['method', 12],
    ['function', 3],
  ]),
  imports: 3,
  heritage: 4,
} as const;

/**
 * Snapshot floor values for the Python extractor.
 * Fixture: packages/nexus/src/__tests__/fixtures/python/sample.py
 */
const PY_SNAPSHOT = {
  total: 24,
  byKind: new Map<string, number>([
    ['function', 3],
    ['class', 5],
    ['constructor', 5],
    ['method', 11],
  ]),
  imports: 7,
  heritage: 3,
} as const;

/**
 * Snapshot floor values for the Go extractor.
 * Fixture: packages/nexus/src/__tests__/fixtures/go/sample.go
 */
const GO_SNAPSHOT = {
  total: 34,
  byKind: new Map<string, number>([
    ['type_alias', 1],
    ['interface', 2],
    ['struct', 5],
    ['property', 9],
    ['method', 12],
    ['function', 5],
  ]),
  imports: 5,
  heritage: 2,
} as const;

/**
 * Snapshot floor values for the Rust extractor.
 * Fixture: packages/nexus/src/__tests__/fixtures/rust/sample.rs
 */
const RUST_SNAPSHOT = {
  total: 53,
  byKind: new Map<string, number>([
    ['type_alias', 1],
    ['constant', 1],
    ['static', 1],
    ['enum', 1],
    ['impl', 9],
    ['method', 14],
    ['trait', 2],
    ['struct', 5],
    ['property', 9],
    ['constructor', 5],
    ['function', 4],
    ['module', 1],
  ]),
  imports: 8,
  heritage: 4,
} as const;

/**
 * Snapshot floor values for the Java extractor (via LanguageConfig / generic-extractor).
 * Fixture: packages/nexus/src/__tests__/fixtures/java/sample.java
 *
 * Captured 2026-05-05 as part of T1861 (LanguageConfig pattern port, Java demo).
 * Fixture: 6 classes/interfaces/enum, 22 methods, 5 constructors, 6 imports, 5 heritage edges.
 */
const JAVA_SNAPSHOT = {
  total: 35,
  byKind: new Map<string, number>([
    ['interface', 2],
    ['class', 5],
    ['enum', 1],
    ['method', 22],
    ['constructor', 5],
  ]),
  imports: 6,
  heritage: 5,
} as const;

// ---------------------------------------------------------------------------
// TypeScript extractor regression
// ---------------------------------------------------------------------------

describe('TypeScript extractor regression (fixture snapshot)', () => {
  let grammar: unknown | null = null;
  let source: string;

  beforeAll(() => {
    grammar = loadGrammar('tree-sitter-typescript', 'typescript');
    source = readFileSync(join(__dirname, 'fixtures/typescript/sample.ts'), 'utf8');
  });

  it('skips gracefully when tree-sitter is unavailable', () => {
    if (!ParserClass || !grammar) {
      // Not a failure — CI without native modules is acceptable.
      return;
    }
    expect(true).toBe(true);
  });

  it('total definition count meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractTypeScript(root, 'fixtures/typescript/sample.ts', 'typescript');
    assertFloor('TypeScript total definitions', result.definitions.length, TS_SNAPSHOT.total);
  });

  it('definition count by kind meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractTypeScript(root, 'fixtures/typescript/sample.ts', 'typescript');
    const counts = countByKind(result.definitions);

    for (const [kind, floor] of TS_SNAPSHOT.byKind) {
      assertFloor(`TypeScript kind '${kind}'`, counts.get(kind) ?? 0, floor);
    }
  });

  it('explicit import count meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractTypeScript(root, 'fixtures/typescript/sample.ts', 'typescript');
    assertFloor('TypeScript imports', result.imports.length, TS_SNAPSHOT.imports);
  });

  it('heritage edge count meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractTypeScript(root, 'fixtures/typescript/sample.ts', 'typescript');
    assertFloor('TypeScript heritage', result.heritage.length, TS_SNAPSHOT.heritage);
  });
});

// ---------------------------------------------------------------------------
// Python extractor regression
// ---------------------------------------------------------------------------

describe('Python extractor regression (fixture snapshot)', () => {
  let grammar: unknown | null = null;
  let source: string;

  beforeAll(() => {
    grammar = loadGrammar('tree-sitter-python');
    source = readFileSync(join(__dirname, 'fixtures/python/sample.py'), 'utf8');
  });

  it('skips gracefully when tree-sitter is unavailable', () => {
    if (!ParserClass || !grammar) return;
    expect(true).toBe(true);
  });

  it('total definition count meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractPython(root, 'fixtures/python/sample.py');
    assertFloor('Python total definitions', result.definitions.length, PY_SNAPSHOT.total);
  });

  it('definition count by kind meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractPython(root, 'fixtures/python/sample.py');
    const counts = countByKind(result.definitions);

    for (const [kind, floor] of PY_SNAPSHOT.byKind) {
      assertFloor(`Python kind '${kind}'`, counts.get(kind) ?? 0, floor);
    }
  });

  it('explicit import count meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractPython(root, 'fixtures/python/sample.py');
    assertFloor('Python imports', result.imports.length, PY_SNAPSHOT.imports);
  });

  it('heritage edge count meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractPython(root, 'fixtures/python/sample.py');
    assertFloor('Python heritage', result.heritage.length, PY_SNAPSHOT.heritage);
  });
});

// ---------------------------------------------------------------------------
// Go extractor regression
// ---------------------------------------------------------------------------

describe('Go extractor regression (fixture snapshot)', () => {
  let grammar: unknown | null = null;
  let source: string;

  beforeAll(() => {
    grammar = loadGrammar('tree-sitter-go');
    source = readFileSync(join(__dirname, 'fixtures/go/sample.go'), 'utf8');
  });

  it('skips gracefully when tree-sitter is unavailable', () => {
    if (!ParserClass || !grammar) return;
    expect(true).toBe(true);
  });

  it('total definition count meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractGo(root, 'fixtures/go/sample.go');
    assertFloor('Go total definitions', result.definitions.length, GO_SNAPSHOT.total);
  });

  it('definition count by kind meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractGo(root, 'fixtures/go/sample.go');
    const counts = countByKind(result.definitions);

    for (const [kind, floor] of GO_SNAPSHOT.byKind) {
      assertFloor(`Go kind '${kind}'`, counts.get(kind) ?? 0, floor);
    }
  });

  it('explicit import count meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractGo(root, 'fixtures/go/sample.go');
    assertFloor('Go imports', result.imports.length, GO_SNAPSHOT.imports);
  });

  it('heritage edge count (struct embeddings) meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractGo(root, 'fixtures/go/sample.go');
    assertFloor('Go heritage (struct embeddings)', result.heritage.length, GO_SNAPSHOT.heritage);
  });
});

// ---------------------------------------------------------------------------
// Rust extractor regression
// ---------------------------------------------------------------------------

describe('Rust extractor regression (fixture snapshot)', () => {
  let grammar: unknown | null = null;
  let source: string;

  beforeAll(() => {
    grammar = loadGrammar('tree-sitter-rust');
    source = readFileSync(join(__dirname, 'fixtures/rust/sample.rs'), 'utf8');
  });

  it('skips gracefully when tree-sitter is unavailable', () => {
    if (!ParserClass || !grammar) return;
    expect(true).toBe(true);
  });

  it('total definition count meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractRust(root, 'fixtures/rust/sample.rs');
    assertFloor('Rust total definitions', result.definitions.length, RUST_SNAPSHOT.total);
  });

  it('definition count by kind meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractRust(root, 'fixtures/rust/sample.rs');
    const counts = countByKind(result.definitions);

    for (const [kind, floor] of RUST_SNAPSHOT.byKind) {
      assertFloor(`Rust kind '${kind}'`, counts.get(kind) ?? 0, floor);
    }
  });

  it('explicit import (use) count meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractRust(root, 'fixtures/rust/sample.rs');
    assertFloor('Rust imports', result.imports.length, RUST_SNAPSHOT.imports);
  });

  it('heritage edge count (trait impls) meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractRust(root, 'fixtures/rust/sample.rs');
    assertFloor('Rust heritage (trait impls)', result.heritage.length, RUST_SNAPSHOT.heritage);
  });
});

// ---------------------------------------------------------------------------
// DEFINES edge regression — parse-loop emits file→symbol edges (T1836)
// ---------------------------------------------------------------------------

/**
 * Snapshot floor for DEFINES edges emitted by the TypeScript parse loop.
 * The TypeScript fixture declares 30 symbols — each eligible kind gets
 * one defines edge from its file node.  Floor is set conservatively at the
 * total definition count from TS_SNAPSHOT so any future extractor improvement
 * can only increase it.
 */
const DEFINES_FLOOR = TS_SNAPSHOT.total; // 30

describe('DEFINES edges regression (parse-loop, T1836)', () => {
  let tmpRepo: string;

  beforeAll(() => {
    // Create a minimal temp repo with just the TypeScript fixture
    tmpRepo = mkdtempSync(join(tmpdir(), 'nexus-defines-test-'));
    const fixtureDir = join(tmpRepo, 'fixtures', 'typescript');
    mkdirSync(fixtureDir, { recursive: true });
    copyFileSync(join(__dirname, 'fixtures/typescript/sample.ts'), join(fixtureDir, 'sample.ts'));
  });

  afterAll(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it('skips gracefully when tree-sitter is unavailable', () => {
    if (!ParserClass) return;
    expect(true).toBe(true);
  });

  it('defines edge count meets snapshot floor after runParseLoop', async () => {
    if (!ParserClass) return;

    const fixturePath = 'fixtures/typescript/sample.ts';
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();
    const importCtx = buildImportResolutionContext([fixturePath]);

    const scannedFiles = [{ path: fixturePath, size: 0, language: 'typescript' }];

    await runParseLoop(scannedFiles, graph, symbolTable, importCtx, tmpRepo);

    const definesEdges = graph.relations.filter((r) => r.type === 'defines');

    assertFloor('DEFINES edge count (TypeScript fixture)', definesEdges.length, DEFINES_FLOOR);
  });

  it('defines edges have correct source (file node) and target (symbol node)', async () => {
    if (!ParserClass) return;

    const fixturePath = 'fixtures/typescript/sample.ts';
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();
    const importCtx = buildImportResolutionContext([fixturePath]);

    const scannedFiles = [{ path: fixturePath, size: 0, language: 'typescript' }];

    await runParseLoop(scannedFiles, graph, symbolTable, importCtx, tmpRepo);

    const definesEdges = graph.relations.filter((r) => r.type === 'defines');

    // Every defines edge must originate from the file node
    for (const edge of definesEdges) {
      expect(edge.source).toBe(fixturePath);
      // Target must exist as a graph node
      expect(graph.nodes.has(edge.target)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Confidence label regression (T1862)
//
// Asserts that >70% of edges emitted by the parse-loop carry
// confidenceLabel === 'EXTRACTED'. Edges emitted at confidence ≥ 0.90 (defines,
// imports, has_method, has_property, same-file calls) qualify.
//
// The TypeScript fixture generates mostly defines edges (confidence 1.0) so
// the floor is conservative at 70%. Any shift toward AMBIGUOUS/INFERRED would
// indicate a regression in label annotation coverage.
// ---------------------------------------------------------------------------

describe('Confidence label regression — parse-loop edges (T1862)', () => {
  let tmpRepo: string;

  beforeAll(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'nexus-confidence-label-test-'));
    const fixtureDir = join(tmpRepo, 'fixtures', 'typescript');
    mkdirSync(fixtureDir, { recursive: true });
    copyFileSync(join(__dirname, 'fixtures/typescript/sample.ts'), join(fixtureDir, 'sample.ts'));
  });

  afterAll(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it('skips gracefully when tree-sitter is unavailable', () => {
    if (!ParserClass) return;
    expect(true).toBe(true);
  });

  it('>70% of emitted edges carry confidenceLabel EXTRACTED', async () => {
    if (!ParserClass) return;

    const fixturePath = 'fixtures/typescript/sample.ts';
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();
    const importCtx = buildImportResolutionContext([fixturePath]);

    const scannedFiles = [{ path: fixturePath, size: 0, language: 'typescript' }];

    await runParseLoop(scannedFiles, graph, symbolTable, importCtx, tmpRepo);

    const allEdges = graph.relations;
    // All edges emitted by the parse-loop MUST have a confidenceLabel
    const labelledEdges = allEdges.filter((r) => r.confidenceLabel !== undefined);
    assertFloor(
      'labelled edges (all parse-loop edges must carry confidenceLabel)',
      labelledEdges.length,
      allEdges.length,
    );

    // >70% must be EXTRACTED
    const extractedEdges = allEdges.filter((r) => r.confidenceLabel === 'EXTRACTED');
    const ratio = allEdges.length > 0 ? extractedEdges.length / allEdges.length : 0;
    expect(
      ratio,
      `Expected >70% EXTRACTED edges, got ${Math.round(ratio * 100)}% (${extractedEdges.length}/${allEdges.length})`,
    ).toBeGreaterThan(0.7);
  });

  it('all defines edges carry confidenceLabel EXTRACTED', async () => {
    if (!ParserClass) return;

    const fixturePath = 'fixtures/typescript/sample.ts';
    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();
    const importCtx = buildImportResolutionContext([fixturePath]);

    const scannedFiles = [{ path: fixturePath, size: 0, language: 'typescript' }];

    await runParseLoop(scannedFiles, graph, symbolTable, importCtx, tmpRepo);

    const definesEdges = graph.relations.filter((r) => r.type === 'defines');
    assertFloor('defines edge count', definesEdges.length, 1);

    for (const edge of definesEdges) {
      expect(
        edge.confidenceLabel,
        `defines edge ${edge.source}→${edge.target} missing confidenceLabel`,
      ).toBe('EXTRACTED');
    }
  });
});

// ---------------------------------------------------------------------------
// Access extractor regression (T1837)
//
// Asserts that extractAccesses() emits ACCESSES > 0 for TypeScript and Python
// fixtures. These are snapshot floors (not exact counts) — any increase is
// acceptable; a drop to 0 is a regression.
// ---------------------------------------------------------------------------

describe('Access extractor regression — TypeScript fixture (T1837)', () => {
  let grammar: unknown | null = null;
  let source: string;

  beforeAll(() => {
    grammar = loadGrammar('tree-sitter-typescript', 'typescript');
    source = readFileSync(join(__dirname, 'fixtures/typescript/sample.ts'), 'utf8');
  });

  it('skips gracefully when tree-sitter is unavailable', () => {
    if (!ParserClass || !grammar) return;
    expect(true).toBe(true);
  });

  it('extracts at least 1 ACCESSES record from the TypeScript fixture', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    // biome-ignore lint/suspicious/noExplicitAny: tree-sitter rootNode has no shared TS type
    const accesses = extractAccesses(root as any, 'fixtures/typescript/sample.ts');
    assertFloor('TypeScript ACCESSES count', accesses.length, 1);
  });

  it('all TypeScript access records have a valid accessMode', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    // biome-ignore lint/suspicious/noExplicitAny: tree-sitter rootNode has no shared TS type
    const accesses = extractAccesses(root as any, 'fixtures/typescript/sample.ts');
    const validModes = new Set(['read', 'write', 'readwrite']);
    for (const acc of accesses) {
      expect(
        validModes.has(acc.accessMode),
        `Expected accessMode to be 'read'|'write'|'readwrite', got '${acc.accessMode}'`,
      ).toBe(true);
    }
  });

  it('TypeScript fixture contains at least one write-mode access', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    // biome-ignore lint/suspicious/noExplicitAny: tree-sitter rootNode has no shared TS type
    const accesses = extractAccesses(root as any, 'fixtures/typescript/sample.ts');
    const writtenAccesses = accesses.filter(
      (a) => a.accessMode === 'write' || a.accessMode === 'readwrite',
    );
    assertFloor('TypeScript write-mode ACCESSES count', writtenAccesses.length, 1);
  });
});

describe('Access extractor regression — Python fixture (T1837)', () => {
  let grammar: unknown | null = null;
  let source: string;

  beforeAll(() => {
    grammar = loadGrammar('tree-sitter-python');
    source = readFileSync(join(__dirname, 'fixtures/python/sample.py'), 'utf8');
  });

  it('skips gracefully when tree-sitter is unavailable', () => {
    if (!ParserClass || !grammar) return;
    expect(true).toBe(true);
  });

  it('extracts at least 1 ACCESSES record from the Python fixture', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    // biome-ignore lint/suspicious/noExplicitAny: tree-sitter rootNode has no shared TS type
    const accesses = extractAccesses(root as any, 'fixtures/python/sample.py');
    assertFloor('Python ACCESSES count', accesses.length, 1);
  });

  it('all Python access records have a valid accessMode', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    // biome-ignore lint/suspicious/noExplicitAny: tree-sitter rootNode has no shared TS type
    const accesses = extractAccesses(root as any, 'fixtures/python/sample.py');
    const validModes = new Set(['read', 'write', 'readwrite']);
    for (const acc of accesses) {
      expect(
        validModes.has(acc.accessMode),
        `Expected accessMode to be 'read'|'write'|'readwrite', got '${acc.accessMode}'`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// METHOD_OVERRIDES edge regression (T1846)
//
// Asserts that processHeritage() emits method_overrides edges when a subclass
// declares a method with the same name as a parent class method.
//
// The TypeScript fixture has UserRepository extends BaseRepository, and
// UserRepository.toJSON() overrides BaseRepository.toJSON() — guaranteeing
// at least 1 method_overrides edge on the fixture.
// ---------------------------------------------------------------------------

describe('METHOD_OVERRIDES edges regression (heritage-processor, T1846)', () => {
  let tmpRepo: string;

  beforeAll(() => {
    // Create a minimal temp repo with just the TypeScript fixture
    tmpRepo = mkdtempSync(join(tmpdir(), 'nexus-method-overrides-test-'));
    const fixtureDir = join(tmpRepo, 'fixtures', 'typescript');
    mkdirSync(fixtureDir, { recursive: true });
    copyFileSync(join(__dirname, 'fixtures/typescript/sample.ts'), join(fixtureDir, 'sample.ts'));
  });

  afterAll(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it('skips gracefully when tree-sitter is unavailable', () => {
    if (!ParserClass) return;
    expect(true).toBe(true);
  });

  it('emits at least 1 method_overrides edge from TypeScript fixture with class hierarchy', async () => {
    if (!ParserClass) return;

    const fixturePath = 'fixtures/typescript/sample.ts';
    const graph = createKnowledgeGraph();
    // Wire the symbol table through the ResolutionContext so processHeritage
    // can resolve class names during method-override detection.
    const resolutionCtx = createResolutionContext();
    const symbolTable = resolutionCtx.symbols;
    const importCtx = buildImportResolutionContext([fixturePath]);

    const scannedFiles = [{ path: fixturePath, size: 0, language: 'typescript' }];

    const { allHeritage } = await runParseLoop(
      scannedFiles,
      graph,
      symbolTable,
      importCtx,
      tmpRepo,
    );

    // Phase 3c: emit EXTENDS / IMPLEMENTS + METHOD_OVERRIDES
    const result = processHeritage(allHeritage, graph, resolutionCtx);

    const methodOverridesEdges = graph.relations.filter((r) => r.type === 'method_overrides');

    assertFloor('METHOD_OVERRIDES edge count (TypeScript fixture)', methodOverridesEdges.length, 1);

    // The HeritageProcessingResult must also report a non-zero count
    assertFloor('methodOverridesCount in HeritageProcessingResult', result.methodOverridesCount, 1);
  });

  it('method_overrides edges carry confidenceLabel EXTRACTED', async () => {
    if (!ParserClass) return;

    const fixturePath = 'fixtures/typescript/sample.ts';
    const graph = createKnowledgeGraph();
    const resolutionCtx = createResolutionContext();
    const symbolTable = resolutionCtx.symbols;
    const importCtx = buildImportResolutionContext([fixturePath]);

    const scannedFiles = [{ path: fixturePath, size: 0, language: 'typescript' }];

    const { allHeritage } = await runParseLoop(
      scannedFiles,
      graph,
      symbolTable,
      importCtx,
      tmpRepo,
    );

    processHeritage(allHeritage, graph, resolutionCtx);

    const methodOverridesEdges = graph.relations.filter((r) => r.type === 'method_overrides');

    // Skip if no overrides found (tree-sitter may not produce heritage in this env)
    if (methodOverridesEdges.length === 0) return;

    for (const edge of methodOverridesEdges) {
      expect(
        edge.confidenceLabel,
        `method_overrides edge ${edge.source}→${edge.target} missing confidenceLabel`,
      ).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Java extractor regression (T1861 — LanguageConfig / generic-extractor demo)
// ---------------------------------------------------------------------------

describe('Java extractor regression (fixture snapshot, T1861)', () => {
  let grammar: unknown | null = null;
  let source: string;

  beforeAll(() => {
    grammar = loadGrammar('tree-sitter-java');
    source = readFileSync(join(__dirname, 'fixtures/java/sample.java'), 'utf8');
  });

  it('skips gracefully when tree-sitter is unavailable', () => {
    if (!ParserClass || !grammar) return;
    expect(true).toBe(true);
  });

  it('total definition count meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractJava(root, 'fixtures/java/sample.java');
    assertFloor('Java total definitions', result.definitions.length, JAVA_SNAPSHOT.total);
  });

  it('definition count by kind meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractJava(root, 'fixtures/java/sample.java');
    const counts = countByKind(result.definitions);

    for (const [kind, floor] of JAVA_SNAPSHOT.byKind) {
      assertFloor(`Java kind '${kind}'`, counts.get(kind) ?? 0, floor);
    }
  });

  it('explicit import count meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractJava(root, 'fixtures/java/sample.java');
    assertFloor('Java imports', result.imports.length, JAVA_SNAPSHOT.imports);
  });

  it('heritage edge count (extends / implements) meets snapshot floor', () => {
    if (!ParserClass || !grammar) return;
    const root = parseSource(source, grammar);
    if (!root) return;

    const result = extractJava(root, 'fixtures/java/sample.java');
    assertFloor(
      'Java heritage (extends/implements)',
      result.heritage.length,
      JAVA_SNAPSHOT.heritage,
    );
  });
});
