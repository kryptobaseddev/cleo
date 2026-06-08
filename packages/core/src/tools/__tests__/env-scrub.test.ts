/**
 * Tests for subprocess env scrubbing (T11897 · security).
 *
 * @epic T10403
 * @task T11761
 * @task T11897
 * @saga T11387
 */

import { describe, expect, it } from 'vitest';
import { isForbiddenEnvName, scrubSubprocessEnv, TRUSTED_PATH } from '../env-scrub.js';

describe('isForbiddenEnvName', () => {
  it('rejects loader hooks (case-insensitive prefix)', () => {
    for (const name of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'ld_preload', 'DYLD_INSERT_LIBRARIES']) {
      expect(isForbiddenEnvName(name)).toBe(true);
    }
  });

  it('rejects runtime hooks and PATH/IFS', () => {
    for (const name of ['NODE_OPTIONS', 'GIT_SSH_COMMAND', 'BASH_ENV', 'PATH', 'IFS', 'CDPATH']) {
      expect(isForbiddenEnvName(name)).toBe(true);
    }
  });

  it('rejects credential-bearing names', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'CLEO_VAULT_SECRET',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'DB_PASSWORD',
      'OAUTH_CREDENTIAL',
    ]) {
      expect(isForbiddenEnvName(name)).toBe(true);
    }
  });

  it('allows benign names', () => {
    for (const name of ['LANG', 'TERM', 'HOME', 'CLEO_TEST', 'MY_FLAG']) {
      expect(isForbiddenEnvName(name)).toBe(false);
    }
  });
});

describe('scrubSubprocessEnv', () => {
  it('starts empty + pins PATH to the trusted value (never the parent PATH)', () => {
    const env = scrubSubprocessEnv({ parentEnv: { PATH: '/evil/workspace:/bin' } });
    expect(env.PATH).toBe(TRUSTED_PATH);
    expect(env.PATH).not.toContain('/evil/workspace');
  });

  it('does NOT inherit the parent secrets / loader hooks', () => {
    const env = scrubSubprocessEnv({
      parentEnv: {
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        CLEO_VAULT_SECRET: 'vault',
        LD_PRELOAD: '/tmp/evil.so',
        NODE_OPTIONS: '--require x',
      },
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLEO_VAULT_SECRET).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('copies through benign parent vars (locale, term, home)', () => {
    const env = scrubSubprocessEnv({
      parentEnv: { LANG: 'en_US.UTF-8', TERM: 'xterm', HOME: '/home/u', SECRET_TOKEN: 'x' },
    });
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.TERM).toBe('xterm');
    expect(env.HOME).toBe('/home/u');
    expect(env.SECRET_TOKEN).toBeUndefined();
  });

  it('drops a forbidden key supplied via extra (untrusted caller cannot reintroduce an escape)', () => {
    const env = scrubSubprocessEnv({
      parentEnv: {},
      extra: {
        LD_PRELOAD: '/tmp/evil.so',
        PATH: '/evil/workspace',
        ANTHROPIC_API_KEY: 'leak',
        SAFE: 'kept',
      },
    });
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.PATH).toBe(TRUSTED_PATH); // not overridable via extra
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SAFE).toBe('kept');
  });

  it('honours an explicit trusted path override', () => {
    const env = scrubSubprocessEnv({ parentEnv: {}, path: '/opt/trusted/bin' });
    expect(env.PATH).toBe('/opt/trusted/bin');
  });
});
