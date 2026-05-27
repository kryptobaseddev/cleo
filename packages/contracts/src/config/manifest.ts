/**
 * ConfigManifest contract — declarative registry of every config-like file CLEO
 * reads, writes, or merges, with its scope, schema, merge precedence, and the
 * drift-detection strategy applied to it.
 *
 * Foundation for the CORE SSoT config registry (T9878) and the `resolveCleoConfig`
 * cascade resolver. Built-in entries cover the four canonical CLEO files:
 *
 * - `~/.cleo/config.json`          (`global`,   precedence 10)
 * - `<project>/.cleo/config.json`  (`project`,  precedence 20)
 * - `<project>/.cleo/project-info.json`    (`metadata`, separate channel)
 * - `<project>/.cleo/project-context.json` (`metadata`, separate channel)
 *
 * Merge semantics: higher `mergePrecedence` wins. The `metadata` scope is
 * intentionally OUTSIDE the project ↔ global merge chain — those files are
 * read-only consumer state and must NEVER be merged into resolved CleoConfig.
 *
 * @task T9876
 * @saga T9855
 * @adr 076
 */

import { type ZodTypeAny, z } from 'zod';

// ───────────────────────────────────────────────────────────────────────────
// Scope + drift unions
// ───────────────────────────────────────────────────────────────────────────

/**
 * Cascade-participating scopes for the project ↔ global merge chain.
 *
 * - `'global'`  — `~/.cleo/config.json`        (precedence 10)
 * - `'project'` — `<project>/.cleo/config.json` (precedence 20, higher wins)
 *
 * Note: `'metadata'` is NOT part of this union — metadata-scoped files are
 * read-only consumer state and live on a separate channel. See
 * {@link ConfigManifestScope} for the full union including metadata.
 *
 * @task T9876
 */
export type ConfigScope = 'global' | 'project';

/**
 * Full scope union covering cascade scopes AND the read-only `metadata`
 * channel used by `project-info.json` and `project-context.json`.
 *
 * Metadata-scoped entries are NEVER merged into the resolved CleoConfig —
 * they are surfaced separately as consumer state and validated only for
 * schema conformance / staleness.
 *
 * @task T9876
 */
export type ConfigManifestScope = ConfigScope | 'metadata';

/**
 * Drift-detection strategy applied to a manifest entry.
 *
 * - `'schema-validate'` — Re-parse the file's contents against {@link ConfigManifestEntry.schema}
 *   on read. Any parse error is reported as drift.
 * - `'staleness-gate'`  — Compare the file's `detectedAt` (or equivalent freshness key)
 *   against a freshness threshold. Stale files are flagged but not rejected.
 * - `'value-diff'`      — Diff the file's resolved values against the manifest's
 *   `defaults` baseline and report changed keys. Useful for invariant tracking.
 * - `'none'`            — No drift detection. Entry is informational-only.
 *
 * @task T9876
 */
export type DriftDetection = 'schema-validate' | 'staleness-gate' | 'value-diff' | 'none';

// ───────────────────────────────────────────────────────────────────────────
// Manifest entry shape
// ───────────────────────────────────────────────────────────────────────────

/**
 * A single registry entry describing one config-like file CLEO is aware of.
 *
 * `mergePrecedence` orders entries within the SAME scope channel. Across
 * channels, the cascade-resolver consumes entries with `scope` in
 * {@link ConfigScope} (global/project) and merges by ascending precedence
 * (higher wins). Metadata entries are surfaced separately.
 *
 * @task T9876
 */
export interface ConfigManifestEntry {
  /** Stable identifier for the entry (e.g. `'cleo-config-project'`). */
  id: string;
  /** Where the file lives in the precedence hierarchy. */
  scope: ConfigManifestScope;
  /** Absolute or `~`-rooted path to the file on disk. */
  path: string;
  /**
   * Optional Zod schema used by the `'schema-validate'` drift detector to
   * re-parse the file's contents. `null` disables schema validation even when
   * `driftDetection === 'schema-validate'` (advisory-only mode).
   */
  schema?: ZodTypeAny | null;
  /**
   * Numeric merge precedence within the cascade. Higher wins.
   *
   * Canonical values:
   * - `0`  — defaults / metadata (NOT part of the merge chain)
   * - `10` — global
   * - `20` — project
   */
  mergePrecedence: number;
  /** Drift-detection strategy to apply to this entry. */
  driftDetection: DriftDetection;
  /** Optional default values used as the baseline for `'value-diff'` drift detection. */
  defaults?: Record<string, unknown>;
}

// ───────────────────────────────────────────────────────────────────────────
// Built-in manifest entries (4 canonical CLEO files)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Manifest entry for `<project>/.cleo/project-info.json`.
 *
 * Metadata channel (NOT part of the merge cascade). Schema-validated on
 * read because the file is consumer state with a stable shape.
 *
 * @task T9876
 */
export const PROJECT_INFO_MANIFEST: ConfigManifestEntry = {
  id: 'project-info',
  scope: 'metadata',
  path: '.cleo/project-info.json',
  mergePrecedence: 0,
  driftDetection: 'schema-validate',
};

/**
 * Manifest entry for `<project>/.cleo/project-context.json`.
 *
 * Metadata channel. Staleness-gated because the file is regenerated by
 * project-detection scans and consumers care about freshness, not exact shape.
 *
 * @task T9876
 */
export const PROJECT_CONTEXT_MANIFEST: ConfigManifestEntry = {
  id: 'project-context',
  scope: 'metadata',
  path: '.cleo/project-context.json',
  mergePrecedence: 0,
  driftDetection: 'staleness-gate',
};

/**
 * Manifest entry for `<project>/.cleo/config.json` (project-scoped CleoConfig).
 *
 * Project scope; precedence 20 — wins over global. Schema-validated.
 *
 * @task T9876
 */
export const CLEO_CONFIG_MANIFEST: ConfigManifestEntry = {
  id: 'cleo-config-project',
  scope: 'project',
  path: '.cleo/config.json',
  mergePrecedence: 20,
  driftDetection: 'schema-validate',
};

/**
 * Manifest entry for `~/.cleo/config.json` (global CleoConfig).
 *
 * Global scope; precedence 10 — loses to project. Schema-validated.
 *
 * @task T9876
 */
export const GLOBAL_CLEO_CONFIG_MANIFEST: ConfigManifestEntry = {
  id: 'cleo-config-global',
  scope: 'global',
  path: '~/.cleo/config.json',
  mergePrecedence: 10,
  driftDetection: 'schema-validate',
};

/**
 * Frozen registry of all built-in manifest entries shipped with the contracts
 * package. Order is informational only — consumers MUST sort by
 * `mergePrecedence` when applying the cascade.
 *
 * @task T9876
 */
export const CONFIG_MANIFEST_ENTRIES: readonly ConfigManifestEntry[] = Object.freeze([
  PROJECT_INFO_MANIFEST,
  PROJECT_CONTEXT_MANIFEST,
  GLOBAL_CLEO_CONFIG_MANIFEST,
  CLEO_CONFIG_MANIFEST,
]);

// ───────────────────────────────────────────────────────────────────────────
// Runtime validation schema
// ───────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for {@link ConfigManifestEntry}.
 *
 * Treats `schema` as `unknown` because `ZodTypeAny` instances cannot be
 * validated through Zod itself without infinite recursion — schema-shape
 * checking is the responsibility of the consumer that constructs the entry.
 *
 * @task T9876
 */
export const configManifestEntrySchema = z.object({
  id: z.string().min(1),
  scope: z.union([z.literal('global'), z.literal('project'), z.literal('metadata')]),
  path: z.string().min(1),
  schema: z.unknown().optional(),
  mergePrecedence: z.number().int().nonnegative(),
  driftDetection: z.union([
    z.literal('schema-validate'),
    z.literal('staleness-gate'),
    z.literal('value-diff'),
    z.literal('none'),
  ]),
  defaults: z.record(z.string(), z.unknown()).optional(),
});
