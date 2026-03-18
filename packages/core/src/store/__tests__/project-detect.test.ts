/**
 * Tests for src/store/project-detect.ts
 * Verifies ecosystem detection, schema compliance, and LLM hint generation.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProjectType } from '../project-detect.js';

// ─── Schema validator setup ───────────────────────────────────────────────────
const schemaPath = fileURLToPath(
  new URL('../../../schemas/project-context.schema.json', import.meta.url),
);
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function assertSchemaValid(result: unknown, label = ''): void {
  const valid = validate(result);
  if (!valid) {
    throw new Error(
      `${label ? label + ' — ' : ''}Schema invalid: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  }
}

// ─── Scaffold helper ──────────────────────────────────────────────────────────
function scaffold(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-detect-'));
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    const parts = name.split('/');
    if (parts.length > 1) {
      mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
    }
    writeFileSync(filePath, content);
  }
  return dir;
}

let dir: string;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Group 1: Ecosystem detection ────────────────────────────────────────────
describe('Group 1: Ecosystem detection', () => {
  it('empty dir → projectTypes includes unknown', () => {
    dir = scaffold({});
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('unknown');
    assertSchemaValid(result, 'empty dir');
  });

  it('package.json → projectTypes includes node, primaryType is node', () => {
    dir = scaffold({ 'package.json': '{"name":"test"}' });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('node');
    expect(result.primaryType).toBe('node');
    assertSchemaValid(result, 'node');
  });

  it('requirements.txt → projectTypes includes python', () => {
    dir = scaffold({ 'requirements.txt': 'requests==2.28.0\n' });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('python');
    expect(result.primaryType).toBe('python');
    assertSchemaValid(result, 'python requirements.txt');
  });

  it('pyproject.toml → projectTypes includes python', () => {
    dir = scaffold({ 'pyproject.toml': '[tool.poetry]\nname = "myapp"\n' });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('python');
    assertSchemaValid(result, 'python pyproject.toml');
  });

  it('setup.py → projectTypes includes python', () => {
    dir = scaffold({ 'setup.py': 'from setuptools import setup\nsetup(name="myapp")\n' });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('python');
    assertSchemaValid(result, 'python setup.py');
  });

  it('Cargo.toml → projectTypes includes rust, primaryType is rust', () => {
    dir = scaffold({ 'Cargo.toml': '[package]\nname = "myapp"\nversion = "0.1.0"\n' });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('rust');
    expect(result.primaryType).toBe('rust');
    assertSchemaValid(result, 'rust');
  });

  it('go.mod → projectTypes includes go, primaryType is go', () => {
    dir = scaffold({ 'go.mod': 'module myapp\n\ngo 1.21\n' });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('go');
    expect(result.primaryType).toBe('go');
    assertSchemaValid(result, 'go');
  });

  it('Gemfile → projectTypes includes ruby, primaryType is ruby', () => {
    dir = scaffold({ Gemfile: "source 'https://rubygems.org'\n" });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('ruby');
    expect(result.primaryType).toBe('ruby');
    assertSchemaValid(result, 'ruby');
  });

  it('pom.xml → projectTypes includes java', () => {
    dir = scaffold({ 'pom.xml': '<project></project>' });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('java');
    expect(result.primaryType).toBe('java');
    assertSchemaValid(result, 'java pom.xml');
  });

  it('build.gradle → projectTypes includes java', () => {
    dir = scaffold({ 'build.gradle': 'plugins { id "java" }\n' });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('java');
    assertSchemaValid(result, 'java build.gradle');
  });

  it('.csproj file → projectTypes includes dotnet', () => {
    dir = scaffold({ 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>' });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('dotnet');
    expect(result.primaryType).toBe('dotnet');
    assertSchemaValid(result, 'dotnet');
  });

  it('deno.json → projectTypes includes deno', () => {
    dir = scaffold({ 'deno.json': '{"tasks":{}}' });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('deno');
    expect(result.primaryType).toBe('deno');
    assertSchemaValid(result, 'deno');
  });

  it('mix.exs → projectTypes includes elixir', () => {
    dir = scaffold({ 'mix.exs': 'defmodule MyApp.MixProject do\nend\n' });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('elixir');
    expect(result.primaryType).toBe('elixir');
    assertSchemaValid(result, 'elixir');
  });

  it('composer.json → projectTypes includes php', () => {
    dir = scaffold({ 'composer.json': '{"name":"vendor/package"}' });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('php');
    expect(result.primaryType).toBe('php');
    assertSchemaValid(result, 'php');
  });

  it('install.sh + tests/ dir → projectTypes includes bash', () => {
    dir = scaffold({ 'install.sh': '#!/bin/bash\necho "install"\n', 'tests/.keep': '' });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('bash');
    expect(result.primaryType).toBe('bash');
    assertSchemaValid(result, 'bash');
  });
});

// ─── Group 2: Polyglot detection ─────────────────────────────────────────────
describe('Group 2: Polyglot detection', () => {
  it('package.json + Cargo.toml → both node and rust detected, primaryType is node', () => {
    dir = scaffold({
      'package.json': '{"name":"app"}',
      'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
    });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('node');
    expect(result.projectTypes).toContain('rust');
    expect(result.primaryType).toBe('node');
    assertSchemaValid(result, 'polyglot node+rust');
  });

  it('package.json + go.mod → both node and go detected', () => {
    dir = scaffold({
      'package.json': '{"name":"app"}',
      'go.mod': 'module myapp\n\ngo 1.21\n',
    });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('node');
    expect(result.projectTypes).toContain('go');
    expect(result.primaryType).toBe('node');
    assertSchemaValid(result, 'polyglot node+go');
  });

  it('Cargo.toml + go.mod → both rust and go detected', () => {
    dir = scaffold({
      'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
      'go.mod': 'module myapp\n\ngo 1.21\n',
    });
    const result = detectProjectType(dir);
    expect(result.projectTypes).toContain('rust');
    expect(result.projectTypes).toContain('go');
    assertSchemaValid(result, 'polyglot rust+go');
  });
});

// ─── Group 3: Package manager detection ──────────────────────────────────────
describe('Group 3: Package manager detection', () => {
  it('package.json only → defaults to npm (no bun/pnpm/yarn avoid hint)', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}' });
    const result = detectProjectType(dir);
    // With npm there are no package manager avoidPatterns
    const avoidPatterns = result.llmHints?.avoidPatterns ?? [];
    expect(avoidPatterns.some((p) => p.includes('npm'))).toBe(false);
    assertSchemaValid(result, 'npm default');
  });

  it('package.json + bun.lockb → bun detected, avoid npm hint present', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'bun.lockb': '' });
    const result = detectProjectType(dir);
    const avoidPatterns = result.llmHints?.avoidPatterns ?? [];
    expect(avoidPatterns.some((p) => p.includes('npm'))).toBe(true);
    assertSchemaValid(result, 'bun.lockb');
  });

  it('package.json + bun.lock → bun detected', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'bun.lock': '' });
    const result = detectProjectType(dir);
    const avoidPatterns = result.llmHints?.avoidPatterns ?? [];
    expect(avoidPatterns.some((p) => p.includes('npm'))).toBe(true);
    assertSchemaValid(result, 'bun.lock');
  });

  it('package.json + pnpm-lock.yaml → pnpm detected, avoid npm hint present', () => {
    dir = scaffold({
      'package.json': '{"name":"app"}',
      'pnpm-lock.yaml': 'lockfileVersion: "6.0"\n',
    });
    const result = detectProjectType(dir);
    const avoidPatterns = result.llmHints?.avoidPatterns ?? [];
    expect(avoidPatterns.some((p) => p.includes('npm'))).toBe(true);
    assertSchemaValid(result, 'pnpm');
  });

  it('package.json + yarn.lock → yarn detected, avoid npm hint present', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'yarn.lock': '# yarn lockfile v1\n' });
    const result = detectProjectType(dir);
    const avoidPatterns = result.llmHints?.avoidPatterns ?? [];
    expect(avoidPatterns.some((p) => p.includes('npm'))).toBe(true);
    assertSchemaValid(result, 'yarn');
  });

  it('package.json + bun.lockb + package-lock.json → bun still wins', () => {
    dir = scaffold({
      'package.json': '{"name":"app"}',
      'bun.lockb': '',
      'package-lock.json': '{"lockfileVersion":3}',
    });
    const result = detectProjectType(dir);
    const commonPatterns = result.llmHints?.commonPatterns ?? [];
    expect(commonPatterns.some((p) => p.toLowerCase().includes('bun'))).toBe(true);
    assertSchemaValid(result, 'bun wins over npm');
  });
});

// ─── Group 4: Test framework detection ───────────────────────────────────────
describe('Group 4: Test framework detection', () => {
  it('vitest.config.ts → testing.framework is vitest', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'vitest.config.ts': 'export default {}' });
    const result = detectProjectType(dir);
    expect(result.testing?.framework).toBe('vitest');
    assertSchemaValid(result, 'vitest config');
  });

  it('jest.config.ts → testing.framework is jest', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'jest.config.ts': 'export default {}' });
    const result = detectProjectType(dir);
    expect(result.testing?.framework).toBe('jest');
    assertSchemaValid(result, 'jest config');
  });

  it('.mocharc.yml → testing.framework is mocha', () => {
    dir = scaffold({
      'package.json': '{"name":"app"}',
      '.mocharc.yml': 'spec: test/**/*.spec.js\n',
    });
    const result = detectProjectType(dir);
    expect(result.testing?.framework).toBe('mocha');
    assertSchemaValid(result, 'mocha');
  });

  it('playwright.config.ts → testing.framework is playwright', () => {
    dir = scaffold({
      'package.json': '{"name":"app"}',
      'playwright.config.ts': 'export default {}',
    });
    const result = detectProjectType(dir);
    expect(result.testing?.framework).toBe('playwright');
    assertSchemaValid(result, 'playwright');
  });

  it('cypress.config.ts → testing.framework is cypress', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'cypress.config.ts': 'export default {}' });
    const result = detectProjectType(dir);
    expect(result.testing?.framework).toBe('cypress');
    assertSchemaValid(result, 'cypress');
  });

  it('go.mod → testing.framework is go', () => {
    dir = scaffold({ 'go.mod': 'module myapp\n\ngo 1.21\n' });
    const result = detectProjectType(dir);
    expect(result.testing?.framework).toBe('go');
    assertSchemaValid(result, 'go test');
  });

  it('Cargo.toml → testing.framework is cargo', () => {
    dir = scaffold({ 'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n' });
    const result = detectProjectType(dir);
    expect(result.testing?.framework).toBe('cargo');
    assertSchemaValid(result, 'cargo test');
  });

  it('requirements.txt → testing.framework is pytest', () => {
    dir = scaffold({ 'requirements.txt': 'requests==2.28.0\n' });
    const result = detectProjectType(dir);
    expect(result.testing?.framework).toBe('pytest');
    assertSchemaValid(result, 'pytest');
  });
});

// ─── Group 5: Monorepo detection ─────────────────────────────────────────────
describe('Group 5: Monorepo detection', () => {
  it('package.json + turbo.json → monorepo is true', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'turbo.json': '{"pipeline":{}}' });
    const result = detectProjectType(dir);
    expect(result.monorepo).toBe(true);
    assertSchemaValid(result, 'turbo monorepo');
  });

  it('package.json + nx.json → monorepo is true', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'nx.json': '{}' });
    const result = detectProjectType(dir);
    expect(result.monorepo).toBe(true);
    assertSchemaValid(result, 'nx monorepo');
  });

  it('package.json + pnpm-workspace.yaml → monorepo is true', () => {
    dir = scaffold({
      'package.json': '{"name":"app"}',
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    });
    const result = detectProjectType(dir);
    expect(result.monorepo).toBe(true);
    assertSchemaValid(result, 'pnpm workspace monorepo');
  });

  it('package.json + lerna.json → monorepo is true', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'lerna.json': '{"version":"independent"}' });
    const result = detectProjectType(dir);
    expect(result.monorepo).toBe(true);
    assertSchemaValid(result, 'lerna monorepo');
  });

  it('package.json with workspaces field → monorepo is true', () => {
    dir = scaffold({ 'package.json': '{"name":"app","workspaces":["packages/*"]}' });
    const result = detectProjectType(dir);
    expect(result.monorepo).toBe(true);
    assertSchemaValid(result, 'npm workspaces monorepo');
  });

  it('Cargo.toml with [workspace] section → monorepo is true', () => {
    dir = scaffold({
      'Cargo.toml':
        '[workspace]\nmembers = ["crate-a", "crate-b"]\n\n[package]\nname = "root"\nversion = "0.1.0"\n',
    });
    const result = detectProjectType(dir);
    expect(result.monorepo).toBe(true);
    assertSchemaValid(result, 'cargo workspace monorepo');
  });
});

// ─── Group 6: LLM hints ───────────────────────────────────────────────────────
describe('Group 6: LLM hints', () => {
  it('bun project → avoidPatterns includes "Do not use npm or npx"', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'bun.lockb': '' });
    const result = detectProjectType(dir);
    const avoidPatterns = result.llmHints?.avoidPatterns ?? [];
    expect(avoidPatterns).toContain('Do not use npm or npx — this project uses bun');
  });

  it('pnpm project → avoidPatterns includes "Do not use npm"', () => {
    dir = scaffold({
      'package.json': '{"name":"app"}',
      'pnpm-lock.yaml': 'lockfileVersion: "6.0"\n',
    });
    const result = detectProjectType(dir);
    const avoidPatterns = result.llmHints?.avoidPatterns ?? [];
    expect(avoidPatterns).toContain('Do not use npm — this project uses pnpm');
  });

  it('yarn project → avoidPatterns includes "Do not use npm — this project uses yarn"', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'yarn.lock': '# yarn lockfile v1\n' });
    const result = detectProjectType(dir);
    const avoidPatterns = result.llmHints?.avoidPatterns ?? [];
    expect(avoidPatterns).toContain('Do not use npm — this project uses yarn');
  });

  it('TypeScript project (tsconfig.json) → llmHints.typeSystem contains TypeScript', () => {
    dir = scaffold({
      'package.json': '{"name":"app"}',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });
    const result = detectProjectType(dir);
    expect(result.llmHints?.typeSystem).toMatch(/TypeScript/);
  });

  it('ESM project (type:module) → avoidPatterns includes CommonJS warning', () => {
    dir = scaffold({ 'package.json': '{"name":"app","type":"module"}' });
    const result = detectProjectType(dir);
    const avoidPatterns = result.llmHints?.avoidPatterns ?? [];
    expect(avoidPatterns).toContain('Do not use CommonJS require()');
  });

  it('avoidPatterns is always an array when present', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'bun.lockb': '' });
    const result = detectProjectType(dir);
    if (result.llmHints?.avoidPatterns !== undefined) {
      expect(Array.isArray(result.llmHints.avoidPatterns)).toBe(true);
    }
    assertSchemaValid(result, 'avoidPatterns array check');
  });
});

// ─── Group 7: Schema compliance ───────────────────────────────────────────────
describe('Group 7: Schema compliance', () => {
  it('node project output is schema-valid', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}' });
    const result = detectProjectType(dir);
    assertSchemaValid(result, 'node schema');
  });

  it('python project output is schema-valid', () => {
    dir = scaffold({ 'requirements.txt': 'flask==2.0.0\n' });
    const result = detectProjectType(dir);
    assertSchemaValid(result, 'python schema');
  });

  it('rust project output is schema-valid', () => {
    dir = scaffold({ 'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n' });
    const result = detectProjectType(dir);
    assertSchemaValid(result, 'rust schema');
  });

  it('go project output is schema-valid', () => {
    dir = scaffold({ 'go.mod': 'module myapp\n\ngo 1.21\n' });
    const result = detectProjectType(dir);
    assertSchemaValid(result, 'go schema');
  });

  it('polyglot (node + rust) output is schema-valid', () => {
    dir = scaffold({
      'package.json': '{"name":"app"}',
      'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
    });
    const result = detectProjectType(dir);
    assertSchemaValid(result, 'polyglot schema');
  });

  it('schemaVersion is always "1.0.0"', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}' });
    const result = detectProjectType(dir);
    expect(result.schemaVersion).toBe('1.0.0');
  });

  it('detectedAt is ISO 8601 date-time string', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}' });
    const result = detectProjectType(dir);
    expect(() => new Date(result.detectedAt).toISOString()).not.toThrow();
    expect(new Date(result.detectedAt).getFullYear()).toBeGreaterThan(2020);
  });

  it('projectTypes always has at least 1 item', () => {
    dir = scaffold({});
    const result = detectProjectType(dir);
    expect(result.projectTypes.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Group 8: Build detection ─────────────────────────────────────────────────
describe('Group 8: Build detection', () => {
  it('package.json with build script → build.command is populated', () => {
    dir = scaffold({
      'package.json': '{"name":"app","scripts":{"build":"tsc","test":"vitest run"}}',
    });
    const result = detectProjectType(dir);
    expect(result.build?.command).toBeDefined();
    expect(result.build?.command).toContain('build');
    assertSchemaValid(result, 'node build command');
  });

  it('Cargo.toml → build.command is "cargo build"', () => {
    dir = scaffold({ 'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n' });
    const result = detectProjectType(dir);
    expect(result.build?.command).toBe('cargo build');
    assertSchemaValid(result, 'rust build');
  });

  it('go.mod → build.command includes "go"', () => {
    dir = scaffold({ 'go.mod': 'module myapp\n\ngo 1.21\n' });
    const result = detectProjectType(dir);
    expect(result.build?.command).toContain('go');
    assertSchemaValid(result, 'go build');
  });

  it('package.json with build + dist dir → build.outputDir is "dist"', () => {
    dir = scaffold({
      'package.json': '{"name":"app","scripts":{"build":"tsc"}}',
      'dist/.keep': '',
    });
    const result = detectProjectType(dir);
    expect(result.build?.outputDir).toBe('dist');
    assertSchemaValid(result, 'node dist output');
  });
});

// ─── Group 9: Testing command fallback ───────────────────────────────────────
describe('Group 9: Testing command fallback', () => {
  it('vitest config but no test script → command is "npx vitest run"', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'vitest.config.ts': 'export default {}' });
    const result = detectProjectType(dir);
    expect(result.testing?.command).toBe('npx vitest run');
    assertSchemaValid(result, 'vitest fallback command');
  });

  it('jest config but no test script → command is "npx jest"', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'jest.config.ts': 'export default {}' });
    const result = detectProjectType(dir);
    expect(result.testing?.command).toBe('npx jest');
    assertSchemaValid(result, 'jest fallback command');
  });

  it('package.json with test script → command uses npm test', () => {
    dir = scaffold({
      'package.json': '{"name":"app","scripts":{"test":"vitest run"}}',
      'vitest.config.ts': 'export default {}',
    });
    const result = detectProjectType(dir);
    expect(result.testing?.command).toBe('npm run test');
    assertSchemaValid(result, 'npm test script');
  });

  it('bun project with test script → command uses bun run test', () => {
    dir = scaffold({
      'package.json': '{"name":"app","scripts":{"test":"vitest run"}}',
      'bun.lockb': '',
      'vitest.config.ts': 'export default {}',
    });
    const result = detectProjectType(dir);
    expect(result.testing?.command).toBe('bun run test');
    assertSchemaValid(result, 'bun test command');
  });

  it('pytest → command is "pytest"', () => {
    dir = scaffold({ 'requirements.txt': 'flask\n' });
    const result = detectProjectType(dir);
    expect(result.testing?.command).toBe('pytest');
  });

  it('cargo → command is "cargo test"', () => {
    dir = scaffold({ 'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n' });
    const result = detectProjectType(dir);
    expect(result.testing?.command).toBe('cargo test');
  });

  it('go → command is "go test ./..."', () => {
    dir = scaffold({ 'go.mod': 'module myapp\n\ngo 1.21\n' });
    const result = detectProjectType(dir);
    expect(result.testing?.command).toBe('go test ./...');
  });
});

// ─── Group 10: Conventions detection ─────────────────────────────────────────
describe('Group 10: Conventions detection', () => {
  it('package.json with type:module → importStyle is esm', () => {
    dir = scaffold({ 'package.json': '{"name":"app","type":"module"}' });
    const result = detectProjectType(dir);
    expect(result.conventions?.importStyle).toBe('esm');
    assertSchemaValid(result, 'esm import style');
  });

  it('package.json with type:commonjs → importStyle is commonjs', () => {
    dir = scaffold({ 'package.json': '{"name":"app","type":"commonjs"}' });
    const result = detectProjectType(dir);
    expect(result.conventions?.importStyle).toBe('commonjs');
    assertSchemaValid(result, 'commonjs import style');
  });

  it('TypeScript strict mode → typeSystem is "TypeScript strict"', () => {
    dir = scaffold({
      'package.json': '{"name":"app"}',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });
    const result = detectProjectType(dir);
    expect(result.conventions?.typeSystem).toBe('TypeScript strict');
    assertSchemaValid(result, 'ts strict type system');
  });

  it('TypeScript without strict → typeSystem is "TypeScript"', () => {
    dir = scaffold({
      'package.json': '{"name":"app"}',
      'tsconfig.json': '{"compilerOptions":{"target":"ES2020"}}',
    });
    const result = detectProjectType(dir);
    expect(result.conventions?.typeSystem).toBe('TypeScript');
    assertSchemaValid(result, 'ts type system');
  });

  it('rust project → typeSystem is "Rust"', () => {
    dir = scaffold({ 'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n' });
    const result = detectProjectType(dir);
    expect(result.conventions?.typeSystem).toBe('Rust');
    assertSchemaValid(result, 'rust type system');
  });

  it('go project → typeSystem is "Go"', () => {
    dir = scaffold({ 'go.mod': 'module myapp\n\ngo 1.21\n' });
    const result = detectProjectType(dir);
    expect(result.conventions?.typeSystem).toBe('Go');
    assertSchemaValid(result, 'go type system');
  });
});

// ─── Group 11: Directory detection ───────────────────────────────────────────
describe('Group 11: Directory detection', () => {
  it('src/ present → directories.source is "src"', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'src/.keep': '' });
    const result = detectProjectType(dir);
    expect(result.directories?.source).toBe('src');
    assertSchemaValid(result, 'src directory');
  });

  it('tests/ present → directories.tests is "tests"', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'tests/.keep': '' });
    const result = detectProjectType(dir);
    expect(result.directories?.tests).toBe('tests');
    assertSchemaValid(result, 'tests directory');
  });

  it('docs/ present → directories.docs is "docs"', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'docs/.keep': '' });
    const result = detectProjectType(dir);
    expect(result.directories?.docs).toBe('docs');
    assertSchemaValid(result, 'docs directory');
  });

  it('no standard dirs → directories is undefined', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}' });
    const result = detectProjectType(dir);
    expect(result.directories).toBeUndefined();
    assertSchemaValid(result, 'no directories');
  });
});

// ─── Group 12: Vitest test patterns ──────────────────────────────────────────
describe('Group 12: Test file patterns', () => {
  it('vitest → testFilePatterns includes *.test.ts', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'vitest.config.ts': 'export default {}' });
    const result = detectProjectType(dir);
    expect(result.testing?.testFilePatterns).toContain('**/*.test.ts');
  });

  it('jest → testFilePatterns includes *.test.ts', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', 'jest.config.ts': 'export default {}' });
    const result = detectProjectType(dir);
    expect(result.testing?.testFilePatterns).toContain('**/*.test.ts');
  });

  it('pytest → testFilePatterns includes test_*.py', () => {
    dir = scaffold({ 'requirements.txt': 'pytest\n' });
    const result = detectProjectType(dir);
    expect(result.testing?.testFilePatterns).toContain('**/test_*.py');
  });

  it('mocha → testFilePatterns includes *.test.js', () => {
    dir = scaffold({ 'package.json': '{"name":"app"}', '.mocharc.yml': 'spec: test/*.spec.js\n' });
    const result = detectProjectType(dir);
    expect(result.testing?.testFilePatterns).toContain('**/*.test.js');
  });
});
