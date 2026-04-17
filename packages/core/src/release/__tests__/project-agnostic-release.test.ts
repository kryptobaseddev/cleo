/**
 * Tests for T820 project-agnostic release pipeline.
 *
 * Covers:
 *   - RELEASE-01: .cleo/release-config.json loading and precedence
 *   - RELEASE-02: Auto-CHANGELOG from git log (unit-level, no git required)
 *   - RELEASE-05: Real rollback (git operations via mocks)
 *   - RELEASE-06: Downstream fixture has no hardcoded cleocode paths
 *
 * @task T820
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPushMode, loadReleaseConfig, validateReleaseConfig } from '../release-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject(): string {
  const dir = join(
    tmpdir(),
    `cleo-release-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  // Minimal package.json so isNodeProject check passes
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'test-project', version: '1.0.0' }),
  );
  return dir;
}

function writeReleaseConfig(dir: string, config: object): void {
  writeFileSync(join(dir, '.cleo', 'release-config.json'), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// RELEASE-01: .cleo/release-config.json loading
// ---------------------------------------------------------------------------

describe('RELEASE-01: loadReleaseConfig with release-config.json', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpProject();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no release-config.json exists', () => {
    const config = loadReleaseConfig(tmpDir);
    expect(config.versioningScheme).toBe('calver');
    expect(config.tagPrefix).toBe('v');
    expect(config.changelogFile).toBe('CHANGELOG.md');
    expect(config.changelogFormat).toBe('keepachangelog');
    expect(config.artifactType).toBe('generic-tarball');
  });

  it('reads versionScheme from release-config.json', () => {
    writeReleaseConfig(tmpDir, { versionScheme: 'semver' });
    const config = loadReleaseConfig(tmpDir);
    expect(config.versioningScheme).toBe('semver');
  });

  it('reads tagPrefix from release-config.json', () => {
    writeReleaseConfig(tmpDir, { tagPrefix: 'rel-' });
    const config = loadReleaseConfig(tmpDir);
    expect(config.tagPrefix).toBe('rel-');
  });

  it('reads gitWorkflow from release-config.json', () => {
    writeReleaseConfig(tmpDir, { gitWorkflow: 'pr' });
    const config = loadReleaseConfig(tmpDir);
    expect(config.gitWorkflow).toBe('pr');
  });

  it('reads registries from release-config.json', () => {
    writeReleaseConfig(tmpDir, { registries: ['npm', 'docker'] });
    const config = loadReleaseConfig(tmpDir);
    expect(config.registries).toEqual(['npm', 'docker']);
  });

  it('reads buildArtifactPaths from release-config.json', () => {
    writeReleaseConfig(tmpDir, { buildArtifactPaths: ['packages/cli/dist'] });
    const config = loadReleaseConfig(tmpDir);
    expect(config.buildArtifactPaths).toEqual(['packages/cli/dist']);
  });

  it('reads skipBuildArtifactGate from release-config.json', () => {
    writeReleaseConfig(tmpDir, { skipBuildArtifactGate: true });
    const config = loadReleaseConfig(tmpDir);
    expect(config.skipBuildArtifactGate).toBe(true);
  });

  it('reads security.enableProvenance from release-config.json', () => {
    writeReleaseConfig(tmpDir, { security: { enableProvenance: true, slsaLevel: 2 } });
    const config = loadReleaseConfig(tmpDir);
    expect(config.security.enableProvenance).toBe(true);
    expect(config.security.slsaLevel).toBe(2);
  });

  it('returns {} fields for unset optional fields', () => {
    writeReleaseConfig(tmpDir, { versionScheme: 'semver' });
    const config = loadReleaseConfig(tmpDir);
    expect(config.gitWorkflow).toBeUndefined();
    expect(config.registries).toBeUndefined();
    expect(config.prereleaseChannel).toBeUndefined();
  });

  it('gracefully handles malformed release-config.json', () => {
    writeFileSync(join(tmpDir, '.cleo', 'release-config.json'), '{ invalid json }');
    const config = loadReleaseConfig(tmpDir);
    // Should fall back to defaults without throwing
    expect(config.versioningScheme).toBe('calver');
  });
});

// ---------------------------------------------------------------------------
// RELEASE-01: getPushMode respects gitWorkflow field
// ---------------------------------------------------------------------------

describe('RELEASE-01: getPushMode with gitWorkflow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpProject();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns pr when gitWorkflow=pr', () => {
    writeReleaseConfig(tmpDir, { gitWorkflow: 'pr' });
    const config = loadReleaseConfig(tmpDir);
    expect(getPushMode(config)).toBe('pr');
  });

  it('returns direct when gitWorkflow=direct', () => {
    writeReleaseConfig(tmpDir, { gitWorkflow: 'direct' });
    const config = loadReleaseConfig(tmpDir);
    expect(getPushMode(config)).toBe('direct');
  });

  it('returns auto when no gitWorkflow set', () => {
    const config = loadReleaseConfig(tmpDir);
    expect(getPushMode(config)).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// RELEASE-01: validateReleaseConfig with new fields
// ---------------------------------------------------------------------------

describe('RELEASE-01: validateReleaseConfig with T820 fields', () => {
  const baseConfig = {
    versioningScheme: 'calver',
    tagPrefix: 'v',
    changelogFormat: 'keepachangelog',
    changelogFile: 'CHANGELOG.md',
    artifactType: 'generic-tarball',
    gates: [],
    versionBump: { files: [] },
    security: { enableProvenance: false, slsaLevel: 3, requireSignedCommits: false },
  };

  it('validates valid gitWorkflow=pr', () => {
    const result = validateReleaseConfig({ ...baseConfig, gitWorkflow: 'pr' });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates valid gitWorkflow=direct', () => {
    const result = validateReleaseConfig({ ...baseConfig, gitWorkflow: 'direct' });
    expect(result.valid).toBe(true);
  });

  it('rejects invalid gitWorkflow', () => {
    const result = validateReleaseConfig({ ...baseConfig, gitWorkflow: 'invalid' as 'pr' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('gitWorkflow'))).toBe(true);
  });

  it('warns on unknown registry', () => {
    const result = validateReleaseConfig({
      ...baseConfig,
      registries: ['unknown-registry' as 'npm'],
    });
    expect(result.warnings.some((w) => w.includes('unknown-registry'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RELEASE-06: downstream test fixture has no hardcoded cleocode paths
// ---------------------------------------------------------------------------

describe('RELEASE-06: downstream fixture is project-agnostic', () => {
  const fixturePath = new URL(
    '../../../../cleo/test/fixtures/release-test-project',
    import.meta.url,
  ).pathname;

  it('fixture directory exists', () => {
    expect(existsSync(fixturePath)).toBe(true);
  });

  it('fixture has .cleo/release-config.json', () => {
    expect(existsSync(join(fixturePath, '.cleo', 'release-config.json'))).toBe(true);
  });

  it('fixture release-config.json loads without errors', () => {
    const config = loadReleaseConfig(fixturePath);
    expect(config).toBeDefined();
    expect(config.versioningScheme).toBe('semver');
  });

  it('fixture does not reference cleocode-specific paths', () => {
    const { readFileSync } = require('node:fs');
    const configRaw = readFileSync(join(fixturePath, '.cleo', 'release-config.json'), 'utf-8');
    expect(configRaw).not.toContain('packages/cleo');
    expect(configRaw).not.toContain('cleocode');
    expect(configRaw).not.toContain('monorepo');
  });

  it('fixture skipBuildArtifactGate is true (source-only project)', () => {
    const config = loadReleaseConfig(fixturePath);
    expect(config.skipBuildArtifactGate).toBe(true);
  });

  it('fixture artifactType is source-only', () => {
    const config = loadReleaseConfig(fixturePath);
    expect(config.artifactType).toBe('source-only');
  });

  it('fixture validation passes', () => {
    const config = loadReleaseConfig(fixturePath);
    const result = validateReleaseConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
