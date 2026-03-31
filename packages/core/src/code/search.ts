/**
 * smart_search — cross-codebase symbol search via tree-sitter.
 *
 * Walks a directory tree, batch-parses code files by language, and
 * matches symbols against a query string with relevance scoring.
 *
 * @task T152
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CodeSymbol } from '@cleocode/contracts';
import { detectLanguage, type TreeSitterLanguage } from '../lib/tree-sitter-languages.js';
import { batchParse } from './parser.js';

/** A search result with relevance score. */
export interface SmartSearchResult {
  /** The matched symbol. */
  symbol: CodeSymbol;
  /** Relevance score (higher = better match). */
  score: number;
  /** How the query matched (exact, substring, fuzzy, path). */
  matchType: 'exact' | 'substring' | 'fuzzy' | 'path';
}

/** Options for smart_search. */
export interface SmartSearchOptions {
  /** Maximum results to return (default: 20). */
  maxResults?: number;
  /** Glob-like file pattern filter (e.g. "*.ts", "src/**"). */
  filePattern?: string;
  /** Restrict to specific language. */
  language?: TreeSitterLanguage;
  /** Root directory to search (default: cwd). */
  rootDir?: string;
}

/**
 * Walk a directory tree and collect source files.
 *
 * Respects common ignore patterns (node_modules, dist, .git, etc.)
 * and optionally filters by file pattern and language.
 */
function collectSourceFiles(dir: string, options: SmartSearchOptions): string[] {
  const IGNORE_DIRS = new Set([
    'node_modules',
    'dist',
    '.git',
    '.cleo',
    'target',
    '__pycache__',
    '.next',
    '.nuxt',
    'build',
    'coverage',
    '.turbo',
    '.cache',
  ]);

  const files: string[] = [];

  function walk(currentDir: string): void {
    let entries: { isDirectory(): boolean; isFile(): boolean; name: string }[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true, encoding: 'utf-8' }) as {
        isDirectory(): boolean;
        isFile(): boolean;
        name: string;
      }[];
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          walk(join(currentDir, entry.name));
        }
      } else if (entry.isFile()) {
        const fullPath = join(currentDir, entry.name);
        const lang = detectLanguage(entry.name);
        if (!lang) continue;

        // Language filter
        if (options.language && lang !== options.language) continue;

        // File pattern filter (simple glob: *.ext or dir/**)
        if (options.filePattern) {
          const relPath = relative(dir, fullPath);
          if (options.filePattern.startsWith('*.')) {
            const ext = options.filePattern.slice(1);
            if (!entry.name.endsWith(ext)) continue;
          } else if (!relPath.includes(options.filePattern.replace('/**', ''))) {
            continue;
          }
        }

        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

/**
 * Score a symbol against a query string.
 *
 * Scoring: exact name match (10) > substring in name (5) >
 * path match (3) > fuzzy (1).
 */
function scoreSymbol(
  symbol: CodeSymbol,
  query: string,
): { score: number; matchType: SmartSearchResult['matchType'] } {
  const q = query.toLowerCase();
  const name = symbol.name.toLowerCase();
  const path = symbol.filePath.toLowerCase();

  // Exact name match
  if (name === q) return { score: 10, matchType: 'exact' };

  // Substring in name
  if (name.includes(q)) return { score: 5, matchType: 'substring' };

  // Path match
  if (path.includes(q)) return { score: 3, matchType: 'path' };

  // Fuzzy: all query chars appear in order in the name
  let qi = 0;
  for (let ni = 0; ni < name.length && qi < q.length; ni++) {
    if (name[ni] === q[qi]) qi++;
  }
  if (qi === q.length) return { score: 1, matchType: 'fuzzy' };

  return { score: 0, matchType: 'fuzzy' };
}

/**
 * Search for symbols across a codebase.
 *
 * Walks the directory tree, batch-parses source files, and returns
 * symbols matching the query ranked by relevance score.
 *
 * @param query - Search string to match against symbol names and paths
 * @param options - Search options (maxResults, filePattern, language, rootDir)
 * @returns Ranked array of search results
 */
export function smartSearch(query: string, options: SmartSearchOptions = {}): SmartSearchResult[] {
  const rootDir = options.rootDir ?? process.cwd();
  const maxResults = options.maxResults ?? 20;

  // Collect and parse source files
  const files = collectSourceFiles(rootDir, options);
  const parsed = batchParse(files, rootDir);

  // Score all symbols
  const results: SmartSearchResult[] = [];
  for (const fileResult of parsed.results) {
    for (const symbol of fileResult.symbols) {
      const { score, matchType } = scoreSymbol(symbol, query);
      if (score > 0) {
        results.push({ symbol, score, matchType });
      }
    }
  }

  // Sort by score descending, then by name
  results.sort((a, b) => b.score - a.score || a.symbol.name.localeCompare(b.symbol.name));

  return results.slice(0, maxResults);
}
