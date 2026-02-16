/**
 * Project type detection and configuration.
 * Ported from lib/data/project-detect.sh and lib/data/project-registry.sh
 *
 * @epic T4454
 * @task T4530
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Detected project type. */
export type ProjectType =
  | 'node'
  | 'python'
  | 'rust'
  | 'go'
  | 'ruby'
  | 'java'
  | 'dotnet'
  | 'bash'
  | 'unknown';

/** Test framework. */
export type TestFramework =
  | 'jest'
  | 'vitest'
  | 'mocha'
  | 'pytest'
  | 'bats'
  | 'cargo-test'
  | 'go-test'
  | 'rspec'
  | 'junit'
  | 'unknown';

/** Project detection result. */
export interface ProjectInfo {
  type: ProjectType;
  testFramework: TestFramework;
  hasTypeScript: boolean;
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun';
  monorepo: boolean;
}

/**
 * Detect project type from directory contents.
 */
export function detectProjectType(projectDir: string): ProjectInfo {
  const exists = (f: string) => existsSync(join(projectDir, f));

  const info: ProjectInfo = {
    type: 'unknown',
    testFramework: 'unknown',
    hasTypeScript: false,
    monorepo: false,
  };

  // Node.js
  if (exists('package.json')) {
    info.type = 'node';
    info.hasTypeScript = exists('tsconfig.json');

    if (exists('yarn.lock')) info.packageManager = 'yarn';
    else if (exists('pnpm-lock.yaml')) info.packageManager = 'pnpm';
    else if (exists('bun.lockb')) info.packageManager = 'bun';
    else info.packageManager = 'npm';

    // Monorepo detection
    if (exists('lerna.json') || exists('pnpm-workspace.yaml') || exists('packages')) {
      info.monorepo = true;
    }

    // Test framework
    if (exists('vitest.config.ts') || exists('vitest.config.js')) info.testFramework = 'vitest';
    else if (exists('jest.config.ts') || exists('jest.config.js')) info.testFramework = 'jest';
    else if (exists('.mocharc.yml') || exists('.mocharc.json')) info.testFramework = 'mocha';
  }
  // Python
  else if (exists('pyproject.toml') || exists('setup.py') || exists('requirements.txt')) {
    info.type = 'python';
    info.testFramework = 'pytest';
  }
  // Rust
  else if (exists('Cargo.toml')) {
    info.type = 'rust';
    info.testFramework = 'cargo-test';
  }
  // Go
  else if (exists('go.mod')) {
    info.type = 'go';
    info.testFramework = 'go-test';
  }
  // Ruby
  else if (exists('Gemfile')) {
    info.type = 'ruby';
    info.testFramework = 'rspec';
  }
  // Java
  else if (exists('pom.xml') || exists('build.gradle') || exists('build.gradle.kts')) {
    info.type = 'java';
    info.testFramework = 'junit';
  }
  // .NET (glob: existsSync doesn't support wildcards, check directory)
  else if (hasFileWithExtension(projectDir, '.csproj') || hasFileWithExtension(projectDir, '.sln')) {
    info.type = 'dotnet';
  }
  // Bash/Shell
  else if (exists('tests') && exists('install.sh')) {
    info.type = 'bash';
    if (exists('tests/unit') || exists('tests/integration')) {
      info.testFramework = 'bats';
    }
  }

  return info;
}

/** Check if a directory contains any file with the given extension. */
function hasFileWithExtension(dir: string, ext: string): boolean {
  try {
    const entries = readdirSync(dir);
    return entries.some(e => e.endsWith(ext));
  } catch {
    return false;
  }
}
