/**
 * Isolated runtime roots for checks that run an INSTALLED cleo (T12273, T13144).
 *
 * An installed CLI reads its stores, config and provider homes from the
 * environment. A check that inherits the caller's environment would open the
 * caller's real `~/.cleo`, real provider config and real npm cache, so every
 * root below points at a directory under one owned temporary root instead, and
 * nothing else is inherited except `PATH`. Credentials and path pins in the
 * caller's environment never reach the child.
 *
 * Used by `packed-install-smoke.mjs` (local tarballs) and
 * `release-canary-soak.mjs` (a published canary).
 *
 * @module scripts/lib/sandbox-env
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Environment variables that point at a directory, mapped to that directory's
 * path relative to the sandbox root.
 */
export const SANDBOX_ROOTS = Object.freeze({
  HOME: 'home',
  USERPROFILE: 'home',
  XDG_DATA_HOME: 'data',
  XDG_CONFIG_HOME: 'config',
  XDG_CACHE_HOME: 'cache',
  XDG_STATE_HOME: 'state',
  XDG_RUNTIME_DIR: 'runtime',
  TMPDIR: 'tmp',
  TMP: 'tmp',
  TEMP: 'tmp',
  CLEO_HOME: 'cleo',
  CLEO_CONFIG_HOME: 'cleo-config',
  CLEO_ROOT: 'project',
  CLEO_PROJECT_ROOT: 'project',
  CLEO_DIR: 'project/.cleo',
  NEXUS_HOME: 'nexus',
  NEXUS_CACHE_DIR: 'nexus/cache',
  AGENTS_HOME: 'agents',
  CLAUDE_CONFIG_DIR: 'claude',
  CODEX_HOME: 'codex',
  KIMI_CODE_HOME: 'kimi-code',
  KIMI_HOME: 'kimi',
  KIMI_CONFIG_DIR: 'kimi/config',
  OPENCODE_CONFIG_DIR: 'opencode',
  CURSOR_CONFIG_DIR: 'cursor',
  GEMINI_CLI_HOME: 'gemini',
  npm_config_cache: 'npm-cache',
});

/**
 * Create the isolated runtime roots and return the child environment.
 *
 * @param {string} root - Owned temporary directory; every root is created under it.
 * @param {Record<string, string>} [extraRoots] - More variables to point under `root`,
 *   as `{ NAME: 'relative/dir' }`.
 * @returns {NodeJS.ProcessEnv} Explicit child environment. Package installation may
 *   still reach the npm registry.
 */
export function sandboxEnvironment(root, extraRoots = {}) {
  const env = {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    CI: '1',
    NO_COLOR: '1',
    CLEO_HEADLESS: '1',
    CLEO_DISABLE_LOCAL_INFERENCE: '1',
    NODE_OPTIONS: '--max-old-space-size=2048',
  };
  for (const [key, path] of Object.entries({ ...SANDBOX_ROOTS, ...extraRoots })) {
    env[key] = join(root, path);
    mkdirSync(env[key], { recursive: true });
  }
  return env;
}
