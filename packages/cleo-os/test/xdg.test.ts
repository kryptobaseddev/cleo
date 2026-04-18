import { describe, it, expect, afterEach } from 'vitest';
import { resolveCleoOsPaths } from '../src/xdg.js';

describe('resolveCleoOsPaths', () => {
  const originalEnv: Record<string, string | undefined> = { ...process.env };

  // Restore via mutation (not reassignment) so env-paths's module-level
  // `const {env} = process` reference stays live across tests.
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  it('uses default XDG paths when env vars are not set', () => {
    delete process.env['XDG_DATA_HOME'];
    delete process.env['XDG_CONFIG_HOME'];
    const paths = resolveCleoOsPaths();
    expect(paths.data).toContain('.local/share/cleo');
    expect(paths.config).toContain('.config/cleo');
  });

  it('respects XDG_DATA_HOME override', () => {
    process.env['XDG_DATA_HOME'] = '/tmp/test-xdg-data';
    const paths = resolveCleoOsPaths();
    expect(paths.data).toBe('/tmp/test-xdg-data/cleo');
    expect(paths.extensions).toBe('/tmp/test-xdg-data/cleo/extensions');
  });

  it('respects XDG_CONFIG_HOME override', () => {
    process.env['XDG_CONFIG_HOME'] = '/tmp/test-xdg-config';
    const paths = resolveCleoOsPaths();
    expect(paths.config).toBe('/tmp/test-xdg-config/cleo');
    expect(paths.auth).toBe('/tmp/test-xdg-config/cleo/auth');
  });

  it('agentDir equals data root', () => {
    const paths = resolveCleoOsPaths();
    expect(paths.agentDir).toBe(paths.data);
  });

  it('cant directory is under data root', () => {
    const paths = resolveCleoOsPaths();
    expect(paths.cant).toBe(paths.data + '/cant');
  });

  it('extensions directory is under data root', () => {
    const paths = resolveCleoOsPaths();
    expect(paths.extensions).toBe(paths.data + '/extensions');
  });

  it('cantUser directory is under config root', () => {
    const paths = resolveCleoOsPaths();
    expect(paths.cantUser).toBe(paths.config + '/cant');
  });

  it('cantUser respects XDG_CONFIG_HOME override', () => {
    process.env['XDG_CONFIG_HOME'] = '/tmp/test-xdg-config';
    const paths = resolveCleoOsPaths();
    expect(paths.cantUser).toBe('/tmp/test-xdg-config/cleo/cant');
  });
});
