/**
 * Integration tests for `cleo nexus context --content` flag.
 *
 * Verifies that:
 * 1. The --content flag is properly defined on the context command
 * 2. The @cleocode/nexus exports map includes ./code/unfold and ./code/search
 * 3. smartUnfold and smartSearch can be imported and are callable
 * 4. Source content is correctly extracted and displayed
 *
 * @task T1113
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nexusCommand } from '../nexus.js';

describe('nexus context --content integration', () => {
  describe('TC-001: context command definition', () => {
    it('should define the context subcommand', () => {
      const contextCmd = nexusCommand.subCommands?.['context'];
      expect(contextCmd).toBeDefined();
    });

    it('should have --content flag defined', () => {
      const contextCmd = nexusCommand.subCommands?.['context'];
      expect(contextCmd).toBeDefined();
      if (contextCmd) {
        const contentArg = (contextCmd.args as Record<string, unknown>)['content'];
        expect(contentArg).toBeDefined();
        if (contentArg) {
          const argDef = contentArg as Record<string, unknown>;
          expect(argDef['type']).toBe('boolean');
          expect(String(argDef['description']).toLowerCase()).toContain('source');
        }
      }
    });

    it('should describe --content as appending source code', () => {
      const contextCmd = nexusCommand.subCommands?.['context'];
      if (contextCmd?.args?.['content']) {
        const description = (contextCmd.args['content'] as Record<string, unknown>)['description'];
        expect(String(description).toLowerCase()).toMatch(/source|content|append/);
      }
    });
  });

  describe('TC-002: exports map validation', () => {
    it('should declare ./code/unfold in @cleocode/nexus package.json exports', () => {
      // Directly read the package.json to validate the exports map.
      // Vitest aliases remap @cleocode/nexus to source, so we validate
      // the exports map by reading the package.json file.
      // Resolve: test file is at packages/cleo/src/cli/commands/__tests__/
      // packages/nexus/package.json is at ../../../../../../nexus/package.json from the test file
      const pkgPath = resolve(
        new URL(import.meta.url).pathname,
        '../../../../../../nexus/package.json',
      );
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        exports?: Record<string, unknown>;
      };
      expect(pkg.exports).toBeDefined();
      expect(pkg.exports?.['./code/unfold']).toBeDefined();
    });

    it('should declare ./code/search in @cleocode/nexus package.json exports', () => {
      const pkgPath = resolve(
        new URL(import.meta.url).pathname,
        '../../../../../../nexus/package.json',
      );
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        exports?: Record<string, unknown>;
      };
      expect(pkg.exports).toBeDefined();
      expect(pkg.exports?.['./code/search']).toBeDefined();
    });

    it('./code/unfold export should point to dist/src/code/unfold.js', () => {
      const pkgPath = resolve(
        new URL(import.meta.url).pathname,
        '../../../../../../nexus/package.json',
      );
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        exports?: Record<string, { import?: string; types?: string }>;
      };
      const unfoldEntry = pkg.exports?.['./code/unfold'];
      expect(unfoldEntry).toBeDefined();
      expect(unfoldEntry?.import).toBe('./dist/src/code/unfold.js');
      expect(unfoldEntry?.types).toBe('./dist/src/code/unfold.d.ts');
    });

    it('./code/search export should point to dist/src/code/search.js', () => {
      const pkgPath = resolve(
        new URL(import.meta.url).pathname,
        '../../../../../../nexus/package.json',
      );
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        exports?: Record<string, { import?: string; types?: string }>;
      };
      const searchEntry = pkg.exports?.['./code/search'];
      expect(searchEntry).toBeDefined();
      expect(searchEntry?.import).toBe('./dist/src/code/search.js');
      expect(searchEntry?.types).toBe('./dist/src/code/search.d.ts');
    });

    it('should also declare ./dist/src/code/unfold.js for CLI direct-path imports', () => {
      // The compiled nexus context command imports '@cleocode/nexus/dist/src/code/unfold.js'
      // directly (legacy pattern). This entry allows that import to succeed.
      const pkgPath = resolve(
        new URL(import.meta.url).pathname,
        '../../../../../../nexus/package.json',
      );
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        exports?: Record<string, unknown>;
      };
      expect(pkg.exports).toBeDefined();
      expect(pkg.exports?.['./dist/src/code/unfold.js']).toBeDefined();
    });

    it('should also declare ./dist/src/code/search.js for CLI direct-path imports', () => {
      const pkgPath = resolve(
        new URL(import.meta.url).pathname,
        '../../../../../../nexus/package.json',
      );
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        exports?: Record<string, unknown>;
      };
      expect(pkg.exports).toBeDefined();
      expect(pkg.exports?.['./dist/src/code/search.js']).toBeDefined();
    });
  });

  describe('TC-003: smartUnfold function signature', () => {
    it('should export smartUnfold from @cleocode/nexus root', async () => {
      // The vitest alias maps @cleocode/nexus → packages/nexus/src/index.ts
      // which re-exports smartUnfold from code/unfold.
      const nexusModule = await import('@cleocode/nexus');
      expect(typeof nexusModule.smartUnfold).toBe('function');
    });

    it('should accept filePath, symbolName, and optional projectRoot', async () => {
      const nexusModule = await import('@cleocode/nexus');
      const { smartUnfold } = nexusModule;

      // smartUnfold should be callable
      expect(typeof smartUnfold).toBe('function');
      // Function takes at least filePath + symbolName
      expect(smartUnfold.length).toBeGreaterThanOrEqual(2);
    });

    it('should return result with found, source, startLine, endLine, errors properties', async () => {
      const nexusModule = await import('@cleocode/nexus');
      const { smartUnfold } = nexusModule;

      // Call with a non-existent file to verify shape
      const result = smartUnfold('/nonexistent/file.ts', 'someSymbol');

      expect(result).toHaveProperty('found');
      expect(result).toHaveProperty('source');
      expect(result).toHaveProperty('startLine');
      expect(result).toHaveProperty('endLine');
      expect(result).toHaveProperty('errors');

      expect(typeof result.found).toBe('boolean');
      expect(typeof result.source).toBe('string');
      expect(typeof result.startLine).toBe('number');
      expect(typeof result.endLine).toBe('number');
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });

  describe('TC-004: source content assertion', () => {
    it('should extract function source when symbol is found', async () => {
      const nexusModule = await import('@cleocode/nexus');
      const { smartUnfold } = nexusModule;

      // Use this test file itself to extract a symbol
      const __filename = new URL(import.meta.url).pathname;
      const result = smartUnfold(__filename, 'describe');

      // Should either find it or return errors, but never both empty source and no errors
      if (result.found) {
        expect(result.source.length).toBeGreaterThan(0);
        expect(result.startLine).toBeGreaterThan(0);
        expect(result.endLine).toBeGreaterThanOrEqual(result.startLine);
      } else {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it('should return non-empty source string when extraction succeeds', async () => {
      const nexusModule = await import('@cleocode/nexus');
      const { smartUnfold } = nexusModule;

      const __filename = new URL(import.meta.url).pathname;
      const result = smartUnfold(__filename, 'describe');

      if (result.found) {
        // Source should contain actual code (not just whitespace)
        const trimmed = result.source.trim();
        expect(trimmed.length).toBeGreaterThan(0);

        // Source should likely contain the symbol name or function keyword
        const sourceWithoutWhitespace = result.source.replace(/\s+/g, ' ');
        expect(
          sourceWithoutWhitespace.toLowerCase().includes('describe') ||
            sourceWithoutWhitespace.toLowerCase().includes('function'),
        ).toBe(true);
      }
    });

    it('should set correct line number boundaries', async () => {
      const nexusModule = await import('@cleocode/nexus');
      const { smartUnfold } = nexusModule;

      const __filename = new URL(import.meta.url).pathname;
      const result = smartUnfold(__filename, 'describe');

      if (result.found) {
        // Line numbers should be positive and in order
        expect(result.startLine).toBeGreaterThan(0);
        expect(result.endLine).toBeGreaterThanOrEqual(result.startLine);

        // End line should be reasonable (not absurdly high)
        expect(result.endLine).toBeLessThan(10000);
      }
    });
  });

  describe('TC-005: error handling', () => {
    it('should gracefully handle missing files', async () => {
      const nexusModule = await import('@cleocode/nexus');
      const { smartUnfold } = nexusModule;

      const result = smartUnfold('/definitely/nonexistent/path.ts', 'someSymbol');

      // Should not throw, but return errors
      expect(result).toBeDefined();
      expect(result.errors).toBeDefined();
    });

    it('should return found=false for non-existent symbols', async () => {
      const nexusModule = await import('@cleocode/nexus');
      const { smartUnfold } = nexusModule;

      const __filename = new URL(import.meta.url).pathname;
      const result = smartUnfold(__filename, 'DEFINITELY_DOES_NOT_EXIST_SYMBOL_NAME_XYZ123');

      // Symbol not found case
      expect(result.found).toBe(false);
    });
  });

  describe('TC-006: smartSearch function availability', () => {
    it('should export a callable smartSearch function from @cleocode/nexus root', async () => {
      const nexusModule = await import('@cleocode/nexus');
      const { smartSearch } = nexusModule;

      expect(typeof smartSearch).toBe('function');
      expect(smartSearch.length).toBeGreaterThanOrEqual(1);
    });

    it('should accept query string and optional options parameter', async () => {
      const nexusModule = await import('@cleocode/nexus');
      const { smartSearch } = nexusModule;

      // Should accept at least query, optionally options
      const result = smartSearch('test');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return array of SmartSearchResult objects', async () => {
      const nexusModule = await import('@cleocode/nexus');
      const { smartSearch } = nexusModule;

      const results = smartSearch('describe');

      expect(Array.isArray(results)).toBe(true);
      if (results.length > 0) {
        const firstResult = results[0];
        expect(typeof firstResult).toBe('object');
        expect(firstResult).not.toBeNull();
      }
    });
  });
});
