/**
 * E2E tests for project type detection.
 * Tests detectProjectType() against real on-disk scaffolds.
 *
 * @epic T4454
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProjectType } from '../../src/store/project-detect.js';
import {
  cleanupScaffold,
  createGoProject,
  createNodeProject,
  createPythonProject,
  createRustProject,
} from '../fixtures/project-scaffolds.js';

// Load schema once
const schema = JSON.parse(
  readFileSync(new URL('../../schemas/project-context.schema.json', import.meta.url), 'utf-8'),
);
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function assertSchemaValid(result: unknown): void {
  const valid = validate(result);
  if (!valid) {
    throw new Error(`Schema validation failed:\n${JSON.stringify(validate.errors, null, 2)}`);
  }
}

describe('project-detect E2E', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-detect-'));
  });

  afterEach(() => {
    cleanupScaffold(dir);
  });

  it('node-npm-vitest: detects node + vitest + TypeScript', () => {
    createNodeProject(dir, {
      packageManager: 'npm',
      testFramework: 'vitest',
      hasTypeScript: true,
    });

    const result = detectProjectType(dir);

    expect(result.projectTypes).toContain('node');
    expect(result.primaryType).toBe('node');
    expect(result.testing?.framework).toBe('vitest');
    // npm is the default — no lockfile means npm, no avoidPatterns for npm
    expect(result.monorepo).toBe(false);
    assertSchemaValid(result);
  });

  it('node-bun: detects bun package manager and emits npm avoidPattern', () => {
    createNodeProject(dir, { packageManager: 'bun', testFramework: 'vitest' });

    const result = detectProjectType(dir);

    expect(result.projectTypes).toContain('node');
    expect(result.llmHints?.avoidPatterns).toBeDefined();
    const avoidPatterns = result.llmHints!.avoidPatterns!;
    expect(avoidPatterns.some((p) => p.toLowerCase().includes('npm'))).toBe(true);
    assertSchemaValid(result);
  });

  it('node-pnpm-jest: detects pnpm package manager and jest framework', () => {
    createNodeProject(dir, { packageManager: 'pnpm', testFramework: 'jest' });

    const result = detectProjectType(dir);

    expect(result.testing?.framework).toBe('jest');
    expect(result.llmHints?.avoidPatterns).toBeDefined();
    const avoidPatterns = result.llmHints!.avoidPatterns!;
    expect(avoidPatterns.some((p) => p.toLowerCase().includes('npm'))).toBe(true);
    assertSchemaValid(result);
  });

  it('python-poetry: detects python + pytest', () => {
    createPythonProject(dir, { tool: 'poetry' });

    const result = detectProjectType(dir);

    expect(result.projectTypes).toContain('python');
    expect(result.primaryType).toBe('python');
    expect(result.testing?.framework).toBe('pytest');
    assertSchemaValid(result);
  });

  it('rust: detects rust + cargo test framework', () => {
    createRustProject(dir);

    const result = detectProjectType(dir);

    expect(result.projectTypes).toContain('rust');
    expect(result.primaryType).toBe('rust');
    expect(result.testing?.framework).toBe('cargo');
    assertSchemaValid(result);
  });

  it('go: detects go + go test framework', () => {
    createGoProject(dir);

    const result = detectProjectType(dir);

    expect(result.projectTypes).toContain('go');
    expect(result.primaryType).toBe('go');
    expect(result.testing?.framework).toBe('go');
    assertSchemaValid(result);
  });

  it('turbo-monorepo: detects pnpm + monorepo=true', () => {
    createNodeProject(dir, { packageManager: 'pnpm', monorepo: 'turbo' });

    const result = detectProjectType(dir);

    expect(result.monorepo).toBe(true);
    assertSchemaValid(result);
  });

  it('polyglot-node-rust: detects both node and rust, primaryType=node', () => {
    // Create both package.json and Cargo.toml in the same directory
    createNodeProject(dir, { packageManager: 'npm', testFramework: 'vitest' });
    writeFileSync(
      join(dir, 'Cargo.toml'),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n',
    );

    const result = detectProjectType(dir);

    expect(result.projectTypes).toContain('node');
    expect(result.projectTypes).toContain('rust');
    // node is detected first (package.json checked before Cargo.toml) so primaryType=node
    expect(result.primaryType).toBe('node');
    assertSchemaValid(result);
  });
});
