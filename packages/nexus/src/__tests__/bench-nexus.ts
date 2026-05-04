/**
 * pnpm bench:nexus — Extractor parity benchmark.
 *
 * Runs the four language extractors (TypeScript, Python, Go, Rust) against
 * the pinned fixture files and emits a machine-readable JSON summary comparing
 * actual counts against the v1 snapshot baselines.
 *
 * Output format (stdout, JSON):
 * {
 *   "timestamp": "2026-05-04T...",
 *   "treeParserAvailable": true,
 *   "extractors": {
 *     "typescript": { "definitions": 30, "imports": 3, "heritage": 0, "delta": {...} },
 *     "python":     { ... },
 *     "go":         { ... },
 *     "rust":       { ... }
 *   },
 *   "parity": {
 *     "allMeetFloor": true,
 *     "violations": []
 *   }
 * }
 *
 * Exit code 0 = all parity floors met.
 * Exit code 1 = one or more parity violations (use as CI gate).
 *
 * Usage:
 *   pnpm --filter @cleocode/nexus run bench:nexus
 *
 * @task T1841
 * @module __tests__/bench-nexus
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractGo } from '../pipeline/extractors/go-extractor.js';
import { extractPython } from '../pipeline/extractors/python-extractor.js';
import { extractRust } from '../pipeline/extractors/rust-extractor.js';
import { extractTypeScript } from '../pipeline/extractors/typescript-extractor.js';

const _require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// Snapshot baselines (must match extractor-regression.test.ts)
// ---------------------------------------------------------------------------

const BASELINES = {
  typescript: { total: 30, imports: 3, heritage: 0 },
  python: { total: 24, imports: 7, heritage: 3 },
  go: { total: 34, imports: 5, heritage: 2 },
  rust: { total: 53, imports: 8, heritage: 4 },
} as const;

// ---------------------------------------------------------------------------
// Tree-sitter loading
// ---------------------------------------------------------------------------

type NativeParser = {
  setLanguage(lang: unknown): void;
  parse(source: string): { rootNode: unknown };
};
type ParserConstructor = new () => NativeParser;

let ParserClass: ParserConstructor | null = null;

try {
  ParserClass = _require('tree-sitter') as ParserConstructor;
} catch {
  // unavailable
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
// Count helpers
// ---------------------------------------------------------------------------

function countByKind(defs: Array<{ kind: string }>): Record<string, number> {
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const d of defs) {
    counts[d.kind] = (counts[d.kind] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface ExtractorResult {
  /** Total definition count. */
  definitions: number;
  /** Definition count broken down by kind. */
  byKind: Record<string, number>;
  /** Explicit import count. */
  imports: number;
  /** Heritage edge count. */
  heritage: number;
  /** Delta vs baseline (positive = improvement, negative = regression). */
  delta: {
    definitions: number;
    imports: number;
    heritage: number;
  };
  /** Whether the parser was available for this language. */
  parserAvailable: boolean;
}

interface BenchOutput {
  timestamp: string;
  treeParserAvailable: boolean;
  extractors: Record<string, ExtractorResult>;
  parity: {
    allMeetFloor: boolean;
    violations: string[];
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const results: BenchOutput = {
  timestamp: new Date().toISOString(),
  treeParserAvailable: ParserClass !== null,
  extractors: {},
  parity: { allMeetFloor: true, violations: [] },
};

const violations: string[] = [];

// --- TypeScript ---
{
  const grammar = loadGrammar('tree-sitter-typescript', 'typescript');
  const source = readFileSync(join(FIXTURES_DIR, 'typescript/sample.ts'), 'utf8');
  const root = parseSource(source, grammar);
  const baseline = BASELINES.typescript;

  if (!root) {
    results.extractors['typescript'] = {
      definitions: -1,
      byKind: {},
      imports: -1,
      heritage: -1,
      delta: { definitions: 0, imports: 0, heritage: 0 },
      parserAvailable: false,
    };
  } else {
    const r = extractTypeScript(root, 'fixtures/typescript/sample.ts', 'typescript');
    const defs = r.definitions.length;
    const imps = r.imports.length;
    const her = r.heritage.length;

    results.extractors['typescript'] = {
      definitions: defs,
      byKind: countByKind(r.definitions),
      imports: imps,
      heritage: her,
      delta: {
        definitions: defs - baseline.total,
        imports: imps - baseline.imports,
        heritage: her - baseline.heritage,
      },
      parserAvailable: true,
    };

    if (defs < baseline.total)
      violations.push(`typescript: definitions dropped ${baseline.total} → ${defs}`);
    if (imps < baseline.imports)
      violations.push(`typescript: imports dropped ${baseline.imports} → ${imps}`);
    if (her < baseline.heritage)
      violations.push(`typescript: heritage dropped ${baseline.heritage} → ${her}`);
  }
}

// --- Python ---
{
  const grammar = loadGrammar('tree-sitter-python');
  const source = readFileSync(join(FIXTURES_DIR, 'python/sample.py'), 'utf8');
  const root = parseSource(source, grammar);
  const baseline = BASELINES.python;

  if (!root) {
    results.extractors['python'] = {
      definitions: -1,
      byKind: {},
      imports: -1,
      heritage: -1,
      delta: { definitions: 0, imports: 0, heritage: 0 },
      parserAvailable: false,
    };
  } else {
    const r = extractPython(root, 'fixtures/python/sample.py');
    const defs = r.definitions.length;
    const imps = r.imports.length;
    const her = r.heritage.length;

    results.extractors['python'] = {
      definitions: defs,
      byKind: countByKind(r.definitions),
      imports: imps,
      heritage: her,
      delta: {
        definitions: defs - baseline.total,
        imports: imps - baseline.imports,
        heritage: her - baseline.heritage,
      },
      parserAvailable: true,
    };

    if (defs < baseline.total)
      violations.push(`python: definitions dropped ${baseline.total} → ${defs}`);
    if (imps < baseline.imports)
      violations.push(`python: imports dropped ${baseline.imports} → ${imps}`);
    if (her < baseline.heritage)
      violations.push(`python: heritage dropped ${baseline.heritage} → ${her}`);
  }
}

// --- Go ---
{
  const grammar = loadGrammar('tree-sitter-go');
  const source = readFileSync(join(FIXTURES_DIR, 'go/sample.go'), 'utf8');
  const root = parseSource(source, grammar);
  const baseline = BASELINES.go;

  if (!root) {
    results.extractors['go'] = {
      definitions: -1,
      byKind: {},
      imports: -1,
      heritage: -1,
      delta: { definitions: 0, imports: 0, heritage: 0 },
      parserAvailable: false,
    };
  } else {
    const r = extractGo(root, 'fixtures/go/sample.go');
    const defs = r.definitions.length;
    const imps = r.imports.length;
    const her = r.heritage.length;

    results.extractors['go'] = {
      definitions: defs,
      byKind: countByKind(r.definitions),
      imports: imps,
      heritage: her,
      delta: {
        definitions: defs - baseline.total,
        imports: imps - baseline.imports,
        heritage: her - baseline.heritage,
      },
      parserAvailable: true,
    };

    if (defs < baseline.total)
      violations.push(`go: definitions dropped ${baseline.total} → ${defs}`);
    if (imps < baseline.imports)
      violations.push(`go: imports dropped ${baseline.imports} → ${imps}`);
    if (her < baseline.heritage)
      violations.push(`go: heritage dropped ${baseline.heritage} → ${her}`);
  }
}

// --- Rust ---
{
  const grammar = loadGrammar('tree-sitter-rust');
  const source = readFileSync(join(FIXTURES_DIR, 'rust/sample.rs'), 'utf8');
  const root = parseSource(source, grammar);
  const baseline = BASELINES.rust;

  if (!root) {
    results.extractors['rust'] = {
      definitions: -1,
      byKind: {},
      imports: -1,
      heritage: -1,
      delta: { definitions: 0, imports: 0, heritage: 0 },
      parserAvailable: false,
    };
  } else {
    const r = extractRust(root, 'fixtures/rust/sample.rs');
    const defs = r.definitions.length;
    const imps = r.imports.length;
    const her = r.heritage.length;

    results.extractors['rust'] = {
      definitions: defs,
      byKind: countByKind(r.definitions),
      imports: imps,
      heritage: her,
      delta: {
        definitions: defs - baseline.total,
        imports: imps - baseline.imports,
        heritage: her - baseline.heritage,
      },
      parserAvailable: true,
    };

    if (defs < baseline.total)
      violations.push(`rust: definitions dropped ${baseline.total} → ${defs}`);
    if (imps < baseline.imports)
      violations.push(`rust: imports dropped ${baseline.imports} → ${imps}`);
    if (her < baseline.heritage)
      violations.push(`rust: heritage dropped ${baseline.heritage} → ${her}`);
  }
}

results.parity.allMeetFloor = violations.length === 0;
results.parity.violations = violations;

process.stdout.write(JSON.stringify(results, null, 2) + '\n');

if (violations.length > 0) {
  process.stderr.write('\nPARITY VIOLATIONS DETECTED:\n');
  for (const v of violations) {
    process.stderr.write(`  - ${v}\n`);
  }
  process.exit(1);
}
