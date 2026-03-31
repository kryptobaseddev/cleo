/**
 * Code analysis engine — dispatch wrapper for Smart Explore operations.
 *
 * Wraps @cleocode/core code analysis functions (parseFile, smartOutline,
 * smartSearch, smartUnfold) for use via dispatch/MCP gateway.
 *
 * @task T154
 */

import { join } from 'node:path';
import { getProjectRoot } from '@cleocode/core';

/** code.outline — file structural skeleton. */
export async function codeOutline(params?: Record<string, unknown>) {
  const { smartOutline } = await import('@cleocode/core/internal');
  const filePath = params?.file as string | undefined;
  if (!filePath) return { success: false, error: 'file parameter required' };
  const root = getProjectRoot();
  const absPath = filePath.startsWith('/') ? filePath : join(root, filePath);
  return { success: true, result: smartOutline(absPath, root) };
}

/** code.search — cross-codebase symbol search. */
export async function codeSearch(params?: Record<string, unknown>) {
  const { smartSearch } = await import('@cleocode/core/internal');
  const query = params?.query as string | undefined;
  if (!query) return { success: false, error: 'query parameter required' };
  const root = getProjectRoot();
  return {
    success: true,
    result: smartSearch(query, {
      rootDir: root,
      maxResults: (params?.max as number) ?? 20,
      language: params?.lang as Parameters<typeof smartSearch>[1]['language'],
      filePattern: params?.path as string | undefined,
    }),
  };
}

/** code.unfold — single symbol extraction. */
export async function codeUnfold(params?: Record<string, unknown>) {
  const { smartUnfold } = await import('@cleocode/core/internal');
  const filePath = params?.file as string | undefined;
  const symbol = params?.symbol as string | undefined;
  if (!filePath || !symbol) return { success: false, error: 'file and symbol parameters required' };
  const root = getProjectRoot();
  const absPath = filePath.startsWith('/') ? filePath : join(root, filePath);
  return { success: true, result: smartUnfold(absPath, symbol, root) };
}

/** code.parse — raw AST parse for a single file. */
export async function codeParse(params?: Record<string, unknown>) {
  const { parseFile } = await import('@cleocode/core/internal');
  const filePath = params?.file as string | undefined;
  if (!filePath) return { success: false, error: 'file parameter required' };
  const root = getProjectRoot();
  const absPath = filePath.startsWith('/') ? filePath : join(root, filePath);
  return { success: true, result: parseFile(absPath, root) };
}
