/**
 * Persist CodebaseMapResult to brain.db.
 * Uses storePattern for architectural patterns, storeLearning for insights,
 * and observeBrain for general observations.
 * All entries tagged with source: 'codebase-map'.
 */

import type { CodebaseMapResult } from './index.js';

export async function storeMapToBrain(
  projectRoot: string,
  result: CodebaseMapResult,
): Promise<{ patternsStored: number; learningsStored: number; observationsStored: number }> {
  let patternsStored = 0;
  let learningsStored = 0;
  let observationsStored = 0;

  try {
    const { storePattern } = await import('../memory/patterns.js');
    const { storeLearning } = await import('../memory/learnings.js');
    const { observeBrain } = await import('../memory/brain-retrieval.js');

    // Store architectural patterns
    for (const pattern of result.architecture.patterns) {
      try {
        await storePattern(projectRoot, {
          type: 'workflow',
          pattern: `Architecture: ${pattern}`,
          context: `Detected architectural pattern in codebase at ${result.analyzedAt}. Source: codebase-map.`,
          impact: 'medium',
          examples: result.architecture.layers.map((l) => l.path),
        });
        patternsStored++;
      } catch {
        // best-effort
      }
    }

    // Store stack as observation
    try {
      const stackSummary = [
        `Languages: ${result.stack.languages.join(', ') || 'none detected'}`,
        `Frameworks: ${result.stack.frameworks.join(', ') || 'none detected'}`,
        `Package manager: ${result.stack.packageManager ?? 'unknown'}`,
        `Runtime: ${result.stack.runtime ?? 'unknown'}`,
        `Dependencies: ${result.stack.dependencies.filter((d) => !d.dev).length} prod, ${result.stack.dependencies.filter((d) => d.dev).length} dev`,
      ].join('\n');

      await observeBrain(projectRoot, {
        text: `Codebase stack analysis (source: codebase-map):\n${stackSummary}`,
        title: 'Codebase Stack Analysis',
        type: 'discovery',
        sourceType: 'agent',
      });
      observationsStored++;
    } catch {
      // best-effort
    }

    // Store concerns as learnings
    if (result.concerns.largeFiles.length > 0) {
      try {
        const fileList = result.concerns.largeFiles
          .slice(0, 5)
          .map((f) => `${f.path} (${f.lines} lines)`)
          .join(', ');
        await storeLearning(projectRoot, {
          insight: `Large files detected that may need refactoring: ${fileList}. Source: codebase-map.`,
          source: 'codebase-map',
          confidence: 0.7,
          actionable: true,
        });
        learningsStored++;
      } catch {
        // best-effort
      }
    }

    if (result.concerns.todos.length > 0) {
      try {
        await storeLearning(projectRoot, {
          insight: `${result.concerns.todos.length} TODO/FIXME comments found in source. Source: codebase-map.`,
          source: 'codebase-map',
          confidence: 0.8,
          actionable: true,
        });
        learningsStored++;
      } catch {
        // best-effort
      }
    }

    // Store integration summary
    const hasIntegrations =
      result.integrations.apis.length > 0 ||
      result.integrations.databases.length > 0 ||
      result.integrations.auth.length > 0;

    if (hasIntegrations) {
      try {
        const integrationSummary = [
          result.integrations.apis.length > 0 ? `APIs: ${result.integrations.apis.join(', ')}` : null,
          result.integrations.databases.length > 0 ? `Databases: ${result.integrations.databases.join(', ')}` : null,
          result.integrations.auth.length > 0 ? `Auth: ${result.integrations.auth.join(', ')}` : null,
          result.integrations.containerized ? 'Containerized: yes' : null,
        ].filter(Boolean).join('\n');

        await observeBrain(projectRoot, {
          text: `Codebase integrations (source: codebase-map):\n${integrationSummary}`,
          title: 'Codebase Integrations',
          type: 'discovery',
          sourceType: 'agent',
        });
        observationsStored++;
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort — if brain.db is unavailable, return zeros
  }

  return { patternsStored, learningsStored, observationsStored };
}
