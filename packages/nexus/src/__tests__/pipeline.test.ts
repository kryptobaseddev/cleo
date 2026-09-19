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

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GraphIndexFileReport, GraphPublicationRows } from '@cleocode/contracts';
import { buildSync } from 'esbuild';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOriginalSource } from '../code/parser.js';
import type { ScannedFile } from '../pipeline/filesystem-walker.js';
import { walkRepositoryPaths } from '../pipeline/filesystem-walker.js';
import { runPipeline } from '../pipeline/index.js';
import type { DrizzleTableRef } from '../pipeline/knowledge-graph.js';
import { createKnowledgeGraph } from '../pipeline/knowledge-graph.js';
import { detectLanguageFromPath, isIndexableFile } from '../pipeline/language-detection.js';
import { extractOriginalSource } from '../pipeline/parse-loop.js';
import { processStructure } from '../pipeline/structure-processor.js';

/**
 * Build a minimal stub `DrizzleTableRef` for flush-only tests.
 *
 * Tests that call `KnowledgeGraph.flush` with a mocked `insert()` never reach
 * the column-access (`tables.nexusNodes['projectId']`) path — they only need
 * the table identity to pass through to the mock. We construct an empty
 * Proxy that satisfies the `Record<string, Column>` shape without forcing
 * each test to import drizzle internals or build a fake column.
 */
function stubTable(): DrizzleTableRef {
  // Use a string-tagged empty object whose property accesses return undefined.
  // Type-cast-free path: `DrizzleTableRef = { [k: string]: Column }`, and an
  // empty object literal is assignable when no keys are exercised.
  return Object.create(null) as DrizzleTableRef;
}

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

describe('bounded parser workers (T12262)', () => {
  it('proves heap exhaustion, per-file deadlines, cancellation and quiet termination in a clean process', () => {
    const directory = makeTempDir();
    try {
      const poolPath = join(directory, 'pool.mjs');
      buildSync({
        entryPoints: [new URL('../pipeline/workers/worker-pool.ts', import.meta.url).pathname],
        outfile: poolPath,
        bundle: true,
        platform: 'node',
        format: 'esm',
      });
      const probePath = join(directory, 'probe.mjs');
      writeFileSync(
        probePath,
        `
        import assert from 'node:assert/strict';
        import { writeFileSync } from 'node:fs';
        import { createWorkerPool } from './pool.mjs';
        function fixture(body) {
          const url = new URL('./fixture.mjs', import.meta.url);
          writeFileSync(url, "import {parentPort,resourceLimits} from 'node:worker_threads'; import {getHeapStatistics} from 'node:v8';\\n" + body);
          return url;
        }
        let pool = createWorkerPool(fixture(\`
          let count = 0;
          parentPort.on('message', message => {
            if (message.type === 'sub-batch') {
              if (message.files.length !== 1) throw new Error('unbounded batch');
              count++; parentPort.postMessage({ type: 'sub-batch-done' });
            } else parentPort.postMessage({ type: 'result', data: { count, heap: getHeapStatistics().heap_size_limit } });
          });
        \`), 1, { workerHeapMb: 32 });
        try {
          const [result] = await pool.dispatch([1,2,3]);
          assert.equal(result.count, 3);
          assert.ok(result.heap < 64 * 1024 * 1024, 'actual V8 ceiling, not merely reported configuration');
        } finally { await pool.terminate(); }
        pool = createWorkerPool(fixture("parentPort.on('message', () => { while(true) {} });"), 1, { timeoutMs: 100 });
        await assert.rejects(pool.dispatch([1]), /E_PARSE_WORKER_TIMEOUT/);
        await assert.rejects(pool.dispatch([2]), /terminated/);
        await pool.terminate();
        const controller = new AbortController();
        pool = createWorkerPool(fixture("parentPort.on('message', () => { while(true) {} });"), 1, { signal: controller.signal });
        const pending = pool.dispatch([1]);
        await assert.rejects(pool.dispatch([2]), /active dispatch/);
        setTimeout(() => controller.abort(), 100);
        await assert.rejects(pending, /E_PARSE_CANCELLED/);
        await pool.terminate();
        pool = createWorkerPool(fixture("parentPort.on('message', () => { const retained = []; while(true) retained.push(new Array(100000).fill('retained')); });"), 1, { workerHeapMb: 16 });
        await assert.rejects(pool.dispatch([1]), /memory|heap|OOM/i);
        await assert.rejects(pool.dispatch([2]), /terminated/);
        await pool.terminate();
        process.env.NODE_OPTIONS = '--max-old-space-size=1024';
        assert.throws(() => createWorkerPool(new URL('./fixture.mjs', import.meta.url)), /E_PARSE_WORKER_HEAP_OVERRIDE/);
      `,
      );
      execFileSync(process.execPath, [probePath], {
        timeout: 20000,
        env: {
          PATH: process.env['PATH'],
          HOME: directory,
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
        },
        stdio: 'pipe',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('isolated shared extraction (T12262)', () => {
  it('preserves language capabilities and per-file failures through actual process IPC', () => {
    const directory = makeTempDir();
    try {
      symlinkSync(
        new URL('../../node_modules', import.meta.url).pathname,
        join(directory, 'node_modules'),
        'dir',
      );
      const entries = [
        ['worker', new URL('../pipeline/workers/parse-worker.ts', import.meta.url).pathname],
        ['pipeline', new URL('../pipeline/index.ts', import.meta.url).pathname],
        ['pool', new URL('../pipeline/workers/worker-pool.ts', import.meta.url).pathname],
        [
          'provider',
          new URL('../../../core/src/resources/spawn-wrapper.ts', import.meta.url).pathname,
        ],
      ];
      for (const [name, entry] of entries)
        buildSync({
          entryPoints: [entry],
          outfile: join(directory, `${name}.mjs`),
          bundle: true,
          packages: 'external',
          platform: 'node',
          format: 'esm',
        });
      const script = join(directory, 'probe.mjs');
      writeFileSync(
        script,
        `
        import assert from 'node:assert/strict';
        import { createWorkerPool } from './pool.mjs';
        import { runPipeline } from './pipeline.mjs';
        import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
        import { fileURLToPath } from 'node:url';
        import { createParserExecutionPort, _forceSystemdRunAvailable } from './provider.mjs';
        _forceSystemdRunAvailable(false);
        const inputs = [
          { path: 'large.ts', content: '/*' + 'x'.repeat(65536) + '*/\\nimport { 源 } from "./資料🌱"; export function 解析(){return obj.値;} 解析();' },
          { path: 'unicode.js', content: 'function 読む(){return obj.値;} 読む();' },
          { path: 'unicode.py', content: 'def 読む():\\n    return obj.値\\n読む()\\n' },
          { path: 'unicode.go', content: 'package main\\nfunc 読む(){ obj.値() }\\nfunc main(){読む()}\\n' },
          { path: 'unicode.rs', content: 'fn 読む(){ obj.値(); } fn main(){読む();}' },
          { path: 'too-large.ts', content: 'const 文 = "🌱";', limits: { maxSourceBytes: 1 } },
          { path: 'invalid.ts', content: 'export function broken( {' },
        ];
        let childCount = 0;
        const actual = createParserExecutionPort();
        const execution = { spawn(path, limits) { childCount++; return actual.spawn(path, limits); } };
        const pool = createWorkerPool(new URL('./worker.mjs', import.meta.url), 2, { workerHeapMb: 64 }, execution);
        try {
          const results = await pool.dispatch(inputs);
          assert.equal(childCount, 2, 'extractor must not recursively enter worker dispatch');
          const symbols = results.flatMap(result => result.symbols);
          const calls = results.flatMap(result => result.calls);
          const accesses = results.flatMap(result => result.accesses);
          const reports = results.flatMap(result => result.reports);
          for (const input of inputs.slice(0, 5)) {
            assert.ok(symbols.some(symbol => symbol.filePath === input.path && ['解析','読む'].includes(symbol.name)), input.path + ' declaration');
            assert.ok(calls.some(call => call.filePath === input.path && ['解析','読む'].includes(call.calledName)), input.path + ' caller');
            assert.ok(accesses.some(access => access.filePath === input.path), input.path + ' access');
            assert.equal(reports.find(report => report.path === input.path).status, 'analyzed');
          }
          assert.ok(results.flatMap(result => result.imports).some(binding => binding.rawImportPath === './資料🌱'));
          assert.match(reports.find(report => report.path === 'too-large.ts').reason, /E_PARSE_SIZE/);
          assert.match(reports.find(report => report.path === 'invalid.ts').reason, /E_PARSE_SYNTAX/);
          assert.equal(results.reduce((sum, result) => sum + result.fileCount, 0), 5);
          assert.equal(results.reduce((sum, result) => sum + result.skippedCount, 0), 2);
        } finally { await pool.terminate(); }
        mkdirSync(new URL('./workers/', import.meta.url));
        copyFileSync(new URL('./worker.mjs', import.meta.url), new URL('./workers/parse-worker.js', import.meta.url));
        writeFileSync(new URL('./package.json', import.meta.url), '{"type":"module"}');
        const repo = new URL('./repo/', import.meta.url);
        mkdirSync(repo);
        writeFileSync(new URL('main.ts', repo), inputs[0].content);
        const publications = [];
        const noWrites = { insert() { throw new Error('unexpected live store mutation'); } };
        const tables = { nexusNodes: {}, nexusRelations: {} };
        await runPipeline(fileURLToPath(repo), 'fixture', noWrites, tables, undefined, {
          parserExecution: execution, parserLimits: { workerHeapMb: 64 }, publishGraph(rows) { publications.push(rows); },
        });
        assert.equal(childCount, 3, 'production pipeline must use exactly one owned child for one file');
        assert.equal(publications.length, 1);
        assert.ok(publications[0].nodes.some(node => node.name === '解析'));
        assert.equal(publications[0].assessment.files.find(file => file.path === 'main.ts').status, 'analyzed');
        await assert.rejects(runPipeline(fileURLToPath(repo), 'fixture', noWrites, tables, undefined, {
          parserExecution: execution, parserLimits: { maxSourceBytes: 1, workerHeapMb: 64 }, publishGraph(rows) { publications.push(rows); },
        }), /E_PARSE_SIZE/);
        assert.equal(publications.length, 1, 'failed file must not replace prior published generation');
        const controller = new AbortController(); controller.abort(new Error('cancel before publication'));
        await assert.rejects(runPipeline(fileURLToPath(repo), 'fixture', noWrites, tables, undefined, {
          parserExecution: execution, parserLimits: { signal: controller.signal }, publishGraph(rows) { publications.push(rows); },
        }), /cancel before publication/);
        assert.equal(publications.length, 1);
        const busy = new URL('./busy.cjs', import.meta.url);
        writeFileSync(busy, "process.send({type:'ready',heapBytes:require('node:v8').getHeapStatistics().heap_size_limit}); process.on('message',()=>{process.send({type:'progress',filesProcessed:1}); while(true){};});");
        let entered = false;
        const deadlinePool = createWorkerPool(busy, 1, { timeoutMs: 300, workerHeapMb: 32 }, actual);
        await assert.rejects(deadlinePool.dispatch([1], () => {entered = true;}), /E_PARSE_WORKER_TIMEOUT/);
        assert.equal(entered, true, 'deadline must interrupt a running process, not just its startup');
        await deadlinePool.terminate();
        const cancel = new AbortController();
        const cancelPool = createWorkerPool(busy, 1, { timeoutMs: 5000, workerHeapMb: 32, signal: cancel.signal }, actual);
        await assert.rejects(cancelPool.dispatch([1], () => {setTimeout(() => cancel.abort(), 50);}), /E_PARSE_CANCELLED/);
        await cancelPool.terminate();
        const allocate = new URL('./allocate.cjs', import.meta.url);
        writeFileSync(allocate, "process.send({type:'ready',heapBytes:require('node:v8').getHeapStatistics().heap_size_limit}); process.on('message',()=>{const retained=[];while(true) retained.push(new Array(100000).fill('retained'));});");
        const heapPool = createWorkerPool(allocate, 1, { workerHeapMb: 16 }, actual);
        await assert.rejects(heapPool.dispatch([1]), /OOM|heap|memory/i);
        await heapPool.terminate();

      `,
      );
      execFileSync(process.execPath, [script], {
        timeout: 20000,
        stdio: 'pipe',
        env: {
          PATH: process.env['PATH'],
          NODE_OPTIONS: '--max-old-space-size=1024',
          HOME: directory,
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('bounded original parser capacity (T12262)', () => {
  function sourceOfLength(length: number): string {
    const head = 'import { 源 } from "./資料🌱";\n/*';
    const tail = '*/\nexport function 解析(入力: string) { return 源(入力); }\n解析("🌱");\n';
    return head + 'x'.repeat(length - head.length - tail.length) + tail;
  }

  function nativeParser(): Parser {
    const parser = new Parser();
    parser.setLanguage(TypeScript.typescript);
    return parser;
  }

  it.each([
    32766, 32767, 32768, 65536, 262144,
  ])('preserves original identifiers, imports and UTF-16 tail spans at %i units', (length) => {
    const source = sourceOfLength(length);
    const tree = parseOriginalSource(nativeParser(), source);
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.endIndex).toBe(length);
    const declaration = tree.rootNode.descendantsOfType('function_declaration')[0];
    expect(declaration.childForFieldName('name')?.text).toBe('解析');
    expect(tree.rootNode.descendantsOfType('import_statement')[0].text).toBe(
      'import { 源 } from "./資料🌱";',
    );
    const call = tree.rootNode.descendantsOfType('call_expression').at(-1);
    expect(call?.text).toBe('解析("🌱")');
    expect(call?.startIndex).toBe(source.lastIndexOf('解析('));
    expect(call?.endIndex).toBe(source.lastIndexOf('解析(') + '解析("🌱")'.length);
    expect(call?.startIndex).not.toBe(Buffer.byteLength(source.slice(0, call?.startIndex), 'utf8'));
  });

  it.each([
    32766, 32767, 32768, 65536, 262144,
  ])('extracts tail declarations and calls from original %i-unit files', (length) => {
    const extracted = extractOriginalSource(sourceOfLength(length), 'original.ts');
    expect(extracted.definitions.some((node) => node.name === '解析')).toBe(true);
    expect(extracted.imports[0].rawImportPath).toBe('./資料🌱');
    expect(extracted.calls.some((call) => call.calledName === '解析')).toBe(true);
  });

  it('rejects native syntax error trees rather than declaring complete extraction', () => {
    expect(() => parseOriginalSource(nativeParser(), 'export function broken( {')).toThrow(
      'E_PARSE_SYNTAX',
    );
  });

  it('retains the real default-buffer failure as a native negative control', () => {
    expect(() => nativeParser().parse(sourceOfLength(32767))).not.toThrow();
    expect(() => nativeParser().parse(sourceOfLength(32768))).toThrow('Invalid argument');
  });

  it('preserves an astral surrogate pair across the input chunk boundary', () => {
    const source = '/*' + 'x'.repeat(4093) + '🌱*/\nconst 文 = "資料🌱";';
    expect(source.charCodeAt(4095)).toBe(0xd83c);
    const tree = parseOriginalSource(nativeParser(), source);
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.text).toBe(source);
    expect(tree.rootNode.descendantsOfType('identifier').map((node) => node.text)).toContain('文');
  });

  it('rejects excess source bytes and pre-cancelled work without corrupting parser reuse', () => {
    const parser = nativeParser();
    const source = 'const 文 = "🌱";';
    expect(() => parseOriginalSource(parser, source, { maxSourceBytes: source.length })).toThrow(
      'E_PARSE_SIZE',
    );
    const controller = new AbortController();
    controller.abort(new Error('controlled cancellation'));
    expect(() => parseOriginalSource(parser, source, { signal: controller.signal })).toThrow(
      'controlled cancellation',
    );
    expect(parseOriginalSource(parser, source).rootNode.hasError).toBe(false);
  });

  it('enforces the native deadline and resets timed-out parser state', () => {
    const parser = nativeParser();
    const source = 'const x = 1;\n'.repeat(20000);
    expect(() => parseOriginalSource(parser, source, { timeoutMs: 0.001 })).toThrow();
    expect(parseOriginalSource(parser, 'const 文 = 1;').rootNode.hasError).toBe(false);
  });
});

describe('source evidence fidelity', () => {
  it('honors escaped Git patterns, directory-only rules, and nested negation', async () => {
    const root = makeTempDir();
    try {
      writeFile(
        root,
        '.gitignore',
        String.raw`\#private.ts
\!private.ts
cache/
*.tmp
`,
      );
      writeFile(root, '#private.ts');
      writeFile(root, '!private.ts');
      writeFile(root, 'cache/hidden.ts');
      writeFile(root, 'src/cache');
      writeFile(root, 'src/.gitignore', '!keep.tmp');
      writeFile(root, 'src/keep.tmp');
      writeFile(root, 'src/drop.tmp');
      const files = (await walkRepositoryPaths(root)).map((file) => file.path);
      expect(files).toContain('src/cache');
      expect(files).toContain('src/keep.tmp');
      expect(files).not.toContain('src/drop.tmp');
      expect(files).not.toContain('#private.ts');
      expect(files).not.toContain('!private.ts');
      expect(files).not.toContain('cache/hidden.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses Git repository and global excludes for an explicitly included nested repository', async () => {
    const root = makeTempDir();
    try {
      const repo = join(root, 'app');
      mkdirSync(repo);
      execFileSync('git', ['init', '--quiet', repo]);
      const globalExclude = join(root, 'global-ignore');
      writeFile(root, 'global-ignore', 'global-secret.ts\n');
      execFileSync('git', ['config', 'core.excludesFile', globalExclude], { cwd: repo });
      writeFile(repo, '.git/info/exclude', 'repository-secret.ts\n');
      writeFile(repo, 'global-secret.ts');
      writeFile(repo, 'repository-secret.ts');
      writeFile(repo, 'visible.ts');
      const reports: GraphIndexFileReport[] = [];
      const files = await walkRepositoryPaths(root, undefined, (report) => reports.push(report), [
        'app',
      ]);
      expect(files.map((file) => file.path)).toContain('app/visible.ts');
      expect(files.map((file) => file.path)).not.toContain('app/global-secret.ts');
      expect(files.map((file) => file.path)).not.toContain('app/repository-secret.ts');
      expect(
        reports
          .filter((report) => report.path.endsWith('-secret.ts'))
          .map((report) => report.status),
      ).toEqual(['excluded', 'excluded']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects content edits that preserve size and modification time', async () => {
    const root = makeTempDir();
    try {
      writeFile(root, 'code.ts', 'export const x = 1;');
      const before = await walkRepositoryPaths(root);
      const stat = statSync(join(root, 'code.ts'));
      writeFile(root, 'code.ts', 'export const x = 2;');
      utimesSync(join(root, 'code.ts'), stat.atime, stat.mtime);
      const after = await walkRepositoryPaths(root);
      expect(before[0]?.size).toBe(after[0]?.size);
      expect(before[0]?.contentHash).not.toBe(after[0]?.contentHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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

  it('requires explicit inclusion for nested repositories and worktrees', async () => {
    writeFile(tmpDir, 'src/main.ts');
    writeFile(tmpDir, 'app/main.ts');
    mkdirSync(join(tmpDir, '.cleo'));
    execFileSync('git', [
      'init',
      '--quiet',
      '--separate-git-dir',
      join(tmpDir, '.cleo/git'),
      join(tmpDir, 'app'),
    ]);
    const reports: GraphIndexFileReport[] = [];
    const excluded = await walkRepositoryPaths(tmpDir, undefined, (report) => reports.push(report));
    expect(excluded.map((file) => file.path)).not.toContain('app/main.ts');
    expect(reports).toContainEqual({
      path: 'app',
      status: 'excluded',
      reason: 'Nested repository requires explicit inclusion',
    });
    const included = await walkRepositoryPaths(tmpDir, undefined, undefined, ['app']);
    expect(included.map((file) => file.path)).toContain('app/main.ts');
  });

  it('honors ordered negation and nested ignore files', async () => {
    writeFile(tmpDir, '.gitignore', '*.generated.ts\n!keep.generated.ts\n');
    writeFile(tmpDir, 'drop.generated.ts');
    writeFile(tmpDir, 'keep.generated.ts');
    writeFile(tmpDir, 'nested/.gitignore', 'private.ts\n');
    writeFile(tmpDir, 'nested/private.ts');
    writeFile(tmpDir, 'nested/public.ts');
    const paths = (await walkRepositoryPaths(tmpDir)).map((file) => file.path);
    expect(paths).toContain('keep.generated.ts');
    expect(paths).toContain('nested/public.ts');
    expect(paths).not.toContain('drop.generated.ts');
    expect(paths).not.toContain('nested/private.ts');
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
    execFileSync('git', ['init', '--quiet', tmpDir]);

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
    graph.addNode({
      id: 'src/',
      kind: 'folder',
      name: 'src',
      filePath: 'src/',
      startLine: 1,
      endLine: 1,
      language: '',
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

    // Tests pass a stub table reference — the mockDb.insert() handler ignores
    // the table identity and only inspects the rows. The flush path never
    // accesses columns on the stub, so an empty Record<string, Column> shape
    // suffices and avoids the `as unknown as` cast chain.
    await graph.flush('project-abc', mockDb, {
      nexusNodes: stubTable(),
      nexusRelations: stubTable(),
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

  it('stages a validated complete generation without inserting live rows', async () => {
    writeFile(tmpDir, 'main.ts', "import pg from 'pg'; export function example() { return pg; }");
    const insert = vi.fn(() => {
      throw new Error('Live graph must not be mutated during staging');
    });
    const publishGraph = vi.fn<(rows: GraphPublicationRows) => void>();
    await runPipeline(
      tmpDir,
      'project',
      { insert },
      { nexusNodes: stubTable(), nexusRelations: stubTable() },
      undefined,
      { publishGraph },
    );
    expect(insert).not.toHaveBeenCalled();
    expect(publishGraph).toHaveBeenCalledOnce();
    expect(publishGraph.mock.calls[0]![0].assessment?.files).toEqual([
      expect.objectContaining({ path: 'main.ts', status: 'analyzed' }),
    ]);
    expect(publishGraph.mock.calls[0]![0].relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: 'main.ts', targetId: 'module:pg', type: 'imports' }),
      ]),
    );
  });

  it('retains AST-proven unmodeled scopes as diagnostics without inventing declarations', async () => {
    writeFile(
      tmpDir,
      'main.ts',
      `
export function known() { return 1; }
export function modeled() { return known(); }
export default { async fetch() { return known(); } };
export function outer() { const nested = () => known(); return nested(); }
`,
    );
    const insert = vi.fn(() => {
      throw new Error('Unexpected live mutation');
    });
    const publishGraph = vi.fn<(rows: GraphPublicationRows) => void>();
    const result = await runPipeline(
      tmpDir,
      'project',
      { insert },
      { nexusNodes: stubTable(), nexusRelations: stubTable() },
      undefined,
      { publishGraph },
    );
    const generation = publishGraph.mock.calls[0]?.[0];
    expect(generation).toBeDefined();
    expect(generation?.assessment?.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unmodeled-source',
          filePath: 'main.ts',
          sourceId: 'main.ts::fetch',
          targetId: 'main.ts::known',
          targetName: 'known',
          relationship: 'calls',
        }),
        expect.objectContaining({ sourceId: 'main.ts::nested', targetId: 'main.ts::known' }),
      ]),
    );
    expect(result.references).toEqual(generation?.assessment?.references);
    expect(generation?.nodes.some((node) => node.id === 'main.ts::fetch')).toBe(false);
    expect(generation?.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'main.ts::modeled',
          targetId: 'main.ts::known',
          type: 'calls',
        }),
      ]),
    );
    const ids = new Set(generation?.nodes.map((node) => node.id));
    expect(
      generation?.relations.every((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId)),
    ).toBe(true);
    expect(insert).not.toHaveBeenCalled();
  });

  it('retains the live graph when indexing is interrupted', async () => {
    writeFile(tmpDir, 'main.ts', 'export function example() {}');
    const insert = vi.fn(() => {
      throw new Error('Unexpected live mutation');
    });
    const publishGraph = vi.fn<(rows: GraphPublicationRows) => void>();
    await expect(
      runPipeline(
        tmpDir,
        'project',
        { insert },
        { nexusNodes: stubTable(), nexusRelations: stubTable() },
        () => {
          throw new Error('Cancelled');
        },
        { publishGraph },
      ),
    ).rejects.toThrow('Cancelled');
    expect(insert).not.toHaveBeenCalled();
    expect(publishGraph).not.toHaveBeenCalled();
  });

  it('rejects files added during staging before publishing mixed source state', async () => {
    writeFile(tmpDir, 'main.ts', 'export function example() {}');
    const insert = vi.fn(() => {
      throw new Error('Unexpected live mutation');
    });
    const publishGraph = vi.fn<(rows: GraphPublicationRows) => void>();
    let progressCalls = 0;
    await expect(
      runPipeline(
        tmpDir,
        'project',
        { insert },
        { nexusNodes: stubTable(), nexusRelations: stubTable() },
        () => {
          progressCalls++;
          if (progressCalls === 2) writeFile(tmpDir, 'added.ts', 'export function added() {}');
        },
        { publishGraph },
      ),
    ).rejects.toThrow('Source files changed');
    expect(insert).not.toHaveBeenCalled();
    expect(publishGraph).not.toHaveBeenCalled();
  });

  it('rejects source changes during staging even when size and timestamps are preserved', async () => {
    writeFile(tmpDir, 'main.ts', 'export function example() { return 1; }');
    const original = statSync(join(tmpDir, 'main.ts'));
    const insert = vi.fn(() => {
      throw new Error('Unexpected live mutation');
    });
    const publishGraph = vi.fn<(rows: GraphPublicationRows) => void>();
    let progressCalls = 0;
    await expect(
      runPipeline(
        tmpDir,
        'project',
        { insert },
        { nexusNodes: stubTable(), nexusRelations: stubTable() },
        () => {
          if (++progressCalls === 2) {
            writeFile(tmpDir, 'main.ts', 'export function example() { return 2; }');
            utimesSync(join(tmpDir, 'main.ts'), original.atime, original.mtime);
          }
        },
        { publishGraph },
      ),
    ).rejects.toThrow('Source changed between scanning and parsing');
    expect(insert).not.toHaveBeenCalled();
    expect(publishGraph).not.toHaveBeenCalled();
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
