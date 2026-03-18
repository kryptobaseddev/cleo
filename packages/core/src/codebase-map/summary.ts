/**
 * Generate a markdown summary of a CodebaseMapResult.
 * Format mirrors memory-bridge.md for agent consumption.
 */

import type { CodebaseMapResult } from './index.js';

export function generateCodebaseMapSummary(result: CodebaseMapResult): string {
  const lines: string[] = [];

  lines.push('# Codebase Map');
  lines.push('');
  lines.push(`**Analyzed**: ${result.analyzedAt}`);
  lines.push(`**Project type**: ${result.projectContext.primaryType ?? 'unknown'}`);
  if (result.projectContext.monorepo) lines.push('**Monorepo**: yes');
  lines.push('');

  // Stack
  lines.push('## Stack');
  lines.push('');
  if (result.stack.languages.length > 0) {
    lines.push(`**Languages**: ${result.stack.languages.join(', ')}`);
  }
  if (result.stack.frameworks.length > 0) {
    lines.push(`**Frameworks**: ${result.stack.frameworks.join(', ')}`);
  }
  if (result.stack.packageManager) {
    lines.push(`**Package manager**: ${result.stack.packageManager}`);
  }
  if (result.stack.runtime) {
    lines.push(`**Runtime**: ${result.stack.runtime}`);
  }
  const prodDeps = result.stack.dependencies.filter((d) => !d.dev).length;
  const devDeps = result.stack.dependencies.filter((d) => d.dev).length;
  if (prodDeps + devDeps > 0) {
    lines.push(`**Dependencies**: ${prodDeps} production, ${devDeps} dev`);
  }
  lines.push('');

  // Architecture
  lines.push('## Architecture');
  lines.push('');
  if (result.architecture.patterns.length > 0) {
    lines.push(`**Patterns detected**: ${result.architecture.patterns.join(', ')}`);
    lines.push('');
  }
  if (result.architecture.layers.length > 0) {
    lines.push('**Layers**:');
    for (const layer of result.architecture.layers) {
      lines.push(`- \`${layer.path}\` — ${layer.purpose}`);
    }
    lines.push('');
  }
  if (result.architecture.entryPoints.length > 0) {
    lines.push('**Entry points**:');
    for (const ep of result.architecture.entryPoints) {
      lines.push(`- \`${ep.path}\` (${ep.type})`);
    }
    lines.push('');
  }

  // Structure
  lines.push('## Structure');
  lines.push('');
  lines.push(`**Total files**: ${result.structure.totalFiles}`);
  if (result.structure.directories.length > 0) {
    lines.push('');
    lines.push('**Top directories**:');
    const topDirs = result.structure.directories
      .filter((d) => !d.path.includes('/'))
      .sort((a, b) => b.fileCount - a.fileCount)
      .slice(0, 8);
    for (const dir of topDirs) {
      lines.push(`- \`${dir.path}/\` — ${dir.purpose} (${dir.fileCount} files)`);
    }
  }
  lines.push('');

  // Conventions
  lines.push('## Conventions');
  lines.push('');
  lines.push(`**File naming**: ${result.conventions.fileNaming}`);
  lines.push(`**Import style**: ${result.conventions.importStyle}`);
  if (result.conventions.typeSystem)
    lines.push(`**Type system**: ${result.conventions.typeSystem}`);
  if (result.conventions.linter) lines.push(`**Linter**: ${result.conventions.linter}`);
  if (result.conventions.formatter) lines.push(`**Formatter**: ${result.conventions.formatter}`);
  if (result.conventions.errorHandling)
    lines.push(`**Error handling**: ${result.conventions.errorHandling}`);
  lines.push('');

  // Testing
  lines.push('## Testing');
  lines.push('');
  lines.push(`**Framework**: ${result.testing.framework}`);
  if (result.testing.directories.length > 0) {
    lines.push(`**Directories**: ${result.testing.directories.join(', ')}`);
  }
  if (result.testing.patterns.length > 0) {
    lines.push(`**Patterns**: ${result.testing.patterns.join(', ')}`);
  }
  const testFeatures: string[] = [];
  if (result.testing.hasFixtures) testFeatures.push('fixtures');
  if (result.testing.hasMocks) testFeatures.push('mocks');
  if (result.testing.coverageConfigured) testFeatures.push('coverage configured');
  if (testFeatures.length > 0) lines.push(`**Features**: ${testFeatures.join(', ')}`);
  lines.push('');

  // Integrations
  const hasIntegrations =
    result.integrations.apis.length > 0 ||
    result.integrations.databases.length > 0 ||
    result.integrations.auth.length > 0 ||
    result.integrations.cicd.length > 0 ||
    result.integrations.containerized;

  if (hasIntegrations) {
    lines.push('## Integrations');
    lines.push('');
    if (result.integrations.apis.length > 0) {
      lines.push(`**APIs**: ${result.integrations.apis.join(', ')}`);
    }
    if (result.integrations.databases.length > 0) {
      lines.push(`**Databases**: ${result.integrations.databases.join(', ')}`);
    }
    if (result.integrations.auth.length > 0) {
      lines.push(`**Auth**: ${result.integrations.auth.join(', ')}`);
    }
    if (result.integrations.cicd.length > 0) {
      lines.push(`**CI/CD**: ${result.integrations.cicd.join(', ')}`);
    }
    if (result.integrations.containerized) {
      lines.push('**Containerized**: yes');
    }
    lines.push('');
  }

  // Concerns
  const hasConcerns = result.concerns.todos.length > 0 || result.concerns.largeFiles.length > 0;

  if (hasConcerns) {
    lines.push('## Concerns');
    lines.push('');
    const { high, medium, low } = result.concerns.complexity;
    lines.push(
      `**Complexity**: ${high} high (>500 lines), ${medium} medium (200-500), ${low} low (<200)`,
    );
    if (result.concerns.todos.length > 0) {
      lines.push(`**TODOs/FIXMEs**: ${result.concerns.todos.length} found`);
    }
    if (result.concerns.largeFiles.length > 0) {
      lines.push('**Large files**:');
      for (const f of result.concerns.largeFiles.slice(0, 5)) {
        lines.push(`- \`${f.path}\` (${f.lines} lines)`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
