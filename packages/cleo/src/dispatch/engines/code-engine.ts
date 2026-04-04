/**
 * Code analysis engine — dispatch wrapper for Smart Explore operations.
 *
 * Wraps @cleocode/core code analysis functions (parseFile, smartOutline,
 * smartSearch, smartUnfold) for use via the dispatch gateway.
 *
 * @task T154
 */

import { join } from 'node:path';
import { getProjectRoot } from '@cleocode/core';
import type { EngineResult } from '@cleocode/core/internal';

/** code.outline — file structural skeleton. */
export async function codeOutline(params?: Record<string, unknown>): Promise<EngineResult> {
  const { smartOutline } = await import('@cleocode/core/internal');
  const filePath = params?.file as string | undefined;
  if (!filePath)
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'file parameter required' },
    };
  const root = getProjectRoot();
  const absPath = filePath.startsWith('/') ? filePath : join(root, filePath);
  return { success: true, data: smartOutline(absPath, root) };
}

/** code.search — cross-codebase symbol search. */
export async function codeSearch(params?: Record<string, unknown>): Promise<EngineResult> {
  type SmartSearchOptions = import('@cleocode/core/internal').SmartSearchOptions;
  const { smartSearch } = await import('@cleocode/core/internal');
  const query = params?.query as string | undefined;
  if (!query)
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'query parameter required' },
    };
  const root = getProjectRoot();
  const opts: SmartSearchOptions = {
    rootDir: root,
    maxResults: (params?.max as number) ?? 20,
    filePattern: params?.path as string | undefined,
  };
  if (params?.lang) {
    opts.language = params.lang as SmartSearchOptions['language'];
  }
  return { success: true, data: smartSearch(query, opts) };
}

/** code.unfold — single symbol extraction. */
export async function codeUnfold(params?: Record<string, unknown>): Promise<EngineResult> {
  const { smartUnfold } = await import('@cleocode/core/internal');
  const filePath = params?.file as string | undefined;
  const symbol = params?.symbol as string | undefined;
  if (!filePath || !symbol)
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'file and symbol parameters required' },
    };
  const root = getProjectRoot();
  const absPath = filePath.startsWith('/') ? filePath : join(root, filePath);
  return { success: true, data: smartUnfold(absPath, symbol, root) };
}

/** code.parse — raw AST parse for a single file. */
export async function codeParse(params?: Record<string, unknown>): Promise<EngineResult> {
  const { parseFile } = await import('@cleocode/core/internal');
  const filePath = params?.file as string | undefined;
  if (!filePath)
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'file parameter required' },
    };
  const root = getProjectRoot();
  const absPath = filePath.startsWith('/') ? filePath : join(root, filePath);
  return { success: true, data: parseFile(absPath, root) };
}
