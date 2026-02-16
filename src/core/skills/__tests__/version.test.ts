/**
 * Tests for skills version tracking.
 * @task T4522
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the CLEO_HOME to use a temp dir
const testHome = join(tmpdir(), `cleo-version-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  mkdirSync(testHome, { recursive: true });
  process.env['CLEO_HOME'] = testHome;
});

afterEach(() => {
  delete process.env['CLEO_HOME'];
  if (existsSync(testHome)) {
    rmSync(testHome, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// Lazy import to pick up env changes
async function importVersion() {
  // Force re-import by busting module cache
  const mod = await import('../version.js');
  return mod;
}

describe('version tracking', () => {
  it('should initialize installed skills file', async () => {
    const { initInstalledSkills, readInstalledSkills } = await importVersion();

    const result = initInstalledSkills();

    expect(result._meta.version).toBe('1.0.0');
    expect(Object.keys(result.skills)).toHaveLength(0);

    // File should exist now
    const path = join(testHome, 'installed-skills.json');
    expect(existsSync(path)).toBe(true);
  });

  it('should record and retrieve skill versions', async () => {
    const { recordSkillVersion, getInstalledVersion } = await importVersion();

    recordSkillVersion('ct-test-skill', '1.2.3', '/src/path', '/target/path');

    const version = getInstalledVersion('ct-test-skill');
    expect(version).toBe('1.2.3');
  });

  it('should return null for unknown skills', async () => {
    const { getInstalledVersion } = await importVersion();

    expect(getInstalledVersion('nonexistent')).toBeNull();
  });

  it('should update existing skill version', async () => {
    const { recordSkillVersion, getInstalledVersion } = await importVersion();

    recordSkillVersion('ct-test', '1.0.0', '/src', '/target');
    recordSkillVersion('ct-test', '2.0.0', '/src', '/target');

    expect(getInstalledVersion('ct-test')).toBe('2.0.0');
  });
});
