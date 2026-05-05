import { homedir } from 'node:os';
import { join } from 'node:path';
import envPaths from 'env-paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlatformPathsResolver } from '../platform-paths.js';

const TEST_ENV = 'CLEOPATHS_TEST_HOME';

describe('createPlatformPathsResolver', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[TEST_ENV];
    delete process.env[TEST_ENV];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[TEST_ENV];
    } else {
      process.env[TEST_ENV] = originalEnv;
    }
  });

  it('resolves env-paths defaults when no override is set', () => {
    const resolver = createPlatformPathsResolver('cleopaths-test', TEST_ENV);
    const paths = resolver.getPlatformPaths();
    const expected = envPaths('cleopaths-test', { suffix: '' });
    expect(paths.data).toBe(expected.data);
    expect(paths.config).toBe(expected.config);
    expect(paths.cache).toBe(expected.cache);
    expect(paths.log).toBe(expected.log);
    expect(paths.temp).toBe(expected.temp);
  });

  it('honours absolute-path home override', () => {
    process.env[TEST_ENV] = '/custom/abs/path';
    const resolver = createPlatformPathsResolver('cleopaths-test', TEST_ENV);
    expect(resolver.getPlatformPaths().data).toBe('/custom/abs/path');
  });

  it('expands tilde in home override', () => {
    process.env[TEST_ENV] = '~/dotcleo';
    const resolver = createPlatformPathsResolver('cleopaths-test', TEST_ENV);
    expect(resolver.getPlatformPaths().data).toBe(join(homedir(), 'dotcleo'));
  });

  it('expands bare ~ in home override', () => {
    process.env[TEST_ENV] = '~';
    const resolver = createPlatformPathsResolver('cleopaths-test', TEST_ENV);
    expect(resolver.getPlatformPaths().data).toBe(homedir());
  });

  it('resolves relative override paths against homedir', () => {
    process.env[TEST_ENV] = 'rel/data';
    const resolver = createPlatformPathsResolver('cleopaths-test', TEST_ENV);
    expect(resolver.getPlatformPaths().data).toBe(join(homedir(), 'rel/data'));
  });

  it('treats blank/whitespace override as unset', () => {
    process.env[TEST_ENV] = '   ';
    const resolver = createPlatformPathsResolver('cleopaths-test', TEST_ENV);
    expect(resolver.getPlatformPaths().data).toBe(envPaths('cleopaths-test', { suffix: '' }).data);
  });

  it('reads paths fresh on every call (no path cache)', () => {
    const resolver = createPlatformPathsResolver('cleopaths-test', TEST_ENV);
    expect(resolver.getPlatformPaths().data).toBe(envPaths('cleopaths-test', { suffix: '' }).data);
    process.env[TEST_ENV] = '/mid/run/override';
    expect(resolver.getPlatformPaths().data).toBe('/mid/run/override');
  });

  it('caches getSystemInfo and resetCache invalidates it', () => {
    const resolver = createPlatformPathsResolver('cleopaths-test', TEST_ENV);
    const a = resolver.getSystemInfo();
    const b = resolver.getSystemInfo();
    expect(a).toBe(b);
    resolver.resetCache();
    const c = resolver.getSystemInfo();
    expect(c).not.toBe(a);
    expect(c.platform).toBe(a.platform);
  });

  it('isolates SystemInfo cache per resolver instance', () => {
    const r1 = createPlatformPathsResolver('cleopaths-test-a', TEST_ENV);
    const r2 = createPlatformPathsResolver('cleopaths-test-b', TEST_ENV);
    const info1 = r1.getSystemInfo();
    const info2 = r2.getSystemInfo();
    expect(info1).not.toBe(info2);
    expect(info1.paths.data).not.toBe(info2.paths.data);
  });
});
