/**
 * File Change Hook Handlers - Wave 2 of T5237
 *
 * Captures file change events to BRAIN via memory.observe.
 * Includes 5-second dedup and path-based filtering to avoid noisy writes.
 * Auto-registers on module load.
 *
 * Disabled by default. Enable via:
 *   - Config: brain.captureFiles = true  (checked first)
 *   - Env:    CLEO_BRAIN_CAPTURE_FILES=true  (overrides config)
 */

import { isAbsolute, relative } from 'node:path';
import { hooks } from '../registry.js';
import type { NotificationPayload } from '../types.js';

function isMissingBrainSchemaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = String(err.message || '').toLowerCase();
  return message.includes('no such table') && message.includes('brain_');
}

/** 5-second dedup map: filePath -> last dispatch timestamp */
const recentWrites = new Map<string, number>();
const DEDUP_INTERVAL_MS = 5_000;

/** Path patterns to exclude from brain observations (internal/noisy files). */
const SKIP_PATTERNS: readonly RegExp[] = [
  /\.cleo\//, // All .cleo internal files (sessions.json, config.json, tasks.db, etc.)
  /\.cleo\\/, // Windows path variant
  /\/\.temp\//, // Temp directories
  /cleo-test-/, // Vitest test temp dirs
  /cleo-edge-/, // Edge-case test temp dirs
  /node_modules\//, // Dependencies
  /\.git\//, // Git internals
  /dist\//, // Build output
];

/** Check whether a relative path should be skipped. */
function shouldSkipPath(relativePath: string): boolean {
  return SKIP_PATTERNS.some((pattern) => pattern.test(relativePath));
}

/**
 * Check whether file-change capture is enabled.
 *
 * Resolution order (first truthy wins):
 *   1. CLEO_BRAIN_CAPTURE_FILES env var (explicit override)
 *   2. brain.captureFiles project config value
 *
 * Defaults to false when neither is set.
 */
async function isFileCaptureEnabled(projectRoot: string): Promise<boolean> {
  const envOverride = process.env['CLEO_BRAIN_CAPTURE_FILES'];
  if (envOverride !== undefined) {
    return envOverride === 'true';
  }
  try {
    const { loadConfig } = await import('../../config.js');
    const config = await loadConfig(projectRoot);
    return config.brain?.captureFiles ?? false;
  } catch {
    return false;
  }
}

/**
 * Handle Notification (file-change variant) - capture file changes to BRAIN
 *
 * Gated behind brain.captureFiles config or CLEO_BRAIN_CAPTURE_FILES env var.
 * Env var takes precedence over config for backward compatibility.
 * Deduplicates rapid writes to the same file within a 5-second window.
 * Filters out .cleo/ internal files and test temp directories.
 * Converts absolute paths to project-relative paths.
 */
export async function handleFileChange(
  projectRoot: string,
  payload: NotificationPayload,
): Promise<void> {
  // Only handle file-change notifications
  if (!payload.filePath || !payload.changeType) return;
  // Opt-in gate: disabled by default to prevent observation noise
  if (!(await isFileCaptureEnabled(projectRoot))) return;

  // 5-second dedup
  const now = Date.now();
  const lastWrite = recentWrites.get(payload.filePath);
  if (lastWrite && now - lastWrite < DEDUP_INTERVAL_MS) return;
  recentWrites.set(payload.filePath, now);

  // Convert absolute paths to relative, normalize to forward slashes
  const relativePath = (
    isAbsolute(payload.filePath) ? relative(projectRoot, payload.filePath) : payload.filePath
  ).replaceAll('\\', '/');

  // Skip internal/noisy files
  if (shouldSkipPath(relativePath)) return;

  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  try {
    await observeBrain(projectRoot, {
      text: `File ${payload.changeType}: ${relativePath}${payload.sizeBytes != null ? ` (${payload.sizeBytes} bytes)` : ''}`,
      title: `File changed: ${relativePath}`,
      type: 'change',
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

// Register handler on module load
hooks.register({
  id: 'brain-file-change',
  event: 'Notification',
  handler: handleFileChange,
  priority: 100,
});
