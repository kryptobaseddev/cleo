/**
 * Static adapter registry — maps adapter IDs to async factory functions.
 *
 * Replaces dynamic import() of file paths in AdapterManager.activate()
 * to ensure adapters work in both dev (TypeScript) and prod (esbuild bundle).
 *
 * Uses lazy imports to avoid eagerly loading adapter code (which pulls in
 * node:child_process etc.) at module evaluation time.
 *
 * Note: esbuild must NOT externalize @cleocode/adapter-* packages.
 * The build.mjs config uses a custom plugin to bundle them inline.
 *
 * @task T5698
 */

import type { CLEOProviderAdapter } from '@cleocode/contracts';

export const ADAPTER_REGISTRY: Record<string, () => Promise<CLEOProviderAdapter>> = {
  'claude-code': async () => {
    const { ClaudeCodeAdapter } = await import('@cleocode/adapter-claude-code');
    return new ClaudeCodeAdapter();
  },
  opencode: async () => {
    const { OpenCodeAdapter } = await import('@cleocode/adapter-opencode');
    return new OpenCodeAdapter();
  },
  cursor: async () => {
    const { CursorAdapter } = await import('@cleocode/adapter-cursor');
    return new CursorAdapter();
  },
};
