/**
 * SSoT config registry — `resolveCleoConfig` cascade resolver implementing the
 * ConfigManifest contract from `@cleocode/contracts`.
 *
 * Precedence chain (higher wins):
 * - `0`  — defaults / metadata baseline (NOT part of the merge chain)
 * - `10` — `~/.cleo/config.json` (global)
 * - `20` — `<projectRoot>/.cleo/config.json` (project)
 *
 * Metadata files (`project-info.json`, `project-context.json`) live on a
 * separate channel and are surfaced through dedicated loaders — they are NEVER
 * merged into the resolved CleoConfig.
 *
 * This module is pure JSON file IO. It does NOT open SQLite — the
 * `DB Open Guard` SSoT contract (ADR-068) is preserved.
 *
 * Path resolution is delegated to `@cleocode/paths` (`getCleoHome`) per the
 * Paths SSoT (T9802) — XDG / env-paths logic is NEVER hand-rolled here.
 *
 * @task T9878
 * @saga T9855
 * @adr 076
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CLEO_CONFIG_MANIFEST,
  CONFIG_MANIFEST_ENTRIES,
  type ConfigManifestEntry,
  GLOBAL_CLEO_CONFIG_MANIFEST,
  PROJECT_CONTEXT_MANIFEST,
  PROJECT_INFO_MANIFEST,
} from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import { atomicWriteJson } from '../store/atomic.js';

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

/**
 * Merged JSON shape of `.cleo/config.json`.
 *
 * Intentionally generic — the cascade resolver operates structurally and
 * defers shape interpretation to the consumer. For typed reads, layer a Zod
 * schema on top via {@link validateConfig} or the manifest's `schema` field.
 *
 * @public
 */
export type MergedConfig = { [key: string]: unknown };

/**
 * Read-only metadata channel for `.cleo/project-info.json`.
 *
 * @public
 */
export type ProjectInfo = Record<string, unknown>;

/**
 * Read-only metadata channel for `.cleo/project-context.json`.
 *
 * @public
 */
export type ProjectContext = Record<string, unknown>;

/**
 * Scope selector for {@link resolveCleoConfig} and {@link getConfigValue}.
 *
 * - `'global'`  — return ONLY the global file's contents (or `{}` if missing)
 * - `'project'` — return ONLY the project file's contents (or `{}` if missing)
 * - `'merged'`  — return the deep-merge of `{ ...defaults, ...global, ...project }`
 *
 * @public
 */
export type ResolveScope = 'global' | 'project' | 'merged';

/**
 * Scope selector for {@link validateConfig}.
 *
 * @public
 */
export type ValidateScope = 'global' | 'project';

/**
 * Scope selector for {@link checkDrift}.
 *
 * The `'metadata'` value runs drift checks against the two metadata-channel
 * entries (`project-info`, `project-context`) and aggregates the worst case.
 *
 * @public
 */
export type DriftScope = 'global' | 'project' | 'metadata';

/**
 * Result of {@link validateConfig}.
 *
 * @public
 */
export interface ValidateResult {
  /** `true` IFF every gate passed (or no schema was configured). */
  ok: boolean;
  /** Human-readable issues. Empty when `ok === true`. */
  issues: string[];
}

/**
 * Result of {@link checkDrift}.
 *
 * @public
 */
export interface DriftResult {
  /** `true` IFF drift was detected. */
  drift: boolean;
  /** Optional human-readable reason for the drift verdict. */
  reason?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Internal: path resolution + IO
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resolve the absolute path to the global `.cleo/config.json` (XDG canonical).
 */
function resolveGlobalConfigPath(): string {
  return join(getCleoHome(), 'config.json');
}

/**
 * Resolve the absolute path to a project-scoped `.cleo/<file>`.
 */
function resolveProjectFilePath(projectRoot: string, fileName: string): string {
  return join(projectRoot, '.cleo', fileName);
}

/**
 * Read a JSON file and parse it.
 *
 * Returns `null` IFF the file does not exist (ENOENT). All other IO errors
 * propagate. Malformed JSON throws an `Error` whose message embeds the file
 * path so the caller can pinpoint the source.
 */
async function readJsonOrNull(path: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid JSON in ${path}: expected an object at top level`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${path}: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Narrow an unknown thrown value to NodeJS.ErrnoException.
 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

/**
 * Deep-merge `overlay` into `base` at every key path.
 *
 * Plain objects are merged recursively; arrays and primitives are replaced
 * wholesale by the overlay. Cloning is done via `structuredClone` to ensure
 * the inputs are never mutated.
 */
function deepMergeObjects(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(base);
  for (const [key, overlayVal] of Object.entries(overlay)) {
    const baseVal = out[key];
    if (isPlainObject(baseVal) && isPlainObject(overlayVal)) {
      out[key] = deepMergeObjects(baseVal, overlayVal);
    } else {
      out[key] = structuredClone(overlayVal);
    }
  }
  return out;
}

/**
 * Tight type-guard for "plain object" — excludes arrays and null.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Resolve a `.`-separated key path against a plain object.
 */
function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  if (key === '') return obj;
  const segments = key.split('.');
  let cursor: unknown = obj;
  for (const seg of segments) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[seg];
  }
  return cursor;
}

// ───────────────────────────────────────────────────────────────────────────
// Public API — resolveCleoConfig + metadata loaders
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resolve the CleoConfig cascade for a project.
 *
 * Precedence (higher wins): defaults (0) → global (10) → project (20).
 *
 * @param opts.scope - Which cascade slice to return. `'merged'` applies the
 *   full precedence chain; `'global'` and `'project'` return their respective
 *   files unmodified (or `{}` when missing).
 * @param opts.projectRoot - Absolute path to the project root (the directory
 *   containing `.cleo/`).
 * @returns A merged `MergedConfig` for `'merged'` scope, or the raw file
 *   contents for `'global'` / `'project'` scopes.
 * @throws When a present file contains malformed JSON; missing files are
 *   silently treated as `{}`.
 *
 * @example
 * ```typescript
 * const cfg = await resolveCleoConfig({ scope: 'merged', projectRoot: '/my/proj' });
 * ```
 *
 * @public
 */
export async function resolveCleoConfig(opts: {
  scope: ResolveScope;
  projectRoot: string;
}): Promise<MergedConfig> {
  const { scope, projectRoot } = opts;

  if (scope === 'global') {
    return (await readJsonOrNull(resolveGlobalConfigPath())) ?? {};
  }
  if (scope === 'project') {
    return (
      (await readJsonOrNull(
        resolveProjectFilePath(projectRoot, CLEO_CONFIG_MANIFEST.path.replace('.cleo/', '')),
      )) ?? {}
    );
  }

  // scope === 'merged' — apply the cascade in ascending precedence order.
  const sorted = [...CONFIG_MANIFEST_ENTRIES]
    .filter((e) => e.scope === 'global' || e.scope === 'project')
    .sort((a, b) => a.mergePrecedence - b.mergePrecedence);

  let merged: Record<string, unknown> = {};
  for (const entry of sorted) {
    const fileContents = await loadEntryFile(entry, projectRoot);
    if (fileContents !== null) {
      merged = deepMergeObjects(merged, fileContents);
    }
  }
  return merged;
}

/**
 * Resolve and read a single manifest entry's underlying file.
 *
 * Returns `null` for missing files. Path resolution honours the entry's
 * scope: `'global'` uses `getCleoHome()`; `'project'` and `'metadata'` are
 * relative to the project root's `.cleo/` directory.
 */
async function loadEntryFile(
  entry: ConfigManifestEntry,
  projectRoot: string,
): Promise<Record<string, unknown> | null> {
  if (entry.scope === 'global') {
    return readJsonOrNull(resolveGlobalConfigPath());
  }
  const fileName = entry.path.replace(/^\.cleo\//, '');
  return readJsonOrNull(resolveProjectFilePath(projectRoot, fileName));
}

/**
 * Load `<projectRoot>/.cleo/project-info.json`.
 *
 * Metadata channel — NEVER merged into the cascade. Returns `null` when the
 * file is absent.
 *
 * @public
 */
export async function loadProjectInfo(projectRoot: string): Promise<ProjectInfo | null> {
  const fileName = PROJECT_INFO_MANIFEST.path.replace(/^\.cleo\//, '');
  return readJsonOrNull(resolveProjectFilePath(projectRoot, fileName));
}

/**
 * Load `<projectRoot>/.cleo/project-context.json`.
 *
 * Metadata channel — NEVER merged into the cascade. Returns `null` when the
 * file is absent.
 *
 * @public
 */
export async function loadProjectContext(projectRoot: string): Promise<ProjectContext | null> {
  const fileName = PROJECT_CONTEXT_MANIFEST.path.replace(/^\.cleo\//, '');
  return readJsonOrNull(resolveProjectFilePath(projectRoot, fileName));
}

// ───────────────────────────────────────────────────────────────────────────
// Lookup helpers — getConfigValue, validateConfig, checkDrift
// ───────────────────────────────────────────────────────────────────────────

/**
 * Read a single value out of the resolved cascade by `.`-separated key path.
 *
 * @param key - Dot-separated key (e.g. `'release.branchModel'`).
 * @param opts.scope - Cascade slice to read from. Defaults to `'merged'`.
 * @param opts.projectRoot - Absolute path to the project root.
 * @returns The resolved value, or `undefined` when the key is absent.
 *
 * @public
 */
export async function getConfigValue<T = unknown>(
  key: string,
  opts: { scope?: ResolveScope; projectRoot: string },
): Promise<T | undefined> {
  const scope = opts.scope ?? 'merged';
  const resolved = await resolveCleoConfig({ scope, projectRoot: opts.projectRoot });
  return getNestedValue(resolved, key) as T | undefined;
}

/**
 * Flatten a resolved config object into its dot-notation leaf keys.
 *
 * Recurses into plain objects; arrays and primitives are treated as leaf
 * values. Used by `config.list` to surface a discoverable, copy-pasteable key
 * list alongside the full resolved object.
 *
 * @param obj - A resolved config object (e.g. from {@link resolveCleoConfig}).
 * @returns Sorted dot-notation key paths to every leaf value.
 *
 * @example
 * ```typescript
 * flattenConfigKeys({ a: { b: 1 }, c: [2] }); // → ['a.b', 'c']
 * ```
 *
 * @public
 */
export function flattenConfigKeys(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isPlainObject(value) && Object.keys(value).length > 0) {
        walk(value, path);
      } else {
        out.push(path);
      }
    }
  };
  walk(obj, '');
  return out.sort();
}

/**
 * Result of {@link unsetConfigValue}.
 *
 * @public
 */
export interface UnsetResult {
  /** The dot-notation key that was targeted. */
  key: string;
  /** Scope the key was removed from. */
  scope: 'project' | 'global';
  /** `true` IFF a value was actually deleted (idempotent: `false` when absent). */
  removed: boolean;
}

/**
 * Remove a single `.`-separated key from a scoped config file and persist the
 * result. Pure JSON file IO — does NOT open SQLite (ADR-068 preserved).
 *
 * Idempotent: when the key is already absent the file is left untouched and
 * `{ removed: false }` is returned. When the key exists it is deleted (pruning
 * the now-empty parent objects is intentionally NOT done — operators may rely on
 * a present-but-empty namespace), the file is rewritten, and `{ removed: true }`
 * is returned.
 *
 * @param key - Dot-separated key to remove (e.g. `'release.branchModel'`).
 * @param opts.projectRoot - Absolute path to the project root.
 * @param opts.global - When `true`, target the global `~/.cleo/config.json`
 *   instead of the project file.
 * @returns The {@link UnsetResult} describing the outcome.
 * @throws When the present file contains malformed JSON.
 *
 * @public
 */
export async function unsetConfigValue(
  key: string,
  opts: { projectRoot: string; global?: boolean },
): Promise<UnsetResult> {
  const scope: 'project' | 'global' = opts.global ? 'global' : 'project';
  const configPath = opts.global
    ? resolveGlobalConfigPath()
    : resolveProjectFilePath(opts.projectRoot, CLEO_CONFIG_MANIFEST.path.replace(/^\.cleo\//, ''));

  const existing = await readJsonOrNull(configPath);
  if (existing === null) {
    return { key, scope, removed: false };
  }

  const removed = deleteNestedValue(existing, key);
  if (!removed) {
    return { key, scope, removed: false };
  }

  await atomicWriteJson(configPath, existing);
  return { key, scope, removed: true };
}

/**
 * Delete a `.`-separated key from a plain object in place.
 *
 * Returns `true` IFF the key existed and was deleted. Traverses only through
 * plain-object segments — a non-object intermediate means the key is absent.
 */
function deleteNestedValue(obj: Record<string, unknown>, key: string): boolean {
  const segments = key.split('.');
  const lastSegment = segments.pop();
  if (lastSegment === undefined) return false;
  let cursor: Record<string, unknown> = obj;
  for (const seg of segments) {
    const next = cursor[seg];
    if (!isPlainObject(next)) return false;
    cursor = next;
  }
  if (!(lastSegment in cursor)) return false;
  delete cursor[lastSegment];
  return true;
}

/**
 * Validate a scoped config file against its manifest entry's `schema`.
 *
 * When the entry has no schema attached (`schema === null` or `undefined`),
 * validation is a no-op and `{ ok: true, issues: [] }` is returned.
 *
 * @public
 */
export async function validateConfig(
  scope: ValidateScope,
  projectRoot: string,
): Promise<ValidateResult> {
  const entry = scope === 'global' ? GLOBAL_CLEO_CONFIG_MANIFEST : CLEO_CONFIG_MANIFEST;
  return validateEntry(entry, projectRoot);
}

/**
 * Validate a single manifest entry against its schema (if any).
 */
async function validateEntry(
  entry: ConfigManifestEntry,
  projectRoot: string,
): Promise<ValidateResult> {
  const contents = await loadEntryFile(entry, projectRoot);
  if (contents === null) {
    // Missing files are validation no-ops — schema cannot reject a non-existent file.
    return { ok: true, issues: [] };
  }
  if (entry.schema == null) {
    return { ok: true, issues: [] };
  }
  const parseResult = entry.schema.safeParse(contents);
  if (parseResult.success) {
    return { ok: true, issues: [] };
  }
  const issues = parseResult.error.issues.map(
    (i) => `${i.path.length ? i.path.join('.') : '<root>'}: ${i.message}`,
  );
  return { ok: false, issues };
}

/**
 * Staleness threshold for `project-context.json` (30 days, in ms).
 */
const PROJECT_CONTEXT_STALENESS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Apply the manifest's drift-detection strategy to a scoped file.
 *
 * - `'global'` / `'project'` — runs the configured strategy against the
 *   matching cascade entry.
 * - `'metadata'` — runs strategies for BOTH metadata entries and returns the
 *   first drift hit (worst-case semantics).
 *
 * Strategy map:
 * - `'schema-validate'` → delegate to {@link validateConfig}
 * - `'staleness-gate'`  → compare `detectedAt` against
 *   {@link PROJECT_CONTEXT_STALENESS_MS}
 * - `'value-diff'`      → noop for now; returns `{ drift: false }`
 * - `'none'`            → noop; returns `{ drift: false }`
 *
 * @public
 */
export async function checkDrift(scope: DriftScope, projectRoot: string): Promise<DriftResult> {
  if (scope === 'metadata') {
    for (const entry of [PROJECT_INFO_MANIFEST, PROJECT_CONTEXT_MANIFEST]) {
      const result = await checkEntryDrift(entry, projectRoot);
      if (result.drift) return result;
    }
    return { drift: false };
  }
  const entry = scope === 'global' ? GLOBAL_CLEO_CONFIG_MANIFEST : CLEO_CONFIG_MANIFEST;
  return checkEntryDrift(entry, projectRoot);
}

/**
 * Apply one manifest entry's drift strategy. Internal.
 */
async function checkEntryDrift(
  entry: ConfigManifestEntry,
  projectRoot: string,
): Promise<DriftResult> {
  switch (entry.driftDetection) {
    case 'schema-validate': {
      const result = await validateEntry(entry, projectRoot);
      if (result.ok) return { drift: false };
      return { drift: true, reason: `schema-validate failed: ${result.issues.join('; ')}` };
    }
    case 'staleness-gate': {
      const contents = await loadEntryFile(entry, projectRoot);
      if (contents === null) {
        // Missing metadata file is not drift; consumers decide whether to scan.
        return { drift: false };
      }
      const detectedAtRaw = contents['detectedAt'];
      if (typeof detectedAtRaw !== 'string') {
        return { drift: true, reason: 'staleness-gate: missing or non-string detectedAt' };
      }
      const detectedAt = Date.parse(detectedAtRaw);
      if (Number.isNaN(detectedAt)) {
        return { drift: true, reason: `staleness-gate: unparseable detectedAt=${detectedAtRaw}` };
      }
      const ageMs = Date.now() - detectedAt;
      if (ageMs > PROJECT_CONTEXT_STALENESS_MS) {
        const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        return {
          drift: true,
          reason: `staleness-gate: detectedAt is ${days}d old (>30d threshold)`,
        };
      }
      return { drift: false };
    }
    case 'value-diff':
      // Reserved for future invariant tracking — see ConfigManifestEntry.defaults.
      return { drift: false };
    case 'none':
      return { drift: false };
  }
}
