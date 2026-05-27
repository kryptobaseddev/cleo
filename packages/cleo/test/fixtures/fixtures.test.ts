/**
 * Smoke test for release-pipeline archetype fixtures.
 *
 * Verifies that each fixture under `packages/cleo/test/fixtures/release-test-*`
 * has a parseable `.cleo/release-config.json` with the expected archetype and
 * the canonical directory structure assumed by the T9543/T9544 integration
 * tests.
 *
 * Schema validation is intentionally out of scope here — that will land with
 * T9527 (release-config schema) and T9531 (validator). This test only asserts
 * that the fixtures exist, parse, and declare the expected archetype.
 *
 * @task T9542
 * @epic T9495
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ReleaseConfig {
  versionScheme: string;
  tagPrefix: string;
  gitWorkflow: string;
  archetype: string;
  branchModel: string;
  platformMatrix: Array<{ platform: string; publisher: string; package: string }>;
}

function readReleaseConfig(fixtureDir: string): ReleaseConfig {
  const path = join(__dirname, fixtureDir, '.cleo', 'release-config.json');
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as ReleaseConfig;
}

describe('release-test-monorepo fixture', () => {
  const fixture = 'release-test-monorepo';

  it('has parseable .cleo/release-config.json declaring monorepo-w-workspaces archetype', () => {
    const config = readReleaseConfig(fixture);
    expect(config.archetype).toBe('monorepo-w-workspaces');
    expect(config.versionScheme).toBe('calver');
    expect(config.platformMatrix.length).toBeGreaterThanOrEqual(2);
  });

  it('has the expected workspace directory layout', () => {
    expect(existsSync(join(__dirname, fixture, 'package.json'))).toBe(true);
    expect(existsSync(join(__dirname, fixture, 'pnpm-workspace.yaml'))).toBe(true);
    expect(existsSync(join(__dirname, fixture, 'packages', 'pkg-a', 'package.json'))).toBe(true);
    expect(existsSync(join(__dirname, fixture, 'packages', 'pkg-b', 'package.json'))).toBe(true);
  });

  it('has .cleo/project-context.json marking it as a node monorepo', () => {
    const path = join(__dirname, fixture, '.cleo', 'project-context.json');
    const ctx = JSON.parse(readFileSync(path, 'utf-8')) as {
      primaryType: string;
      monorepo: boolean;
    };
    expect(ctx.primaryType).toBe('node');
    expect(ctx.monorepo).toBe(true);
  });
});

describe('release-test-npm-lib fixture', () => {
  const fixture = 'release-test-npm-lib';

  it('has parseable .cleo/release-config.json declaring single-npm-lib archetype', () => {
    const config = readReleaseConfig(fixture);
    expect(config.archetype).toBe('single-npm-lib');
    expect(config.versionScheme).toBe('semver');
    expect(config.platformMatrix[0]?.publisher).toBe('npm');
  });

  it('has the expected TypeScript library layout', () => {
    expect(existsSync(join(__dirname, fixture, 'package.json'))).toBe(true);
    expect(existsSync(join(__dirname, fixture, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(__dirname, fixture, 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(__dirname, fixture, 'src', 'index.test.ts'))).toBe(true);
  });

  it('has .cleo/project-context.json marking it as a single-package node project', () => {
    const path = join(__dirname, fixture, '.cleo', 'project-context.json');
    const ctx = JSON.parse(readFileSync(path, 'utf-8')) as {
      primaryType: string;
      monorepo: boolean;
    };
    expect(ctx.primaryType).toBe('node');
    expect(ctx.monorepo).toBe(false);
  });
});

describe('release-test-rust-crate fixture', () => {
  const fixture = 'release-test-rust-crate';

  it('has parseable .cleo/release-config.json declaring single-rust-crate archetype', () => {
    const config = readReleaseConfig(fixture);
    expect(config.archetype).toBe('single-rust-crate');
    expect(config.versionScheme).toBe('semver');
    expect(config.platformMatrix.every((p) => p.publisher === 'cargo')).toBe(true);
  });

  it('has the expected Rust crate layout', () => {
    expect(existsSync(join(__dirname, fixture, 'Cargo.toml'))).toBe(true);
    expect(existsSync(join(__dirname, fixture, 'src', 'lib.rs'))).toBe(true);
  });

  it('has .cleo/project-context.json marking it as a rust project', () => {
    const path = join(__dirname, fixture, '.cleo', 'project-context.json');
    const ctx = JSON.parse(readFileSync(path, 'utf-8')) as {
      primaryType: string;
      monorepo: boolean;
    };
    expect(ctx.primaryType).toBe('rust');
    expect(ctx.monorepo).toBe(false);
  });
});
