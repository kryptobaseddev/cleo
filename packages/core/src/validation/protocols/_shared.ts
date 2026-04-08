/**
 * Shared helpers for the per-protocol "load by task id" wrapper functions.
 *
 * The pure validators live in `orchestration/protocol-validators.ts` — this
 * module is only about bridging the legacy taskId/manifestFile entry points
 * (used by the CLI / dispatch layer) to those pure validators.
 *
 * @task T260
 */

import { existsSync, readFileSync } from 'node:fs';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../../errors.js';
import type {
  ManifestEntryInput,
  ProtocolType,
  ProtocolValidationResult,
} from '../../orchestration/protocol-validators.js';
import { PROTOCOL_EXIT_CODES } from '../../orchestration/protocol-validators.js';
import { getManifestPath } from '../../paths.js';

/**
 * Locate the manifest line for a given task ID, reading from the end of the
 * file so the most recent entry wins.
 *
 * @task T260
 */
export function findManifestEntry(taskId: string, manifestPath: string): string | null {
  if (!existsSync(manifestPath)) return null;
  const content = readFileSync(manifestPath, 'utf-8').trim();
  if (content.length === 0) return null;
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line && line.includes(`"${taskId}"`)) return line;
  }
  return null;
}

/**
 * Load a manifest entry by task ID from the canonical manifest file.
 *
 * @task T260
 */
export function loadManifestEntryByTaskId(taskId: string): ManifestEntryInput {
  const manifestPath = getManifestPath();
  const entry = findManifestEntry(taskId, manifestPath);
  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `No manifest entry found for task ${taskId}`, {
      fix: `Ensure the agent wrote a manifest entry for ${taskId} before validation`,
      details: { field: 'taskId', actual: taskId },
    });
  }
  return JSON.parse(entry) as ManifestEntryInput;
}

/**
 * Load a manifest entry from an arbitrary JSON file (used by the `manifest`
 * dispatch mode where the caller already has a serialized entry).
 *
 * @task T260
 */
export function loadManifestEntryFromFile(manifestFile: string): ManifestEntryInput {
  if (!existsSync(manifestFile)) {
    throw new CleoError(ExitCode.NOT_FOUND, `Manifest file not found: ${manifestFile}`, {
      fix: `Ensure the manifest file exists at: ${manifestFile}`,
      details: { field: 'manifestFile', actual: manifestFile },
    });
  }
  return JSON.parse(readFileSync(manifestFile, 'utf-8')) as ManifestEntryInput;
}

/**
 * Throw a CleoError with the protocol's canonical exit code when strict
 * validation fails.
 *
 * @task T260
 */
export function throwIfStrictFailed(
  result: ProtocolValidationResult,
  opts: { strict?: boolean },
  protocol: ProtocolType,
  taskId: string,
): void {
  if (!opts.strict || result.valid) return;
  const code = PROTOCOL_EXIT_CODES[protocol];
  const errorViolations = result.violations.filter((v) => v.severity === 'error');
  throw new CleoError(
    code,
    `${protocol} protocol violations for ${taskId}: ${errorViolations.map((v) => v.message).join('; ')}`,
    {
      fix: `Review ${protocol} protocol requirements and correct the listed violations`,
      details: { field: 'protocol', actual: protocol },
    },
  );
}
