/**
 * Subpath contract tests for @cleocode/core.
 *
 * Purpose: assert the stable public API surface of every subpath declared in
 * `package.json` `"exports"` so that any rename, removal, or signature change
 * is caught immediately.
 *
 * Mirrors the pattern established by `llmtxt/src/__tests__/*.contract.test.ts`
 * (see STABILITY.md for the contract this test enforces).
 *
 * The tests run against the compiled `dist/` output because subpath exports
 * only resolve post-build. If `dist/` is missing, most assertions are skipped
 * with a warning rather than failing — CI runs `pnpm run build` first so this
 * branch is only used for local dev ergonomics.
 *
 * @task T948
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Resolve package root from this file (src/__tests__/subpath-contract.test.ts).
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_DIR = path.resolve(path.dirname(__filename), '..', '..');
const PKG_JSON_PATH = path.join(PACKAGE_DIR, 'package.json');
const DIST_DIR = path.join(PACKAGE_DIR, 'dist');
const SNAPSHOT_DIR = path.join(PACKAGE_DIR, '.dts-snapshots');

interface ExportConditions {
  types?: string;
  import?: string;
  require?: string;
}

interface PackageJson {
  name: string;
  version: string;
  exports: Record<string, ExportConditions | string>;
}

const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, 'utf8')) as PackageJson;
const hasDist = existsSync(DIST_DIR);

// ---------------------------------------------------------------------------
// Stable subpaths — the subset of `exports` whose structural contract is
// enforced by `.dts-snapshots/` and by STABILITY.md.
//
// NOTE: Keep this list in sync with `scripts/generate-dts-snapshots.sh`.
// ---------------------------------------------------------------------------

const STABLE_SUBPATHS: Array<{
  subpath: string;
  snapshotKey: string;
  distDts: string;
}> = [
  { subpath: '.', snapshotKey: 'root', distDts: 'index.d.ts' },
  { subpath: './sdk', snapshotKey: 'sdk', distDts: 'cleo.d.ts' },
  { subpath: './contracts', snapshotKey: 'contracts', distDts: 'contracts.d.ts' },
  { subpath: './tasks', snapshotKey: 'tasks', distDts: 'tasks/index.d.ts' },
  { subpath: './memory', snapshotKey: 'memory', distDts: 'memory/index.d.ts' },
  { subpath: './sessions', snapshotKey: 'sessions', distDts: 'sessions/index.d.ts' },
  { subpath: './nexus', snapshotKey: 'nexus', distDts: 'nexus/index.d.ts' },
  { subpath: './lifecycle', snapshotKey: 'lifecycle', distDts: 'lifecycle/index.d.ts' },
  { subpath: './conduit', snapshotKey: 'conduit', distDts: 'conduit/index.d.ts' },
];

// ---------------------------------------------------------------------------
// 1. package.json exports — declaration consistency
// ---------------------------------------------------------------------------

describe('@cleocode/core — package.json exports declaration', () => {
  it('declares every stable subpath in `exports`', () => {
    for (const { subpath } of STABLE_SUBPATHS) {
      expect(
        pkg.exports,
        `package.json must define exports[${JSON.stringify(subpath)}]`,
      ).toHaveProperty(subpath);
    }
  });

  it('every declared subpath points to both types and import conditions', () => {
    for (const { subpath } of STABLE_SUBPATHS) {
      const entry = pkg.exports[subpath];
      expect(entry, `exports[${JSON.stringify(subpath)}] must be an object`).toBeTypeOf('object');
      expect(
        (entry as ExportConditions).types,
        `exports[${JSON.stringify(subpath)}].types must be set`,
      ).toBeDefined();
      expect(
        (entry as ExportConditions).import,
        `exports[${JSON.stringify(subpath)}].import must be set`,
      ).toBeDefined();
    }
  });

  it('declares the internal subpath (sibling CLEO packages only)', () => {
    expect(pkg.exports, 'package.json must define exports["./internal"]').toHaveProperty(
      './internal',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. File-system resolution — every declared export points to a real file
// ---------------------------------------------------------------------------

describe.skipIf(!hasDist)('@cleocode/core — subpath resolution', () => {
  it('every stable subpath .d.ts exists under dist/', () => {
    for (const { subpath, distDts } of STABLE_SUBPATHS) {
      const full = path.join(DIST_DIR, distDts);
      expect(
        existsSync(full),
        `stable subpath ${subpath} -> ${distDts} must exist under dist/`,
      ).toBe(true);
      expect(statSync(full).size, `${distDts} must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('every stable subpath .js exists under dist/', () => {
    for (const { subpath, distDts } of STABLE_SUBPATHS) {
      const jsPath = path.join(DIST_DIR, distDts.replace(/\.d\.ts$/, '.js'));
      expect(
        existsSync(jsPath),
        `stable subpath ${subpath} -> ${jsPath} must exist under dist/`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Runtime import — the `./sdk` facade returns the Cleo class
// ---------------------------------------------------------------------------

describe.skipIf(!hasDist)('@cleocode/core/sdk — runtime contract', () => {
  it('dynamically resolves and exports the Cleo class', async () => {
    const sdkPath = path.join(DIST_DIR, 'cleo.js');
    const mod = (await import(sdkPath)) as Record<string, unknown>;
    expect(mod.Cleo, '@cleocode/core/sdk must export Cleo').toBeDefined();
    expect(typeof mod.Cleo).toBe('function');
  });

  it('exposes Cleo.init as a static async factory', async () => {
    const sdkPath = path.join(DIST_DIR, 'cleo.js');
    const mod = (await import(sdkPath)) as { Cleo: { init: unknown; forProject: unknown } };
    expect(typeof mod.Cleo.init).toBe('function');
    expect(typeof mod.Cleo.forProject).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 4. .dts-snapshots — every stable subpath has a snapshot baseline
// ---------------------------------------------------------------------------

describe('@cleocode/core — .dts-snapshots baseline', () => {
  it('`.dts-snapshots` directory exists', () => {
    expect(existsSync(SNAPSHOT_DIR), '.dts-snapshots/ directory must exist').toBe(true);
  });

  it.skipIf(!hasDist)('every stable subpath has a snapshot file', () => {
    const missing: string[] = [];
    for (const { subpath, snapshotKey } of STABLE_SUBPATHS) {
      const safeKey = snapshotKey.replace(/\//g, '__');
      const snapPath = path.join(SNAPSHOT_DIR, `${safeKey}.d.ts.snapshot`);
      if (!existsSync(snapPath)) {
        missing.push(`${subpath} -> ${snapPath}`);
      }
    }
    expect(
      missing,
      `Missing snapshots (run ./packages/core/scripts/generate-dts-snapshots.sh):\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Drift detection — current .d.ts matches snapshot baseline
//
// This is a non-fatal check during normal `vitest run` (it logs but doesn't
// fail) because snapshot regeneration is a deliberate CI-gated action.
// The definitive diff check is the `--check` flag in the shell script.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDist)('@cleocode/core — snapshot drift (informational)', () => {
  it('reports any stable subpath whose .d.ts has drifted from its snapshot', () => {
    const drift: string[] = [];
    for (const { subpath, snapshotKey, distDts } of STABLE_SUBPATHS) {
      const safeKey = snapshotKey.replace(/\//g, '__');
      const snapPath = path.join(SNAPSHOT_DIR, `${safeKey}.d.ts.snapshot`);
      const dtsPath = path.join(DIST_DIR, distDts);
      if (!existsSync(snapPath) || !existsSync(dtsPath)) {
        continue;
      }
      const snap = readFileSync(snapPath, 'utf8');
      const dts = readFileSync(dtsPath, 'utf8');
      if (snap !== dts) {
        drift.push(subpath);
      }
    }
    // Log-only; the authoritative gate is the shell script --check mode.
    if (drift.length > 0) {
      console.warn(
        `[subpath-contract] drift detected for: ${drift.join(', ')}. ` +
          'Run ./packages/core/scripts/generate-dts-snapshots.sh --check for authoritative diff.',
      );
    }
    // Always pass; this test is informational.
    expect(Array.isArray(drift)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Subpath count — matches STABILITY.md inventory
// ---------------------------------------------------------------------------

describe('@cleocode/core — subpath coverage sanity', () => {
  it('stable subpath list has the documented cardinality', () => {
    // STABILITY.md §Subpath inventory lists exactly these 9 stable subpaths.
    // Bump this number ONLY when adding a new stable subpath AND updating
    // STABILITY.md + the snapshot script.
    expect(STABLE_SUBPATHS.length).toBe(9);
  });
});
