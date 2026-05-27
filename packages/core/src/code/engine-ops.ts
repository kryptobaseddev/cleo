/**
 * Code Engine Operations — EngineResult wrappers for code analysis domain.
 *
 * Migrated from `packages/cleo/src/dispatch/engines/code-engine.ts`
 * (ENG-MIG-16 / T1583 / ADR-057 D1). All business logic delegates to
 * the canonical implementations in `./outline.ts`, `./search.ts`,
 * `./unfold.ts`, and `./parser.ts` from `@cleocode/nexus`.
 *
 * Importable from `@cleocode/core/internal` — no intermediate engine file
 * required in the CLI layer.
 *
 * @module code/engine-ops
 * @task T1583 — ENG-MIG-16
 * @epic T1566
 */

import { join } from 'node:path';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import type { SmartSearchOptions } from './index.js';
import { smartOutline } from './outline.js';
import { parseFile } from './parser.js';
import { smartSearch } from './search.js';
import { smartUnfold } from './unfold.js';

// ---------------------------------------------------------------------------
// codeOutline
// ---------------------------------------------------------------------------

/**
 * Generate a structural skeleton outline for a source file.
 *
 * Returns a tree of symbols with signatures only (bodies collapsed),
 * suitable for giving agents a quick structural overview.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param params - Operation parameters; `file` (string, required), relative or absolute path.
 * @returns EngineResult with SmartOutlineResult on success.
 * @task T1583 — ENG-MIG-16
 */
export async function codeOutline(
  projectRoot: string,
  params?: Record<string, unknown>,
): Promise<EngineResult> {
  const filePath = params?.file as string | undefined;
  if (!filePath) {
    return engineError('E_INVALID_INPUT', 'file parameter required');
  }
  const absPath = filePath.startsWith('/') ? filePath : join(projectRoot, filePath);
  return engineSuccess(smartOutline(absPath, projectRoot));
}

// ---------------------------------------------------------------------------
// codeSearch
// ---------------------------------------------------------------------------

/**
 * Search for symbols across the codebase by name or path.
 *
 * Walks the project directory tree, batch-parses source files, and returns
 * symbols matching the query ranked by relevance score.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param params - Operation parameters; `query` (string, required), `max` (number), `path` (string), `lang` (string).
 * @returns EngineResult with array of SmartSearchResult on success.
 * @task T1583 — ENG-MIG-16
 */
export async function codeSearch(
  projectRoot: string,
  params?: Record<string, unknown>,
): Promise<EngineResult> {
  const query = params?.query as string | undefined;
  if (!query) {
    return engineError('E_INVALID_INPUT', 'query parameter required');
  }
  const opts: SmartSearchOptions = {
    rootDir: projectRoot,
    maxResults: (params?.max as number) ?? 20,
    filePattern: params?.path as string | undefined,
  };
  if (params?.lang) {
    opts.language = params.lang as SmartSearchOptions['language'];
  }
  return engineSuccess(smartSearch(query, opts));
}

// ---------------------------------------------------------------------------
// codeUnfold
// ---------------------------------------------------------------------------

/**
 * Extract the complete source of a single named symbol from a file.
 *
 * Includes JSDoc/docstring, decorators, and the full body. AST node
 * boundaries guarantee no truncation.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param params - Operation parameters; `file` (string, required), `symbol` (string, required).
 * @returns EngineResult with SmartUnfoldResult on success.
 * @task T1583 — ENG-MIG-16
 */
export async function codeUnfold(
  projectRoot: string,
  params?: Record<string, unknown>,
): Promise<EngineResult> {
  const filePath = params?.file as string | undefined;
  const symbol = params?.symbol as string | undefined;
  if (!filePath || !symbol) {
    return engineError('E_INVALID_INPUT', 'file and symbol parameters required');
  }
  const absPath = filePath.startsWith('/') ? filePath : join(projectRoot, filePath);
  return engineSuccess(smartUnfold(absPath, symbol, projectRoot));
}

// ---------------------------------------------------------------------------
// codeParse
// ---------------------------------------------------------------------------

/**
 * Raw AST parse for a single file — extracts all code symbols.
 *
 * Uses tree-sitter native bindings. Returns all symbols found in the file
 * without collapsing bodies (lower-level than `codeOutline`).
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param params - Operation parameters; `file` (string, required).
 * @returns EngineResult with ParseResult on success.
 * @task T1583 — ENG-MIG-16
 */
export async function codeParse(
  projectRoot: string,
  params?: Record<string, unknown>,
): Promise<EngineResult> {
  const filePath = params?.file as string | undefined;
  if (!filePath) {
    return engineError('E_INVALID_INPUT', 'file parameter required');
  }
  const absPath = filePath.startsWith('/') ? filePath : join(projectRoot, filePath);
  return engineSuccess(parseFile(absPath, projectRoot));
}
