import { homedir } from 'node:os';
import { join } from 'node:path';
import envPaths from 'env-paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetCleoPlatformPathsCache,
  getCanonicalTemplatesTildePath,
  getCleoHome,
  getCleoPlatformPaths,
  getCleoSystemInfo,
  getCleoTemplatesTildePath,
  resolveLegacyCleoDir,
} from '../cleo-paths.js';

describe('cleo-paths', () => {
  let originalCleoHome: string | undefined;

  beforeEach(() => {
    originalCleoHome = process.env['CLEO_HOME'];
    delete process.env['CLEO_HOME'];
    _resetCleoPlatformPathsCache();
  });

  afterEach(() => {
    if (originalCleoHome === undefined) {
      delete process.env['CLEO_HOME'];
    } else {
      process.env['CLEO_HOME'] = originalCleoHome;
    }
    _resetCleoPlatformPathsCache();
  });

  it('getCleoHome defaults to env-paths data dir for "cleo"', () => {
    expect(getCleoHome()).toBe(envPaths('cleo', { suffix: '' }).data);
  });

  it('getCleoHome honours CLEO_HOME override', () => {
    process.env['CLEO_HOME'] = '/opt/cleo-data';
    expect(getCleoHome()).toBe('/opt/cleo-data');
  });

  it('getCleoPlatformPaths returns the full PlatformPaths struct', () => {
    const paths = getCleoPlatformPaths();
    const expected = envPaths('cleo', { suffix: '' });
    expect(paths.data).toBe(expected.data);
    expect(paths.config).toBe(expected.config);
    expect(paths.cache).toBe(expected.cache);
    expect(paths.log).toBe(expected.log);
    expect(paths.temp).toBe(expected.temp);
  });

  it('getCleoSystemInfo returns a SystemInfo snapshot with cleo paths', () => {
    const info = getCleoSystemInfo();
    expect(typeof info.platform).toBe('string');
    expect(typeof info.arch).toBe('string');
    expect(info.paths.data).toBe(envPaths('cleo', { suffix: '' }).data);
  });

  it('getCleoTemplatesTildePath returns ~-prefixed path under home', () => {
    delete process.env['CLEO_HOME'];
    const tilde = getCleoTemplatesTildePath();
    expect(tilde.startsWith('~/')).toBe(true);
    expect(tilde.endsWith('/templates')).toBe(true);
  });

  it('getCleoTemplatesTildePath returns absolute path when CLEO_HOME is outside home', () => {
    process.env['CLEO_HOME'] = '/opt/cleo';
    expect(getCleoTemplatesTildePath()).toBe('/opt/cleo/templates');
  });

  it('getCleoTemplatesTildePath converts paths under homedir to tilde form', () => {
    process.env['CLEO_HOME'] = join(homedir(), 'custom-cleo');
    expect(getCleoTemplatesTildePath()).toBe('~/custom-cleo/templates');
  });

  // ── getCanonicalTemplatesTildePath (T9020) ─────────────────────────────────

  describe('getCanonicalTemplatesTildePath()', () => {
    it('always returns the stable ~/.cleo/templates path', () => {
      expect(getCanonicalTemplatesTildePath()).toBe('~/.cleo/templates');
    });

    it('is immune to CLEO_HOME override — returns stable path even when CLEO_HOME is a temp dir', () => {
      process.env['CLEO_HOME'] = join(
        homedir(),
        '.temp',
        'cleo-injection-chain-XXXXXX',
        '.cleo-home',
      );
      _resetCleoPlatformPathsCache();
      // getCleoTemplatesTildePath would return the temp path here
      expect(getCleoTemplatesTildePath()).toContain('cleo-injection-chain-XXXXXX');
      // getCanonicalTemplatesTildePath must NOT be affected
      expect(getCanonicalTemplatesTildePath()).toBe('~/.cleo/templates');
    });

    it('is immune to CLEO_HOME override — returns stable path even when CLEO_HOME is outside home', () => {
      process.env['CLEO_HOME'] = '/opt/custom-cleo-data';
      _resetCleoPlatformPathsCache();
      expect(getCleoTemplatesTildePath()).toBe('/opt/custom-cleo-data/templates');
      expect(getCanonicalTemplatesTildePath()).toBe('~/.cleo/templates');
    });

    it('produces the correct @-reference for CLEO-INJECTION.md', () => {
      const ref = `@${getCanonicalTemplatesTildePath()}/CLEO-INJECTION.md`;
      expect(ref).toBe('@~/.cleo/templates/CLEO-INJECTION.md');
    });
  });

  // ── resolveLegacyCleoDir (T9685-B2) ───────────────────────────────────────

  describe('resolveLegacyCleoDir()', () => {
    it('returns the override when provided', () => {
      expect(resolveLegacyCleoDir('/custom/cleo-dir')).toBe('/custom/cleo-dir');
    });

    it('returns ~/.cleo when no override is provided', () => {
      expect(resolveLegacyCleoDir()).toBe(join(homedir(), '.cleo'));
    });

    it('returns ~/.cleo when override is undefined', () => {
      expect(resolveLegacyCleoDir(undefined)).toBe(join(homedir(), '.cleo'));
    });

    it('treats empty string override as falsy and falls back to ~/.cleo', () => {
      // Empty string is falsy — falls through to default. Documented behaviour:
      // CLI handlers that pass `args['cleo-dir'] as string | undefined` will never
      // pass '', but we guard against it explicitly so the contract is clear.
      expect(resolveLegacyCleoDir('')).toBe(join(homedir(), '.cleo'));
    });

    it('is immune to CLEO_HOME — always resolves the legacy ~/.cleo path', () => {
      process.env['CLEO_HOME'] = '/opt/custom-cleo';
      _resetCleoPlatformPathsCache();
      // Even with CLEO_HOME set, the legacy resolver returns ~/.cleo
      expect(resolveLegacyCleoDir()).toBe(join(homedir(), '.cleo'));
    });
  });
});
