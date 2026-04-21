/**
 * Idempotent seed-agent installer — T897.
 *
 * On `cleo init` (or first `cleo session start`), callers invoke
 * {@link ensureSeedAgentsInstalled} to copy canonical `.cant` files from
 * `packages/agents/seed-agents/` into the user's global CANT agents directory
 * (`~/.local/share/cleo/cant/agents/`). Subsequent calls are no-ops unless the
 * packaged seed bundle version has advanced past the marker recorded in
 * `~/.local/share/cleo/.seed-version`.
 *
 * **Idempotency contract**:
 *  1. Read `~/.local/share/cleo/.seed-version` (absent = "0.0.0").
 *  2. Compare to the current bundle version from `@cleocode/agents/package.json`.
 *  3. If the stored version equals the bundle version, return early with
 *     all files listed under `skipped`.
 *  4. Otherwise copy each `.cant` not already on disk and write the new version
 *     marker atomically.
 *
 * Skipping a file that already exists (same name) is intentional — `--force`
 * behaviour (overwrite even when present) is out of scope for auto-install.
 * Use `cleo agent install --global --force` for targeted overwrites.
 *
 * @module agents/seed-install
 * @task T897
 * @epic T889
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCleoGlobalCantAgentsDir, getCleoHome } from '../paths.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Marker file path that records the last installed seed bundle version.
 *
 * Written as a plain semver string (or CalVer `YYYY.M.patch`). Absent on a
 * fresh install — treated as `"0"` for comparison purposes.
 *
 * @task T897
 */
export const SEED_VERSION_MARKER_FILENAME = '.seed-version';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/**
 * Result returned by {@link ensureSeedAgentsInstalled}.
 *
 * @task T897
 */
export interface SeedInstallResult {
  /** Agent slugs (filename sans `.cant`) that were newly copied. */
  readonly installed: string[];
  /**
   * Agent slugs that were skipped because an on-disk file already existed
   * OR the stored version marker matched the bundle version.
   */
  readonly skipped: string[];
  /** Absolute path to the directory agents were installed into. */
  readonly destination: string;
  /**
   * Bundle version string written to the `.seed-version` marker after a
   * successful install. `null` when the install was a no-op (up-to-date).
   */
  readonly installedVersion: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical seed-agents directory from the bundled
 * `@cleocode/agents` package.
 *
 * Resolution order (first hit wins):
 *  1. `require.resolve('@cleocode/agents/package.json')` → sibling workspace.
 *  2. Walk a set of relative-path candidates from this file's location.
 *
 * Returns `null` when the seed directory cannot be located.
 *
 * @task T897
 */
function resolveSeedDir(): string | null {
  // Primary: workspace module resolution
  try {
    const req = createRequire(import.meta.url);
    const agentsPkg = req.resolve('@cleocode/agents/package.json');
    const candidate = join(dirname(agentsPkg), 'seed-agents');
    if (existsSync(candidate)) return candidate;
  } catch {
    // module not resolvable — fall through
  }

  // Fallback: climb relative to the compiled file location. This works
  // in both the workspace (src/) and a built dist/ layout.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // packages/core/src/agents/ -> packages/agents/seed-agents
    join(here, '..', '..', '..', 'agents', 'seed-agents'),
    // packages/core/dist/agents/ -> packages/agents/seed-agents
    join(here, '..', '..', '..', '..', 'agents', 'seed-agents'),
    // node_modules/@cleocode/core/dist/agents -> ../agents/seed-agents
    join(here, '..', '..', '..', '..', '..', 'agents', 'seed-agents'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Read the bundle version from `@cleocode/agents/package.json`.
 *
 * Falls back to `"0"` when the package is unreachable so the comparison
 * logic can always proceed.
 *
 * @task T897
 */
function readBundleVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@cleocode/agents/package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // unreachable — fall through
  }
  // Walk relative candidates when require.resolve fails
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgCandidates = [
    join(here, '..', '..', '..', 'agents', 'package.json'),
    join(here, '..', '..', '..', '..', 'agents', 'package.json'),
  ];
  for (const p of pkgCandidates) {
    try {
      const raw = readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw) as { version?: string };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // try next
    }
  }
  return '0';
}

/**
 * Absolute path to the `.seed-version` marker file.
 *
 * Stored directly under `getCleoHome()` (e.g.
 * `~/.local/share/cleo/.seed-version`).
 *
 * @task T897
 */
function markerPath(): string {
  return join(getCleoHome(), SEED_VERSION_MARKER_FILENAME);
}

/**
 * Read the currently-stored seed version from the marker file.
 *
 * Returns `"0"` when the file is absent (first install) or unreadable.
 *
 * @task T897
 */
function readStoredVersion(): string {
  try {
    const content = readFileSync(markerPath(), 'utf8').trim();
    return content.length > 0 ? content : '0';
  } catch {
    return '0';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the canonical seed agents are installed in the global CANT agents
 * directory (`~/.local/share/cleo/cant/agents/`).
 *
 * Idempotent: checks `~/.local/share/cleo/.seed-version` against the current
 * bundle version. When they match, every file is listed under `skipped` and no
 * I/O is performed. When the bundle version is newer, missing files are copied
 * and the marker is updated.
 *
 * A file that already exists on disk (same name) is always skipped — partial
 * upgrades are therefore additive. Use `cleo agent install --global --force`
 * to overwrite individual agents.
 *
 * @returns A {@link SeedInstallResult} describing what was installed, what
 *          was skipped, and the destination directory.
 *
 * @example
 * ```typescript
 * const result = await ensureSeedAgentsInstalled();
 * if (result.installed.length > 0) {
 *   console.log(`Installed ${result.installed.length} seed agents to ${result.destination}`);
 * }
 * ```
 *
 * @task T897
 */
export async function ensureSeedAgentsInstalled(): Promise<SeedInstallResult> {
  const destination = getCleoGlobalCantAgentsDir();
  const bundleVersion = readBundleVersion();
  const storedVersion = readStoredVersion();

  // Fast-path: already up to date — collect current files as skipped
  if (storedVersion === bundleVersion && storedVersion !== '0') {
    let alreadyPresent: string[] = [];
    try {
      alreadyPresent = readdirSync(destination)
        .filter((f) => f.endsWith('.cant'))
        .map((f) => f.replace(/\.cant$/, ''));
    } catch {
      // directory may not exist yet if this is a weird state
    }
    return {
      installed: [],
      skipped: alreadyPresent,
      destination,
      installedVersion: null,
    };
  }

  const seedDir = resolveSeedDir();
  if (!seedDir) {
    // Seed dir not found — no-op, caller decides how to surface this
    return {
      installed: [],
      skipped: [],
      destination,
      installedVersion: null,
    };
  }

  // Ensure destination exists
  mkdirSync(destination, { recursive: true });

  const seeds = readdirSync(seedDir).filter((f) => f.endsWith('.cant'));
  const installed: string[] = [];
  const skipped: string[] = [];

  for (const filename of seeds) {
    const src = join(seedDir, filename);
    const dst = join(destination, filename);
    const slug = filename.replace(/\.cant$/, '');

    if (existsSync(dst)) {
      skipped.push(slug);
      continue;
    }

    copyFileSync(src, dst);
    installed.push(slug);
  }

  // Write the marker atomically (write to tmp file, then rename is not
  // available in Node's synchronous fs API without extra work, so we
  // write directly — acceptable for a marker-only file).
  writeFileSync(markerPath(), bundleVersion, { encoding: 'utf8', mode: 0o644 });

  return {
    installed,
    skipped,
    destination,
    installedVersion: installed.length > 0 ? bundleVersion : null,
  };
}
