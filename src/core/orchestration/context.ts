/**
 * Context estimation for orchestration.
 *
 * Estimates token usage and provides context budget recommendations
 * for orchestrator operations.
 *
 * @task T5702
 */

import { existsSync, readFileSync } from 'node:fs';
import { getManifestPath as getCentralManifestPath } from '../paths.js';

/** Context estimation result. */
export interface ContextEstimation {
  epicId: string | null;
  taskCount: number;
  manifestEntries: number;
  estimatedTokens: number;
  recommendation: string;
  limits: {
    orchestratorBudget: number;
    maxFilesPerAgent: number;
    currentUsage: number;
  };
}

/**
 * Count manifest entries from MANIFEST.jsonl.
 *
 * @param projectRoot - The project root directory
 * @returns Number of manifest entries
 */
export function countManifestEntries(projectRoot: string): number {
  const manifestPath = getCentralManifestPath(projectRoot);
  if (!existsSync(manifestPath)) {
    return 0;
  }
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    return content.split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * Estimate context usage for orchestration.
 *
 * @param taskCount - Number of tasks to estimate for
 * @param projectRoot - The project root directory
 * @param epicId - Optional epic ID for scoped estimation
 * @returns Context estimation with recommendations
 */
export function estimateContext(
  taskCount: number,
  projectRoot: string,
  epicId?: string,
): ContextEstimation {
  const estimatedTokens = taskCount * 100;
  const manifestEntries = countManifestEntries(projectRoot);

  return {
    epicId: epicId || null,
    taskCount,
    manifestEntries,
    estimatedTokens,
    recommendation:
      estimatedTokens > 5000
        ? 'Consider using manifest summaries instead of full task details'
        : 'Context usage is within recommended limits',
    limits: {
      orchestratorBudget: 10000,
      maxFilesPerAgent: 3,
      currentUsage: estimatedTokens,
    },
  };
}
