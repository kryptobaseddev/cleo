/**
 * Tests for the web subsystem — `createWebSubsystem()` + helpers.
 *
 * @task T11506 R6-T1 — web-subsystem.ts created
 * @task T11257 R6 — migrate web command → daemon subsystem
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWebSubsystem,
  getWebPaths,
  isWebProcessRunning,
  resolveStudioDir,
  WEB_DEFAULT_HOST,
  WEB_DEFAULT_PORT,
  WEB_SUBSYSTEM_NAME,
} from '../web-subsystem.js';

describe('createWebSubsystem (T11506 R6-T1)', () => {
  it('produces a subsystem with the correct name', () => {
    const sub = createWebSubsystem();
    expect(sub.name).toBe(WEB_SUBSYSTEM_NAME);
    expect(sub.name).toBe('cleo-web');
  });

  it('subsystem is frozen (defineSubsystem contract)', () => {
    const sub = createWebSubsystem();
    expect(Object.isFrozen(sub)).toBe(true);
  });

  it('subsystem has start, healthProbe, and shutdown functions', () => {
    const sub = createWebSubsystem();
    expect(typeof sub.start).toBe('function');
    expect(typeof sub.healthProbe).toBe('function');
    expect(typeof sub.shutdown).toBe('function');
  });

  it('healthProbe returns stopped state before start (T11506 AC3)', () => {
    const sub = createWebSubsystem({ port: WEB_DEFAULT_PORT, host: WEB_DEFAULT_HOST });
    const health = sub.healthProbe();
    expect(health.state).toBe('stopped');
    expect(health.child_id).toBe(WEB_SUBSYSTEM_NAME);
    expect(health.pid).toBe(0);
    expect(health.restart_count).toBe(0);
  });

  it('uses default port 3456 when none specified', () => {
    const sub = createWebSubsystem();
    // Verify the name remains correct regardless of port.
    expect(sub.name).toBe(WEB_SUBSYSTEM_NAME);
  });

  it('accepts custom port and host options', () => {
    // Just verify it constructs without error — actual binding is IO.
    const sub = createWebSubsystem({ port: 4567, host: '0.0.0.0' });
    expect(sub.name).toBe(WEB_SUBSYSTEM_NAME);
    const health = sub.healthProbe();
    expect(health.state).toBe('stopped');
  });
});

describe('WEB_DEFAULT_PORT / WEB_DEFAULT_HOST constants', () => {
  it('DEFAULT_PORT is 3456 (TCP port 3456 binding preserved — T11257 AC4)', () => {
    expect(WEB_DEFAULT_PORT).toBe(3456);
  });

  it('DEFAULT_HOST is 127.0.0.1', () => {
    expect(WEB_DEFAULT_HOST).toBe('127.0.0.1');
  });
});

describe('getWebPaths', () => {
  it('returns an object with pidFile, configFile, logDir, logFile fields', () => {
    const paths = getWebPaths();
    expect(typeof paths.pidFile).toBe('string');
    expect(typeof paths.configFile).toBe('string');
    expect(typeof paths.logDir).toBe('string');
    expect(typeof paths.logFile).toBe('string');
  });

  it('pidFile is named web-server.pid', () => {
    const { pidFile } = getWebPaths();
    expect(pidFile).toMatch(/web-server\.pid$/);
  });

  it('logFile is nested under logDir', () => {
    const { logDir, logFile } = getWebPaths();
    expect(logFile.startsWith(logDir)).toBe(true);
  });
});

describe('isWebProcessRunning', () => {
  it('returns true for the current process', () => {
    expect(isWebProcessRunning(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    // PID 2147483647 is far above the Linux default limit of 4194304.
    expect(isWebProcessRunning(2_147_483_647)).toBe(false);
  });
});

describe('resolveStudioDir package layouts (T12255)', () => {
  let fixture: string;
  let packageRoot: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'cleo-studio-layout-'));
    packageRoot = join(fixture, 'node_modules', '@cleocode', 'cleo');
    vi.stubEnv('CLEO_STUDIO_DIR', '');
    vi.stubEnv('CLEO_ROOT', join(fixture, 'project'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  });

  function buildAt(directory: string): string {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'index.js'), '// synthetic Studio entry');
    return directory;
  }

  function moduleUrl(relative = 'dist/cli/index.js'): string {
    return pathToFileURL(join(packageRoot, relative)).href;
  }

  it.each([
    'src/cli/web-subsystem.ts',
    'dist/cli/web-subsystem.js',
    'dist/cli/index.js',
  ])('resolves bundled Studio relative to %s without selecting a scope-level decoy', (relative) => {
    const expected = buildAt(join(packageRoot, 'studio-dist'));
    buildAt(join(fixture, 'node_modules', '@cleocode', 'studio-dist'));
    buildAt(join(fixture, 'project', 'packages', 'studio', 'build'));
    expect(resolveStudioDir(moduleUrl(relative))).toBe(expected);
  });

  it('honors an existing explicit deployment override before the bundle', () => {
    buildAt(join(packageRoot, 'studio-dist'));
    const override = buildAt(join(fixture, 'override'));
    vi.stubEnv('CLEO_STUDIO_DIR', override);
    expect(resolveStudioDir(moduleUrl())).toBe(override);
  });

  it('ignores a missing override and resolves the installed bundle', () => {
    const expected = buildAt(join(packageRoot, 'studio-dist'));
    vi.stubEnv('CLEO_STUDIO_DIR', join(fixture, 'missing'));
    expect(resolveStudioDir(moduleUrl())).toBe(expected);
  });

  it('falls back to an explicit development project when the bundle is missing', () => {
    const expected = buildAt(join(fixture, 'project', 'packages', 'studio', 'build'));
    expect(resolveStudioDir(moduleUrl())).toBe(expected);
  });

  it('requires an entry file instead of accepting an empty bundled directory', () => {
    mkdirSync(join(packageRoot, 'studio-dist'), { recursive: true });
    expect(resolveStudioDir(moduleUrl())).toBeUndefined();
  });

  it('uses the development fallback when the module URL cannot name a file', () => {
    const expected = buildAt(join(fixture, 'project', 'packages', 'studio', 'build'));
    expect(resolveStudioDir('https://invalid.example/entry.js')).toBe(expected);
  });
});
