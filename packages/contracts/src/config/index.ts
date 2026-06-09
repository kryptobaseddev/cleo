/**
 * `@cleocode/contracts/config` — config-domain contract surface.
 *
 * Subpath barrel that surfaces the `ConfigManifest` contract (the
 * {@link ConfigManifestEntry} shape, its Zod validator
 * {@link configManifestEntrySchema}, and the built-in manifest entries) under a
 * stable, config-scoped import path. This is the AC3 surface for the
 * config-as-domain work (T11917): consumers that only need the manifest contract
 * import from `@cleocode/contracts/config` instead of pulling the full index.
 *
 * The types are also re-exported from the package root (`@cleocode/contracts`)
 * for backwards compatibility — this barrel is an additive, narrower entrypoint.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/config
 *
 * @task T11917 — config-as-domain (M5/AC3)
 * @task T9876 — ConfigManifest contract
 * @saga T9855
 */

export type {
  ConfigManifestEntry,
  ConfigManifestScope,
  ConfigScope,
  DriftDetection,
} from './manifest.js';
export {
  CLEO_CONFIG_MANIFEST,
  CONFIG_MANIFEST_ENTRIES,
  configManifestEntrySchema,
  GLOBAL_CLEO_CONFIG_MANIFEST,
  PROJECT_CONTEXT_MANIFEST,
  PROJECT_INFO_MANIFEST,
} from './manifest.js';
