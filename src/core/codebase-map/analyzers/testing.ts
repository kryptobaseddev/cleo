/**
 * Testing analyzer — detects test framework details, patterns, directories, fixtures, mocks, coverage.
 * Extends projectContext.testing with structural details.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectContext } from '../../../store/project-detect.js';
import type { TestingAnalysis } from '../index.js';

export function analyzeTesting(projectRoot: string, projectContext: ProjectContext): TestingAnalysis {
  const framework = projectContext.testing?.framework ?? 'unknown';
  const patterns: string[] = [];
  const directories: string[] = [];

  // Collect test directories from projectContext
  if (projectContext.testing?.directories?.unit) {
    directories.push(projectContext.testing.directories.unit);
  }
  if (projectContext.testing?.directories?.integration) {
    directories.push(projectContext.testing.directories.integration);
  }

  // Scan for additional test dirs
  const commonTestDirs = ['tests', 'test', 'spec', '__tests__', 'e2e', 'tests/e2e', 'tests/integration', 'tests/unit'];
  for (const dir of commonTestDirs) {
    if (existsSync(join(projectRoot, dir)) && !directories.includes(dir)) {
      directories.push(dir);
    }
  }

  // Detect test patterns from config or package.json
  if (framework === 'vitest' || framework === 'jest') {
    patterns.push('describe/it blocks', 'expect assertions');
    if (existsSync(join(projectRoot, 'vitest.config.ts')) || existsSync(join(projectRoot, 'vitest.config.js'))) {
      patterns.push('vitest projects');
    }
  } else if (framework === 'mocha') {
    patterns.push('describe/it blocks', 'assert/expect');
  } else if (framework === 'pytest') {
    patterns.push('test_ prefix functions', 'assert statements');
  } else if (framework === 'bats') {
    patterns.push('@test annotations');
  } else if (framework === 'cargo') {
    patterns.push('#[test] annotations', '#[cfg(test)] modules');
  } else if (framework === 'go') {
    patterns.push('TestXxx functions', 't.Run subtests');
  }

  const hasFixtures = detectFixtures(projectRoot);
  const hasMocks = detectMocks(projectRoot);
  const coverageConfigured = detectCoverage(projectRoot, framework);

  return {
    framework,
    patterns,
    directories,
    hasFixtures,
    hasMocks,
    coverageConfigured,
  };
}

function detectFixtures(projectRoot: string): boolean {
  return (
    existsSync(join(projectRoot, 'tests/fixtures')) ||
    existsSync(join(projectRoot, 'test/fixtures')) ||
    existsSync(join(projectRoot, '__fixtures__')) ||
    existsSync(join(projectRoot, 'fixtures'))
  );
}

function detectMocks(projectRoot: string): boolean {
  return (
    existsSync(join(projectRoot, '__mocks__')) ||
    existsSync(join(projectRoot, 'tests/mocks')) ||
    existsSync(join(projectRoot, 'test/mocks')) ||
    existsSync(join(projectRoot, 'mocks'))
  );
}

function detectCoverage(projectRoot: string, framework: string): boolean {
  // Check vitest config for coverage
  if (framework === 'vitest') {
    for (const configFile of ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts']) {
      try {
        const content = readFileSync(join(projectRoot, configFile), 'utf-8');
        if (content.includes('coverage')) return true;
      } catch {
        // ignore
      }
    }
  }

  // Check jest config
  if (framework === 'jest') {
    for (const configFile of ['jest.config.ts', 'jest.config.js', 'jest.config.mjs']) {
      try {
        const content = readFileSync(join(projectRoot, configFile), 'utf-8');
        if (content.includes('coverage') || content.includes('collectCoverage')) return true;
      } catch {
        // ignore
      }
    }
  }

  // Check package.json for coverage scripts
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    return Object.values(scripts).some((s) => s.includes('coverage') || s.includes('--coverage'));
  } catch {
    return false;
  }
}
