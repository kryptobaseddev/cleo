/**
 * Project type detection and configuration.
 * Produces schema-compliant ProjectContext for project-context.json.
 *
 * @epic T4454
 * @task T4530
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  | 'elixir'
  | 'php'
  | 'deno'
  | 'bun'
  | 'unknown';

/** Test framework. */
export type TestFramework =
  | 'jest'
  | 'vitest'
  | 'mocha'
  | 'pytest'
  | 'bats'
  | 'cargo'
  | 'go'
  | 'rspec'
  | 'junit'
  | 'playwright'
  | 'cypress'
  | 'ava'
  | 'uvu'
  | 'tap'
  | 'node:test'
  | 'deno'
  | 'bun'
  | 'custom'
  | 'unknown';

export type FileNamingConvention = 'kebab-case' | 'snake_case' | 'camelCase' | 'PascalCase';
export type ImportStyle = 'esm' | 'commonjs' | 'mixed';

/** Schema-compliant project context for LLM agent consumption. */
export interface ProjectContext {
  schemaVersion: string;
  detectedAt: string;
  projectTypes: ProjectType[];
  primaryType?: ProjectType;
  monorepo: boolean;
  testing?: {
    framework?: TestFramework;
    command?: string;
    testFilePatterns?: string[];
    directories?: {
      unit?: string;
      integration?: string;
    };
  };
  build?: {
    command?: string;
    outputDir?: string;
  };
  directories?: {
    source?: string;
    tests?: string;
    docs?: string;
  };
  conventions?: {
    fileNaming?: FileNamingConvention;
    importStyle?: ImportStyle;
    typeSystem?: string;
  };
  llmHints?: {
    preferredTestStyle?: string;
    typeSystem?: string;
    commonPatterns?: string[];
    avoidPatterns?: string[];
  };
}

/** @deprecated Use ProjectContext instead. */
export type ProjectInfo = ProjectContext;

/**
 * Detect project type from directory contents.
 * Returns a schema-compliant ProjectContext object.
 */
export function detectProjectType(projectDir: string): ProjectContext {
  const exists = (f: string) => existsSync(join(projectDir, f));
  const readJsonSafe = (f: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(join(projectDir, f), 'utf-8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const projectTypes: ProjectType[] = [];
  let primaryType: ProjectType = 'unknown';
  let monorepo = false;
  let testFramework: TestFramework = 'unknown';
  let packageManager: string | undefined;

  // Detect ALL project types (polyglot support)
  if (exists('package.json')) {
    projectTypes.push('node');
    primaryType = 'node';
  }
  if (
    exists('pyproject.toml') ||
    exists('setup.py') ||
    exists('requirements.txt') ||
    exists('Pipfile')
  ) {
    projectTypes.push('python');
    if (primaryType === 'unknown') primaryType = 'python';
  }
  if (exists('Cargo.toml')) {
    projectTypes.push('rust');
    if (primaryType === 'unknown') primaryType = 'rust';
  }
  if (exists('go.mod')) {
    projectTypes.push('go');
    if (primaryType === 'unknown') primaryType = 'go';
  }
  if (exists('Gemfile')) {
    projectTypes.push('ruby');
    if (primaryType === 'unknown') primaryType = 'ruby';
  }
  if (exists('pom.xml') || exists('build.gradle') || exists('build.gradle.kts')) {
    projectTypes.push('java');
    if (primaryType === 'unknown') primaryType = 'java';
  }
  if (hasFileWithExtension(projectDir, '.csproj') || hasFileWithExtension(projectDir, '.sln')) {
    projectTypes.push('dotnet');
    if (primaryType === 'unknown') primaryType = 'dotnet';
  }
  if (exists('deno.json') || exists('deno.jsonc')) {
    projectTypes.push('deno');
    if (primaryType === 'unknown') primaryType = 'deno';
  }
  if (exists('mix.exs')) {
    projectTypes.push('elixir');
    if (primaryType === 'unknown') primaryType = 'elixir';
  }
  if (exists('composer.json')) {
    projectTypes.push('php');
    if (primaryType === 'unknown') primaryType = 'php';
  }

  if (projectTypes.length === 0) {
    // Bash/shell fallback
    if (exists('install.sh') && (exists('tests') || exists('scripts'))) {
      projectTypes.push('bash');
      primaryType = 'bash';
    } else {
      projectTypes.push('unknown');
    }
  }

  // Package manager detection (Node.js specific)
  if (projectTypes.includes('node')) {
    if (exists('bun.lockb') || exists('bun.lock') || exists('bunfig.toml')) packageManager = 'bun';
    else if (exists('pnpm-lock.yaml') || exists('pnpm-workspace.yaml')) packageManager = 'pnpm';
    else if (exists('yarn.lock') || exists('.yarnrc.yml')) packageManager = 'yarn';
    else packageManager = 'npm';
  }

  // Monorepo detection
  if (
    exists('lerna.json') ||
    exists('pnpm-workspace.yaml') ||
    exists('turbo.json') ||
    exists('nx.json') ||
    exists('rush.json')
  ) {
    monorepo = true;
  } else if (exists('package.json')) {
    const pkg = readJsonSafe('package.json');
    if (pkg?.workspaces) monorepo = true;
  } else if (exists('Cargo.toml')) {
    try {
      const content = readFileSync(join(projectDir, 'Cargo.toml'), 'utf-8');
      if (content.includes('[workspace]')) monorepo = true;
    } catch {
      /* ignore */
    }
  }

  // Test framework detection (expanded)
  // Node.js
  if (exists('vitest.config.ts') || exists('vitest.config.js') || exists('vitest.config.mts'))
    testFramework = 'vitest';
  else if (exists('jest.config.ts') || exists('jest.config.js') || exists('jest.config.mjs'))
    testFramework = 'jest';
  else if (exists('.mocharc.yml') || exists('.mocharc.json') || exists('.mocharc.js'))
    testFramework = 'mocha';
  else if (exists('playwright.config.ts') || exists('playwright.config.js'))
    testFramework = 'playwright';
  else if (
    exists('cypress.config.ts') ||
    exists('cypress.config.js') ||
    exists('cypress.config.mjs')
  )
    testFramework = 'cypress';
  // Python
  else if (primaryType === 'python') testFramework = 'pytest';
  // Rust
  else if (primaryType === 'rust') testFramework = 'cargo';
  // Go
  else if (primaryType === 'go') testFramework = 'go';
  // Ruby
  else if (primaryType === 'ruby') testFramework = 'rspec';
  // Java
  else if (primaryType === 'java') testFramework = 'junit';
  // Bash
  else if (primaryType === 'bash' && (exists('tests/unit') || exists('tests/integration')))
    testFramework = 'bats';

  // Build detection
  const build = detectBuild(primaryType, packageManager, exists, readJsonSafe);

  // Testing detail detection
  const testing = detectTesting(projectDir, testFramework, packageManager, exists, readJsonSafe);

  // Directory detection
  const directories = detectDirectories(exists);

  // Convention detection
  const hasTypeScript = exists('tsconfig.json');
  const conventions = detectConventions(projectDir, primaryType, hasTypeScript, readJsonSafe);

  // LLM hints generation
  const llmHints = generateLlmHints(
    packageManager,
    testFramework,
    hasTypeScript,
    monorepo,
    conventions,
  );

  return {
    schemaVersion: '1.0.0',
    detectedAt: new Date().toISOString(),
    projectTypes,
    primaryType: primaryType !== 'unknown' ? primaryType : undefined,
    monorepo,
    ...(testing ? { testing } : {}),
    ...(build ? { build } : {}),
    ...(directories ? { directories } : {}),
    ...(conventions ? { conventions } : {}),
    ...(llmHints ? { llmHints } : {}),
  };
}

/** Check if a directory contains any file with the given extension. */
function hasFileWithExtension(dir: string, ext: string): boolean {
  try {
    const entries = readdirSync(dir);
    return entries.some((e) => e.endsWith(ext));
  } catch {
    return false;
  }
}

function detectBuild(
  primaryType: ProjectType,
  packageManager: string | undefined,
  exists: (f: string) => boolean,
  readJsonSafe: (f: string) => Record<string, unknown> | null,
): ProjectContext['build'] | undefined {
  const result: NonNullable<ProjectContext['build']> = {};

  if (primaryType === 'node') {
    const pkg = readJsonSafe('package.json');
    const scripts = pkg?.scripts as Record<string, string> | undefined;
    if (scripts?.build) {
      result.command = packageManager ? `${packageManager} run build` : 'npm run build';
    }
    // Output dir detection
    if (exists('dist')) result.outputDir = 'dist';
    else if (exists('build')) result.outputDir = 'build';
    else if (exists('out')) result.outputDir = 'out';
  } else if (primaryType === 'rust') {
    result.command = 'cargo build';
    result.outputDir = 'target';
  } else if (primaryType === 'go') {
    result.command = 'go build';
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function detectTesting(
  projectDir: string,
  framework: TestFramework,
  packageManager: string | undefined,
  exists: (f: string) => boolean,
  readJsonSafe: (f: string) => Record<string, unknown> | null,
): ProjectContext['testing'] | undefined {
  if (framework === 'unknown') return undefined;

  const result: NonNullable<ProjectContext['testing']> = { framework };

  // Test command
  const pkg = readJsonSafe('package.json');
  const scripts = pkg?.scripts as Record<string, string> | undefined;
  if (scripts?.test) {
    result.command = packageManager ? `${packageManager} run test` : 'npm test';
  } else if (framework === 'vitest') {
    result.command = 'npx vitest run';
  } else if (framework === 'jest') {
    result.command = 'npx jest';
  } else if (framework === 'pytest') {
    result.command = 'pytest';
  } else if (framework === 'cargo') {
    result.command = 'cargo test';
  } else if (framework === 'go') {
    result.command = 'go test ./...';
  }

  // Test file patterns
  if (framework === 'vitest' || framework === 'jest') {
    result.testFilePatterns = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'];
  } else if (framework === 'mocha') {
    result.testFilePatterns = ['**/*.test.js', '**/*.spec.js'];
  } else if (framework === 'pytest') {
    result.testFilePatterns = ['**/test_*.py', '**/*_test.py'];
  } else if (framework === 'bats') {
    result.testFilePatterns = ['**/*.bats'];
  }

  // Test directories
  const dirs: NonNullable<NonNullable<ProjectContext['testing']>['directories']> = {};
  if (existsSync(join(projectDir, 'tests/unit')) || existsSync(join(projectDir, 'src/__tests__'))) {
    dirs.unit = existsSync(join(projectDir, 'tests/unit')) ? 'tests/unit' : 'src/__tests__';
  } else if (exists('test')) {
    dirs.unit = 'test';
  }
  if (existsSync(join(projectDir, 'tests/integration'))) dirs.integration = 'tests/integration';
  else if (existsSync(join(projectDir, 'tests/e2e'))) dirs.integration = 'tests/e2e';

  if (Object.keys(dirs).length > 0) result.directories = dirs;

  return result;
}

function detectDirectories(
  exists: (f: string) => boolean,
): ProjectContext['directories'] | undefined {
  const result: NonNullable<ProjectContext['directories']> = {};

  if (exists('src')) result.source = 'src';
  else if (exists('lib')) result.source = 'lib';
  else if (exists('app')) result.source = 'app';

  if (exists('tests')) result.tests = 'tests';
  else if (exists('test')) result.tests = 'test';
  else if (exists('spec')) result.tests = 'spec';

  if (exists('docs')) result.docs = 'docs';
  else if (exists('doc')) result.docs = 'doc';
  else if (exists('documentation')) result.docs = 'documentation';

  return Object.keys(result).length > 0 ? result : undefined;
}

function detectConventions(
  projectDir: string,
  primaryType: ProjectType,
  hasTypeScript: boolean,
  readJsonSafe: (f: string) => Record<string, unknown> | null,
): ProjectContext['conventions'] | undefined {
  const result: NonNullable<ProjectContext['conventions']> = {};

  // File naming convention — detect from source files
  if (existsSync(join(projectDir, 'src'))) {
    try {
      const files = readdirSync(join(projectDir, 'src')).filter((f) => !f.startsWith('.'));
      result.fileNaming = detectFileNaming(files);
    } catch {
      /* ignore */
    }
  }

  // Import style
  if (primaryType === 'node') {
    const pkg = readJsonSafe('package.json');
    if (pkg?.type === 'module') result.importStyle = 'esm';
    else if (pkg?.type === 'commonjs' || (!pkg?.type && !hasTypeScript))
      result.importStyle = 'commonjs';
    else if (hasTypeScript) {
      // Check tsconfig for module type
      const tsconfig = readJsonSafe('tsconfig.json');
      const compilerOptions = tsconfig?.compilerOptions as Record<string, unknown> | undefined;
      const moduleType = (compilerOptions?.module as string | undefined)?.toLowerCase();
      if (
        moduleType?.includes('esnext') ||
        moduleType?.includes('es2') ||
        moduleType === 'nodenext' ||
        moduleType === 'node16'
      ) {
        result.importStyle = 'esm';
      } else if (moduleType === 'commonjs') {
        result.importStyle = 'commonjs';
      } else {
        result.importStyle = 'esm'; // Default for TS
      }
    }
  } else if (primaryType === 'deno' || primaryType === 'bun') {
    result.importStyle = 'esm';
  }

  // Type system
  if (hasTypeScript) {
    const tsconfig = readJsonSafe('tsconfig.json');
    const compilerOptions = tsconfig?.compilerOptions as Record<string, unknown> | undefined;
    const strict = compilerOptions?.strict;
    result.typeSystem = strict ? 'TypeScript strict' : 'TypeScript';
  } else if (primaryType === 'python') {
    if (
      existsSync(join(projectDir, 'py.typed')) ||
      existsSync(join(projectDir, 'pyproject.toml'))
    ) {
      const pyproject = readJsonSafe('pyproject.toml');
      if (pyproject) result.typeSystem = 'Python type hints';
    }
  } else if (primaryType === 'rust') {
    result.typeSystem = 'Rust';
  } else if (primaryType === 'go') {
    result.typeSystem = 'Go';
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function detectFileNaming(files: string[]): FileNamingConvention {
  const sourceFiles = files.filter((f) => !f.startsWith('_') && f.includes('.'));
  if (sourceFiles.length === 0) return 'kebab-case';

  let kebab = 0,
    snake = 0,
    camel = 0,
    pascal = 0;
  for (const f of sourceFiles) {
    const name = f.split('.')[0];
    if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) kebab++;
    else if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) snake++;
    else if (/^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name)) camel++;
    else if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) pascal++;
    else if (/^[a-z][a-z0-9]*$/.test(name)) kebab++; // single word defaults to kebab
  }

  const max = Math.max(kebab, snake, camel, pascal);
  if (max === 0) return 'kebab-case';
  if (kebab === max) return 'kebab-case';
  if (snake === max) return 'snake_case';
  if (pascal === max) return 'PascalCase';
  return 'camelCase';
}

function generateLlmHints(
  packageManager: string | undefined,
  testFramework: TestFramework,
  hasTypeScript: boolean,
  monorepo: boolean,
  conventions: ProjectContext['conventions'] | undefined,
): ProjectContext['llmHints'] | undefined {
  const commonPatterns: string[] = [];
  const avoidPatterns: string[] = [];
  let preferredTestStyle: string | undefined;
  let typeSystem: string | undefined;

  // Package manager hints
  if (packageManager === 'bun') {
    commonPatterns.push('Use bun for all package operations');
    avoidPatterns.push('Do not use npm or npx — this project uses bun');
    avoidPatterns.push('Use bunx instead of npx');
  } else if (packageManager === 'pnpm') {
    commonPatterns.push('Use pnpm for all package operations');
    avoidPatterns.push('Do not use npm — this project uses pnpm');
    avoidPatterns.push('Use pnpm dlx instead of npx');
  } else if (packageManager === 'yarn') {
    commonPatterns.push('Use yarn for all package operations');
    avoidPatterns.push('Do not use npm — this project uses yarn');
    avoidPatterns.push('Use yarn dlx instead of npx');
  }

  // Module system hints
  if (conventions?.importStyle === 'esm') {
    commonPatterns.push('Use ES module imports (import/export)');
    avoidPatterns.push('Do not use CommonJS require()');
    if (hasTypeScript) {
      commonPatterns.push('Include .js extension in import paths (ESM convention)');
    }
  } else if (conventions?.importStyle === 'commonjs') {
    commonPatterns.push('Use CommonJS require/module.exports');
    avoidPatterns.push('Do not use ES module import/export syntax');
  }

  // TypeScript hints
  if (hasTypeScript) {
    typeSystem =
      conventions?.typeSystem === 'TypeScript strict' ? 'TypeScript strict mode' : 'TypeScript';
    commonPatterns.push('Use explicit return types on exported functions');
    if (conventions?.typeSystem === 'TypeScript strict') {
      avoidPatterns.push('Do not use any type — strict mode is enabled');
    }
  }

  // Test framework hints
  if (testFramework === 'vitest') {
    preferredTestStyle = 'Vitest with describe/it blocks';
    commonPatterns.push('Use describe/it blocks with expect assertions');
  } else if (testFramework === 'jest') {
    preferredTestStyle = 'Jest with describe/it blocks';
  } else if (testFramework === 'pytest') {
    preferredTestStyle = 'pytest with function-based tests (test_ prefix)';
  }

  // File naming hints
  if (conventions?.fileNaming) {
    commonPatterns.push(`Use ${conventions.fileNaming} for file names`);
  }

  // Monorepo hints
  if (monorepo) {
    commonPatterns.push('This is a monorepo — respect package boundaries');
    avoidPatterns.push('Do not import across package boundaries without explicit dependencies');
  }

  if (commonPatterns.length === 0 && avoidPatterns.length === 0) return undefined;

  return {
    ...(preferredTestStyle ? { preferredTestStyle } : {}),
    ...(typeSystem ? { typeSystem } : {}),
    ...(commonPatterns.length > 0 ? { commonPatterns } : {}),
    ...(avoidPatterns.length > 0 ? { avoidPatterns } : {}),
  };
}
