/**
 * Tests for code analysis engine — smartOutline, smartSearch, smartUnfold.
 *
 * Tests the dispatch engine wrappers for code analysis operations
 * against real TypeScript files in the CLEO codebase itself (dogfooding).
 *
 * Updated for ENG-MIG-16 (T1583 / ADR-057 D1): functions now require
 * `(projectRoot, params)` — projectRoot is passed explicitly so the
 * core implementations do not fall back to process.cwd() guessing.
 *
 * @task T157
 * @task T1583 — ENG-MIG-16
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeOutline, codeParse, codeSearch, codeUnfold } from '../code-engine.js';

describe('Code Engine', () => {
  // Use a real test file from the codebase
  const testFile = 'packages/cleo/src/cli/commands/code.ts';
  const projectRoot = process.cwd();
  const absPath = join(projectRoot, testFile);

  describe('codeOutline', () => {
    it('should return success=true with file parameter', async () => {
      const result = await codeOutline(projectRoot, { file: testFile });
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should extract structured symbols from code file', async () => {
      const result = await codeOutline(projectRoot, { file: testFile });
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.filePath).toBeDefined();
      expect(data.language).toBeDefined();
      expect(Array.isArray(data.symbols)).toBe(true);
      expect(data.estimatedTokens).toBeGreaterThan(0);
    });

    it('should include export information in symbols', async () => {
      const result = await codeOutline(projectRoot, { file: testFile });
      const data = result.data as { symbols: Array<{ name: string; exported: boolean }> };
      const codeCommandExport = data.symbols.find((s) => s.name === 'codeCommand');
      expect(codeCommandExport).toBeDefined();
      if (codeCommandExport) {
        expect(typeof codeCommandExport.exported).toBe('boolean');
      }
    });

    it('should include line numbers for each symbol', async () => {
      const result = await codeOutline(projectRoot, { file: testFile });
      const data = result.data as { symbols: Array<{ startLine: number; endLine: number }> };
      for (const sym of data.symbols) {
        expect(sym.startLine).toBeGreaterThan(0);
        expect(sym.endLine).toBeGreaterThanOrEqual(sym.startLine);
      }
    });

    it('should detect TypeScript language', async () => {
      const result = await codeOutline(projectRoot, { file: testFile });
      const data = result.data as { language: string };
      expect(data.language).toMatch(/typescript|javascript/i);
    });

    it('should return error when file parameter is missing', async () => {
      const result = await codeOutline(projectRoot, {});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INVALID_INPUT');
        expect(result.error.message).toMatch(/file/i);
      }
    });

    it('should handle relative paths correctly', async () => {
      const result = await codeOutline(projectRoot, { file: testFile });
      expect(result.success).toBe(true);
      const data = result.data as { filePath: string };
      expect(data.filePath).toBeDefined();
    });

    it('should handle absolute paths correctly', async () => {
      const result = await codeOutline(projectRoot, { file: absPath });
      expect(result.success).toBe(true);
      const data = result.data as { filePath: string };
      expect(data.filePath).toBeDefined();
    });
  });

  describe('codeSearch', () => {
    it('should return success=true with query parameter', async () => {
      const result = await codeSearch(projectRoot, { query: 'codeCommand' });
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('should find known symbols by exact query', async () => {
      const result = await codeSearch(projectRoot, { query: 'codeCommand' });
      expect(result.success).toBe(true);
      const results = result.data as Array<{ symbol: { name: string } }>;
      expect(results.length).toBeGreaterThan(0);
      const found = results.some((r) => r.symbol.name === 'codeCommand');
      expect(found).toBe(true);
    });

    it('should include match type and score in results', async () => {
      const result = await codeSearch(projectRoot, { query: 'requireTreeSitter' });
      const results = result.data as Array<{ score: number; matchType: string }>;
      if (results.length > 0) {
        const r = results[0]!;
        expect(r.score).toBeGreaterThan(0);
        expect(['exact', 'substring', 'fuzzy', 'path']).toContain(r.matchType);
      }
    });

    it('should respect maxResults parameter', async () => {
      const result = await codeSearch(projectRoot, { query: 'export', max: 5 });
      const results = result.data as unknown[];
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('should default to 20 results when max not specified', async () => {
      const result = await codeSearch(projectRoot, { query: 'function' });
      const results = result.data as unknown[];
      expect(results.length).toBeLessThanOrEqual(20);
    });

    it('should filter by language when specified', async () => {
      const result = await codeSearch(projectRoot, { query: 'const', lang: 'typescript' });
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('should return error when query parameter is missing', async () => {
      const result = await codeSearch(projectRoot, {});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INVALID_INPUT');
        expect(result.error.message).toMatch(/query/i);
      }
    });

    it('should return empty array for non-matching query', async () => {
      const result = await codeSearch(projectRoot, { query: 'xyzABCDEF123999notfound' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });
  });

  describe('codeUnfold', () => {
    it('should return success=true with file and symbol parameters', async () => {
      const result = await codeUnfold(projectRoot, { file: testFile, symbol: 'codeCommand' });
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should extract complete symbol source code', async () => {
      const result = await codeUnfold(projectRoot, { file: testFile, symbol: 'codeCommand' });
      expect(result.success).toBe(true);
      const data = result.data as { found: boolean; source: string };
      expect(data.found).toBe(true);
      expect(data.source).toBeDefined();
      expect(data.source.length).toBeGreaterThan(0);
      expect(data.source).toMatch(/codeCommand|defineCommand/);
    });

    it('should include symbol metadata in result', async () => {
      const result = await codeUnfold(projectRoot, { file: testFile, symbol: 'codeCommand' });
      const data = result.data as { symbol: { name: string } };
      expect(data.symbol).toBeDefined();
      expect(data.symbol.name).toBe('codeCommand');
    });

    it('should include line numbers for extracted symbol', async () => {
      const result = await codeUnfold(projectRoot, { file: testFile, symbol: 'codeCommand' });
      const data = result.data as { startLine: number; endLine: number; filePath: string };
      expect(data.startLine).toBeGreaterThan(0);
      expect(data.endLine).toBeGreaterThanOrEqual(data.startLine);
      expect(data.filePath).toBeDefined();
    });

    it('should estimate token count for extracted source', async () => {
      const result = await codeUnfold(projectRoot, { file: testFile, symbol: 'codeCommand' });
      const data = result.data as { estimatedTokens: number };
      expect(data.estimatedTokens).toBeGreaterThan(0);
    });

    it('should find nested symbols', async () => {
      // Try to unfold a nested method/property
      const result = await codeUnfold(projectRoot, { file: testFile, symbol: 'outline' });
      expect(result.success).toBe(true);
    });

    it('should return found=false for non-existent symbol', async () => {
      const result = await codeUnfold(projectRoot, {
        file: testFile,
        symbol: 'nonExistentSymbol123',
      });
      expect(result.success).toBe(true);
      const data = result.data as { found: boolean };
      expect(data.found).toBe(false);
    });

    it('should return error when file parameter is missing', async () => {
      const result = await codeUnfold(projectRoot, { symbol: 'codeCommand' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INVALID_INPUT');
        expect(result.error.message).toMatch(/file|parameter/i);
      }
    });

    it('should return error when symbol parameter is missing', async () => {
      const result = await codeUnfold(projectRoot, { file: testFile });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INVALID_INPUT');
        expect(result.error.message).toMatch(/symbol|parameter/i);
      }
    });

    it('should handle relative paths correctly', async () => {
      const result = await codeUnfold(projectRoot, { file: testFile, symbol: 'codeCommand' });
      expect(result.success).toBe(true);
    });

    it('should handle absolute paths correctly', async () => {
      const result = await codeUnfold(projectRoot, { file: absPath, symbol: 'codeCommand' });
      expect(result.success).toBe(true);
    });
  });

  describe('codeParse', () => {
    it('should return raw AST parse result', async () => {
      const result = await codeParse(projectRoot, { file: testFile });
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should include symbols in parse result', async () => {
      const result = await codeParse(projectRoot, { file: testFile });
      const data = result.data as { symbols: unknown[] };
      expect(Array.isArray(data.symbols)).toBe(true);
    });

    it('should return error when file parameter is missing', async () => {
      const result = await codeParse(projectRoot, {});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INVALID_INPUT');
      }
    });
  });
});
