/**
 * The hooks-v1 release gate (T13557, owner decision 2026-10-11).
 *
 * Project hooks (#2008, #2013) stay inert on a stable build until the hooks-v1
 * stable promotion: activation is refused and existing receipts are not
 * executed. The gate opens from RELEASE METADATA, never a source edit, so the
 * pilot's source digest (scripts/hook-pilot-evidence.mjs) stays valid:
 *
 * - a canary build (`-canary.N` version) runs hooks, for the pilot;
 * - the hooks-v1 promotion release stamps `cleo.releasedFeatures: ["hooks-v1"]`
 *   into the published manifests (scripts/mark-hotfix-release.mjs), which the
 *   digest normalizes out;
 * - after promotion, remove `hooks-v1` from {@link UNRELEASED_HOOK_FEATURES}
 *   in an ordinary PR before the next stable release, which no longer stamps it.
 *
 * Lightweight on purpose: the hook hot path must not load the store (the sync
 * flags module pulls in sqlite and the schema machinery).
 *
 * @task T13557
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A gated hook feature. */
export type HookFeature = 'hooks-v1';

/** Hook features not released on stable builds; remove one after its promotion. */
export const UNRELEASED_HOOK_FEATURES: ReadonlySet<HookFeature> = new Set(['hooks-v1']);

/** The error code of a refused activation. */
export const E_HOOKS_V1_UNRELEASED = 'E_HOOKS_V1_UNRELEASED';

/** The diagnostic and outcome code while hooks-v1 is unreleased. */
export const HOOKS_V1_UNRELEASED = 'HOOKS_V1_UNRELEASED';

/** Activation refused because this build has not released hooks-v1. */
export class HooksV1UnreleasedError extends Error {
  /** {@link E_HOOKS_V1_UNRELEASED}. */
  readonly code = E_HOOKS_V1_UNRELEASED;
  constructor() {
    super(
      'Project hooks (hooks-v1) are not released on this build: activation is refused and existing receipts are not executed. Use a canary build for the pilot, or wait for the hooks-v1 stable promotion.',
    );
    this.name = 'HooksV1UnreleasedError';
  }
}

/** The release metadata of this build's `@cleocode/core` manifest. */
export interface HookReleaseManifest {
  /** The package name (`@cleocode/core` when the build layout resolves correctly). */
  readonly name?: string;
  /** The package version. */
  readonly version?: string;
  /** CLEO release metadata stamped at publish time. */
  readonly cleo?: { readonly releasedFeatures?: readonly string[] };
}

/** Options of {@link hooksV1Released}. */
export interface HooksV1ReleaseOptions {
  /** Opt in regardless of the build (tests, the canary harness). */
  readonly allowUnreleased?: boolean;
  /** The manifest to judge; test seam. @defaultValue this build's `@cleocode/core` manifest */
  readonly manifest?: HookReleaseManifest;
  /** The unreleased set; test seam. @defaultValue UNRELEASED_HOOK_FEATURES */
  readonly unreleased?: ReadonlySet<HookFeature>;
}

let cached: HookReleaseManifest | undefined;

/**
 * This build's `@cleocode/core` manifest: src and dist both sit two levels
 * below it. A layout change that resolved another manifest would keep the gate
 * closed (fail safe); a test pins the name.
 *
 * @returns The manifest, or `{}` when it cannot be read.
 */
export function hookReleaseManifest(): HookReleaseManifest {
  if (cached) return cached;
  try {
    const path = fileURLToPath(new URL('../../package.json', import.meta.url));
    cached = JSON.parse(readFileSync(path, 'utf8')) as HookReleaseManifest;
  } catch {
    // An unreadable manifest is a stable build: the gate stays closed.
    cached = {};
  }
  return cached;
}

/**
 * Whether hooks-v1 may activate and execute on this build: released in
 * source, stamped released by the promotion, a canary build, or opted in.
 *
 * @param opts - Opt-in and test seams.
 * @returns `true` when project hooks may run.
 */
export function hooksV1Released(opts: HooksV1ReleaseOptions = {}): boolean {
  if (!(opts.unreleased ?? UNRELEASED_HOOK_FEATURES).has('hooks-v1')) return true;
  if (opts.allowUnreleased === true) return true;
  const manifest = opts.manifest ?? hookReleaseManifest();
  if (/-canary\.\d+$/.test(manifest.version ?? '')) return true;
  return manifest.cleo?.releasedFeatures?.includes('hooks-v1') === true;
}
