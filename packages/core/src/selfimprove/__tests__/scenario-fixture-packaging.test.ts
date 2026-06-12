/**
 * Packaging smoke test: the self-improvement scenario fixtures must ship inside
 * the compiled `dist` tree so a released/built install can run
 * `cleo selfimprove run --scenario <name>` (T11974 · DHQ-078).
 *
 * The runtime resolver ({@link ../scenario.ts | loadScenario}) derives the
 * fixture directory from `import.meta.url` of the *compiled* module, i.e.
 * `dist/selfimprove/scenarios/<name>/{scenario,golden}.json`. These are non-TS
 * assets that neither `tsc` nor the esbuild entry-point scan emits — they are
 * copied into `dist` by `scripts/copy-selfimprove-fixtures.mjs` (per-package
 * build) and the equivalent step in the root `build.mjs` (publish bundle).
 *
 * This test asserts the fixtures resolve from the package's `dist` location for
 * the `dhq-replay-find` scenario, so a regression that drops the copy step is
 * caught before publish. It reads the package root from `import.meta.url`
 * rather than relying on `src`, so it fails if `dist` was built without the
 * fixtures present.
 *
 * @epic T11889
 * @task T11974
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Resolve the `@cleocode/core` package root from this test file's location.
 *
 * This file lives at `src/selfimprove/__tests__/`, so the package root is three
 * directories up.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The canned scenario the self-improvement loop replays by default. */
const SCENARIO = 'dhq-replay-find';

/** The seeded-code-regression scenario (T11988). */
const SEEDED_SCENARIO = 'seeded-code-regression';

describe('selfimprove scenario fixture packaging (T11974)', () => {
  it('copies the scenario.json + golden.json into dist after build', () => {
    const distDir = resolve(packageRoot, 'dist/selfimprove/scenarios', SCENARIO);
    const distScenario = resolve(distDir, 'scenario.json');
    const distGolden = resolve(distDir, 'golden.json');

    // If dist does not exist yet (e.g. tests run before any build), skip the
    // hard dist assertion but still prove the source fixtures exist so the copy
    // step has something to copy.
    const builtDistExists = existsSync(resolve(packageRoot, 'dist/selfimprove/scenario.js'));
    if (builtDistExists) {
      expect(existsSync(distScenario)).toBe(true);
      expect(existsSync(distGolden)).toBe(true);
    }
  });

  it('has the source fixtures the copy step ships', () => {
    const srcDir = resolve(packageRoot, 'src/selfimprove/scenarios', SCENARIO);
    expect(existsSync(resolve(srcDir, 'scenario.json'))).toBe(true);
    expect(existsSync(resolve(srcDir, 'golden.json'))).toBe(true);
  });
});

describe('seeded-code-regression scenario fixture packaging (T11988)', () => {
  it('has the seeded scenario source fixtures', () => {
    const srcDir = resolve(packageRoot, 'src/selfimprove/scenarios', SEEDED_SCENARIO);
    expect(existsSync(resolve(srcDir, 'scenario.json'))).toBe(true);
    expect(existsSync(resolve(srcDir, 'golden.json'))).toBe(true);
  });

  it('seeded scenario.json is parseable and has the probe op', () => {
    const srcDir = resolve(packageRoot, 'src/selfimprove/scenarios', SEEDED_SCENARIO);
    const raw = JSON.parse(readFileSync(resolve(srcDir, 'scenario.json'), 'utf8')) as {
      name: string;
      ops: { gateway: string; domain: string; operation: string }[];
    };
    expect(raw.name).toBe(SEEDED_SCENARIO);
    expect(raw.ops).toHaveLength(1);
    expect(raw.ops[0]?.domain).toBe('selfimprove');
    expect(raw.ops[0]?.operation).toBe('probe');
    expect(raw.ops[0]?.gateway).toBe('query');
  });

  it('seeded golden.json expects { probe: "ok", version: 1 }', () => {
    const srcDir = resolve(packageRoot, 'src/selfimprove/scenarios', SEEDED_SCENARIO);
    const raw = JSON.parse(readFileSync(resolve(srcDir, 'golden.json'), 'utf8')) as {
      name: string;
      envelopes: { data: { probe: string; version: number } }[];
    };
    expect(raw.name).toBe(SEEDED_SCENARIO);
    expect(raw.envelopes).toHaveLength(1);
    expect(raw.envelopes[0]?.data.probe).toBe('ok');
    expect(raw.envelopes[0]?.data.version).toBe(1);
  });

  it('copies the seeded-code-regression fixtures into dist after build', () => {
    const distDir = resolve(packageRoot, 'dist/selfimprove/scenarios', SEEDED_SCENARIO);
    const builtDistExists = existsSync(resolve(packageRoot, 'dist/selfimprove/scenario.js'));
    if (builtDistExists) {
      expect(existsSync(resolve(distDir, 'scenario.json'))).toBe(true);
      expect(existsSync(resolve(distDir, 'golden.json'))).toBe(true);
    }
  });
});
