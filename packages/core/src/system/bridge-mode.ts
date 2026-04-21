/**
 * Shared helper: resolve the memory/nexus bridge injection mode from project config.
 *
 * Both `memory-bridge.ts` and `nexus-bridge.ts` gate their `writeFileSync`
 * calls on the same `brain.memoryBridge.mode` config key. Centralising the
 * lookup keeps their behaviour aligned and prevents the T999-style drift
 * where one sibling silently ignored the gate.
 *
 * Behaviour:
 *   - `'cli'`  — AGENTS.md gets a `cleo memory digest --brief` directive; no `.md` files written.
 *   - `'file'` — legacy `@.cleo/memory-bridge.md` + `@.cleo/nexus-bridge.md` injection.
 *
 * The resolver never throws. On any read/parse failure it returns the safe
 * default `'cli'` (matches {@link DEFAULT_CONFIG}).
 *
 * @task T999
 * @task T1013
 */

import type { MemoryBridgeMode } from '@cleocode/contracts';

/**
 * Resolve the memory/nexus bridge injection mode from project config.
 * Never throws. Returns `'cli'` on any failure (matches DEFAULT_CONFIG).
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns `'cli'` (default) or `'file'` (legacy file-injection mode).
 */
export async function resolveBridgeMode(projectRoot: string): Promise<MemoryBridgeMode> {
  try {
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig(projectRoot);
    return config.brain?.memoryBridge?.mode ?? 'cli';
  } catch {
    return 'cli';
  }
}
