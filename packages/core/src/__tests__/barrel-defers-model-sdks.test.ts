/**
 * Loading the `@cleocode/core` barrels evaluates no model SDK (T13126).
 *
 * Every `cleo` command loads `@cleocode/core/internal`. Three modules reachable
 * from it imported heavy SDKs statically: `llm/conversation` (js-tiktoken),
 * `llm/transports/bedrock` (the AWS Bedrock client and credential providers)
 * and `memory/dialectic-evaluator` / `memory/transcript-extractor` (`ai`).
 * Together they added ~45 MB of peak RSS to every process, for code almost no
 * command runs. They now load on first use; this test fails if one of them
 * becomes a load-time import again.
 *
 * It runs against the BUILT dist in a fresh process, because what matters is
 * what Node actually evaluates. Without a dist it is skipped, as the other
 * dist-dependent suites here are (CI restores the build first).
 *
 * @task T13126
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

/** Packages that must not be evaluated just by loading a barrel. */
const DEFERRED_SDKS = [
  'js-tiktoken',
  '@aws-sdk/client-bedrock-runtime',
  '@aws-sdk/credential-providers',
  'ai',
];

/** Module URLs a fresh process evaluates when it imports `entry`. */
function loadedUrls(entry: string): string[] {
  const probe = [
    "import { registerHooks } from 'node:module';",
    'const urls = [];',
    'registerHooks({ load(url, context, next) { urls.push(url); return next(url, context); } });',
    `await import(${JSON.stringify(pathToFileURL(entry).href)});`,
    'process.stdout.write(JSON.stringify(urls));',
  ].join('\n');
  // A throwaway HOME: importing core must not touch the developer's stores.
  const home = mkdtempSync(join(tmpdir(), 'core-barrel-sdk-probe-'));
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, HOME: home, CLEO_HOME: join(home, '.cleo') },
    });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout) as string[];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The package directory names a loaded URL belongs to (`node_modules/<pkg>/`). */
function loadedPackages(urls: readonly string[]): Set<string> {
  const packages = new Set<string>();
  for (const url of urls) {
    for (const match of url.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)) {
      if (match[1]) packages.add(match[1]);
    }
  }
  return packages;
}

describe('core barrels defer model SDKs to first use (T13126)', () => {
  for (const barrel of ['internal.js', 'index.js']) {
    const entry = join(DIST_DIR, barrel);
    it.skipIf(!existsSync(entry))(`loading dist/${barrel} evaluates none of them`, () => {
      const packages = loadedPackages(loadedUrls(entry));
      // Guard against a vacuous pass: the barrel did load its own dependencies.
      expect(packages.has('drizzle-orm')).toBe(true);
      expect(DEFERRED_SDKS.filter((sdk) => packages.has(sdk))).toEqual([]);
    });
  }
});
