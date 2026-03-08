/**
 * Shared fixture factory for project type detection tests.
 * Creates minimal on-disk scaffolds that trigger detectProjectType().
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createNodeProject(
  dir: string,
  opts?: {
    packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun';
    testFramework?: 'vitest' | 'jest' | 'mocha' | 'playwright' | 'cypress';
    hasTypeScript?: boolean;
    monorepo?: 'turbo' | 'nx' | 'pnpm' | 'lerna' | false;
  },
): void {
  mkdirSync(dir, { recursive: true });

  // Always create package.json
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'test', version: '1.0.0', scripts: {} }),
  );

  // Package manager lockfiles
  const pm = opts?.packageManager ?? 'npm';
  if (pm === 'bun') {
    writeFileSync(join(dir, 'bun.lockb'), '');
  } else if (pm === 'pnpm') {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  } else if (pm === 'yarn') {
    writeFileSync(join(dir, 'yarn.lock'), '');
  }
  // npm: no lockfile needed — detectProjectType falls through to default 'npm'

  // Test framework config files
  const tf = opts?.testFramework;
  if (tf === 'vitest') {
    writeFileSync(join(dir, 'vitest.config.ts'), '');
  } else if (tf === 'jest') {
    writeFileSync(join(dir, 'jest.config.ts'), '');
  } else if (tf === 'mocha') {
    writeFileSync(join(dir, '.mocharc.yml'), '');
  } else if (tf === 'playwright') {
    writeFileSync(join(dir, 'playwright.config.ts'), '');
  } else if (tf === 'cypress') {
    writeFileSync(join(dir, 'cypress.config.ts'), '');
  }

  // TypeScript
  if (opts?.hasTypeScript) {
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
  }

  // Monorepo markers
  const mono = opts?.monorepo;
  if (mono === 'turbo') {
    writeFileSync(join(dir, 'turbo.json'), JSON.stringify({}));
  } else if (mono === 'nx') {
    writeFileSync(join(dir, 'nx.json'), JSON.stringify({}));
  } else if (mono === 'pnpm') {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    // pnpm-workspace.yaml also triggers pnpm package manager detection
    if (pm !== 'pnpm') {
      writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    }
  } else if (mono === 'lerna') {
    writeFileSync(join(dir, 'lerna.json'), JSON.stringify({}));
  }
}

export function createPythonProject(
  dir: string,
  opts?: { tool?: 'pip' | 'poetry' | 'pdm' | 'uv' },
): void {
  mkdirSync(dir, { recursive: true });

  const tool = opts?.tool ?? 'pip';
  if (tool === 'pip') {
    writeFileSync(join(dir, 'requirements.txt'), '');
  } else if (tool === 'poetry') {
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.poetry]\nname = "test"\nversion = "0.1.0"\n');
  } else if (tool === 'pdm') {
    writeFileSync(
      join(dir, 'pyproject.toml'),
      '[tool.pdm]\n[project]\nname = "test"\nversion = "0.1.0"\n',
    );
  } else if (tool === 'uv') {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "test"\nversion = "0.1.0"\n');
  }
}

export function createRustProject(dir: string, opts?: { workspace?: boolean }): void {
  mkdirSync(dir, { recursive: true });

  const base = '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n';
  const workspace = opts?.workspace ? '\n[workspace]\nmembers = ["."]\n' : '';
  writeFileSync(join(dir, 'Cargo.toml'), base + workspace);
}

export function createGoProject(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n');
}

export function cleanupScaffold(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
