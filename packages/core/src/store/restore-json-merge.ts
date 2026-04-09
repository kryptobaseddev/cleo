/**
 * A/B regenerate-and-compare engine for JSON file restore.
 *
 * Classifies each field of the three managed CLEO JSON config files into one
 * of five categories (identical, machine-local, user-intent, project-identity,
 * auto-detect, unknown) and resolves conflicts deterministically per ADR-038 §10
 * and T311 spec §6.
 *
 * PURE MODULE — no I/O, no global state, no disk writes. All output is returned
 * as a {@link JsonRestoreReport} for the caller (T357) to format and persist.
 *
 * @task T354
 * @epic T311
 * @why ADR-038 §10 — intelligent A/B regenerate-and-compare for restore.
 *      Classifies each field of imported JSON files into 4 categories
 *      (machine-local, user-intent, project-identity, auto-detect, unknown)
 *      and resolves conflicts deterministically.
 * @what Pure classification engine. Reads regenerated A from regenerators.ts,
 *       imported B from caller, returns a JsonRestoreReport for T357 to format.
 * @see packages/contracts/src/backup-manifest.ts
 * @see packages/core/src/store/regenerators.ts
 * @module restore-json-merge
 */

import {
  regenerateConfigJson,
  regenerateProjectContextJson,
  regenerateProjectInfoJson,
} from './regenerators.js';

// ============================================================================
// Public types
// ============================================================================

/**
 * The three JSON filenames managed by the restore engine.
 *
 * Each filename maps to a distinct classification ruleset (spec §6.3).
 *
 * @task T354
 * @epic T311
 */
export type FilenameForRestore = 'config.json' | 'project-info.json' | 'project-context.json';

/**
 * Five-way field category taxonomy per T311 spec §6.3 / ADR-038 §10.
 *
 * - `identical`         — A and B are byte-equal (JSON.stringify match); no conflict.
 * - `machine-local`     — field is expected to differ between machines; keep A.
 * - `user-intent`       — field represents user-applied config in config.json; keep B.
 * - `project-identity`  — field identifies the project in project-info.json; keep B.
 * - `auto-detect`       — field is auto-detected from the local environment; keep A.
 * - `unknown`           — no classification rule matched; flag for manual review.
 *
 * @task T354
 * @epic T311
 */
export type FieldCategory =
  | 'identical'
  | 'machine-local'
  | 'user-intent'
  | 'project-identity'
  | 'auto-detect'
  | 'unknown';

/**
 * Resolution applied to a field when building the merged output.
 *
 * - `A`             — use the locally regenerated value.
 * - `B`             — use the imported value.
 * - `manual-review` — no safe auto-resolution; local value (A) is kept as a
 *                     safe default pending operator review.
 *
 * @task T354
 * @epic T311
 */
export type Resolution = 'A' | 'B' | 'manual-review';

/**
 * Classification and resolution for a single leaf field in the comparison.
 *
 * Produced by {@link regenerateAndCompare} for every leaf path encountered
 * during the recursive walk of both objects.
 *
 * @task T354
 * @epic T311
 */
export interface FieldClassification {
  /** JSON dot-path of the field, e.g. "brain.embeddingProvider" or "testing.framework". */
  path: string;
  /** Value from locally regenerated content (A). `undefined` when absent in A. */
  local: unknown;
  /** Value from the imported bundle (B). `undefined` when absent in B. */
  imported: unknown;
  /**
   * Taxonomy category per spec §6.3 classification rules.
   * `identical` means `JSON.stringify(A) === JSON.stringify(B)` — no conflict.
   */
  category: FieldCategory;
  /**
   * The resolution applied (or to be applied) to disk.
   * `A` = use local value; `B` = use imported value;
   * `manual-review` = operator must decide.
   */
  resolution: Resolution;
  /** Human-readable explanation for the resolution. */
  rationale: string;
}

/**
 * Complete A/B comparison result for one JSON file.
 *
 * Returned by {@link regenerateAndCompare}. Caller persists `applied` to disk
 * and writes the full report to `.cleo/restore-conflicts.md`.
 *
 * @task T354
 * @epic T311
 */
export interface JsonRestoreReport {
  /** Which file was compared. */
  filename: FilenameForRestore;
  /** The locally regenerated object (A). */
  localGenerated: unknown;
  /** The imported object (B). */
  imported: unknown;
  /**
   * Per-field classification results.
   * All leaf fields — including identical ones — are listed here.
   */
  classifications: FieldClassification[];
  /** The final merged object produced by applying all resolutions. */
  applied: unknown;
  /**
   * Count of fields with `resolution === 'manual-review'`.
   * Equals the number of `unknown`-category classifications.
   */
  conflictCount: number;
}

/**
 * Input to {@link regenerateAndCompare}.
 *
 * The caller supplies the imported content (B) and the locally regenerated
 * content (A). The engine classifies and resolves each field.
 *
 * @task T354
 * @epic T311
 */
export interface RegenerateAndCompareInput {
  /** Which of the three managed JSON files is being compared. */
  filename: FilenameForRestore;
  /** Parsed content of the imported file (B — from bundle json/ directory). */
  imported: unknown;
  /**
   * Locally regenerated content (A).
   *
   * When provided, the engine uses this value directly as the A side.
   * When omitted (or when `filename` is provided with a `projectRoot`),
   * the engine calls the appropriate generator from regenerators.ts.
   *
   * Providing this field allows callers to pass a pre-computed A — useful
   * in tests and in the CLI import command to avoid redundant regeneration.
   */
  localGenerated: unknown;
}

// ============================================================================
// Classification pattern tables
// ============================================================================

/**
 * Field-path prefixes and exact paths that identify machine-local fields.
 *
 * Applies to ALL three files. Resolution: A (keep local).
 *
 * Spec §6.3 table row: "Machine-local — all three files".
 */
const MACHINE_LOCAL_PATTERNS: readonly string[] = [
  'projectRoot',
  'machineKey',
  'machineFingerprint',
  'hostname',
  'cwd',
  'createdAt',
  'detectedAt',
  'lastUpdated',
  'projectId',
  'projectHash',
];

/**
 * Field-path prefixes and exact paths that identify user-intent fields.
 *
 * Applies ONLY to `config.json`. Resolution: B (keep imported).
 *
 * Spec §6.3 table row: "User intent — config.json only".
 */
const USER_INTENT_PATTERNS_CONFIG: readonly string[] = [
  'enabledFeatures',
  'brain',
  'hooks',
  'tools',
  'contributor',
];

/**
 * Field-path prefixes and exact paths that identify project-identity fields.
 *
 * Applies ONLY to `project-info.json`. Resolution: B (keep imported).
 *
 * Spec §6.3 table row: "Project identity — project-info.json only".
 */
const PROJECT_IDENTITY_PATTERNS: readonly string[] = [
  'name',
  'description',
  'type',
  'primaryType',
  'tags',
  'labels',
];

/**
 * Field-path prefixes and exact paths that identify auto-detect fields.
 *
 * Applies ONLY to `project-context.json`. Resolution: A (local detection preferred).
 *
 * Spec §6.3 table row: "Auto-detect — project-context.json only".
 */
const AUTO_DETECT_PATTERNS_CONTEXT: readonly string[] = [
  'testing',
  'build',
  'directories',
  'conventions',
  'llmHints',
  'projectTypes',
  'monorepo',
  'schemaVersion',
];

// ============================================================================
// Path-matching helpers
// ============================================================================

/**
 * Returns `true` when `fieldPath` is an exact match for, or starts with a
 * dot-separated prefix of, any pattern in `patterns`.
 *
 * Examples:
 *   - matchesPattern('brain.embeddingProvider', ['brain']) → true
 *   - matchesPattern('brain', ['brain']) → true
 *   - matchesPattern('brainX', ['brain']) → false (not a prefix boundary)
 *
 * @param fieldPath - Dot-separated path to test.
 * @param patterns  - List of exact or prefix patterns.
 * @returns `true` when `fieldPath` matches any pattern.
 */
function matchesPattern(fieldPath: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (fieldPath === pattern || fieldPath.startsWith(`${pattern}.`)) {
      return true;
    }
  }
  return false;
}

/**
 * Heuristic: returns `true` when `value` is a string that looks like an
 * absolute filesystem path (Unix `/…` or Windows `C:\…`).
 *
 * Spec §6.3: "any string value that is an absolute filesystem path" is
 * classified as machine-local.
 *
 * @param value - Candidate value to inspect.
 * @returns `true` when `value` is an absolute-path string.
 */
function isAbsolutePathString(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // Unix absolute: starts with /
  if (value.startsWith('/')) return true;
  // Windows absolute: drive letter + colon + backslash or forward-slash
  return /^[A-Za-z]:[/\\]/.test(value);
}

// ============================================================================
// Core classification logic
// ============================================================================

/**
 * Classifies a single leaf field and determines its resolution.
 *
 * Applies the precedence order from spec §6.3:
 *   identical > machine-local > user-intent > project-identity > auto-detect > unknown
 *
 * @param filename     - Which JSON file the field belongs to.
 * @param path         - Dot-notation path, e.g. "brain.embeddingProvider".
 * @param localValue   - Value from locally regenerated content (A).
 * @param importedValue - Value from imported bundle (B).
 * @returns A complete {@link FieldClassification} for the field.
 */
function classifyField(
  filename: FilenameForRestore,
  path: string,
  localValue: unknown,
  importedValue: unknown,
): FieldClassification {
  // 1. Identical — highest precedence.
  if (JSON.stringify(localValue) === JSON.stringify(importedValue)) {
    return {
      path,
      local: localValue,
      imported: importedValue,
      category: 'identical',
      resolution: 'A',
      rationale: 'values are identical — no merge required',
    };
  }

  // 2. Machine-local — applies to all files; path-pattern OR absolute-path heuristic.
  if (
    matchesPattern(path, MACHINE_LOCAL_PATTERNS) ||
    isAbsolutePathString(localValue) ||
    isAbsolutePathString(importedValue)
  ) {
    return {
      path,
      local: localValue,
      imported: importedValue,
      category: 'machine-local',
      resolution: 'A',
      rationale: 'machine-local field — expected to differ between machines; keeping local value',
    };
  }

  // 3. User-intent — config.json only.
  if (filename === 'config.json' && matchesPattern(path, USER_INTENT_PATTERNS_CONFIG)) {
    return {
      path,
      local: localValue,
      imported: importedValue,
      category: 'user-intent',
      resolution: 'B',
      rationale: 'user intent field in config.json — preserving imported value from source',
    };
  }

  // 4. Project-identity — project-info.json only.
  if (filename === 'project-info.json' && matchesPattern(path, PROJECT_IDENTITY_PATTERNS)) {
    return {
      path,
      local: localValue,
      imported: importedValue,
      category: 'project-identity',
      resolution: 'B',
      rationale: 'project identity field — preserving imported value from source',
    };
  }

  // 5. Auto-detect — project-context.json only.
  if (filename === 'project-context.json' && matchesPattern(path, AUTO_DETECT_PATTERNS_CONTEXT)) {
    return {
      path,
      local: localValue,
      imported: importedValue,
      category: 'auto-detect',
      resolution: 'A',
      rationale:
        'auto-detect field in project-context.json — local detection is always preferred over a potentially stale import',
    };
  }

  // 6. Unknown — no rule matched; flag for manual review.
  return {
    path,
    local: localValue,
    imported: importedValue,
    category: 'unknown',
    resolution: 'manual-review',
    rationale:
      'unclassified field — no auto-resolution rule applies; needs human review before applying',
  };
}

// ============================================================================
// Recursive walk
// ============================================================================

/**
 * Returns `true` when `value` is a plain object (not null, not an array).
 *
 * Arrays are treated as atomic leaf values — no per-element classification.
 *
 * @param value - Value to test.
 * @returns `true` when `value` is a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively walks two objects (or leaf values) at `prefix` and appends a
 * {@link FieldClassification} for every leaf field encountered.
 *
 * For plain objects, recurses into the union of keys from both sides.
 * For all other values (primitives, arrays, or when one side is missing),
 * delegates to {@link classifyField}.
 *
 * Missing-on-one-side rules:
 * - Field present in B but absent in A → `local = undefined`.
 * - Field present in A but absent in B → `imported = undefined`.
 *
 * @param filename        - Which JSON file is being classified.
 * @param prefix          - Current dot-path prefix (empty string at root).
 * @param local           - Value from locally regenerated content (A).
 * @param imported        - Value from imported bundle (B).
 * @param classifications - Accumulator array; entries are pushed here.
 */
function walkAndClassify(
  filename: FilenameForRestore,
  prefix: string,
  local: unknown,
  imported: unknown,
  classifications: FieldClassification[],
): void {
  if (isPlainObject(local) && isPlainObject(imported)) {
    // Both are plain objects — recurse into the union of all keys.
    const allKeys = new Set([...Object.keys(local), ...Object.keys(imported)]);
    for (const key of allKeys) {
      const childPath = prefix === '' ? key : `${prefix}.${key}`;
      walkAndClassify(filename, childPath, local[key], imported[key], classifications);
    }
    return;
  }

  if (isPlainObject(local) && imported === undefined) {
    // Local is an object, imported is absent — recurse with imported as undefined leaves.
    const allKeys = Object.keys(local);
    for (const key of allKeys) {
      const childPath = prefix === '' ? key : `${prefix}.${key}`;
      walkAndClassify(filename, childPath, local[key], undefined, classifications);
    }
    return;
  }

  if (local === undefined && isPlainObject(imported)) {
    // Local is absent, imported is an object — recurse with local as undefined leaves.
    const allKeys = Object.keys(imported);
    for (const key of allKeys) {
      const childPath = prefix === '' ? key : `${prefix}.${key}`;
      walkAndClassify(filename, childPath, undefined, imported[key], classifications);
    }
    return;
  }

  // Leaf: primitive, array, or one is an object while the other is not.
  // Treat the whole value as a single field.
  classifications.push(classifyField(filename, prefix, local, imported));
}

// ============================================================================
// Dot-path object manipulation helpers
// ============================================================================

/**
 * Gets a value from a nested object using a dot-notation path.
 *
 * Returns `undefined` when any segment along the path is absent or not an object.
 *
 * @param obj  - The root object to traverse.
 * @param path - Dot-separated field path, e.g. "brain.embeddingProvider".
 * @returns The value at `path`, or `undefined`.
 */
function dotGet(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Sets a value in a nested object using a dot-notation path, creating
 * intermediate plain-object nodes as needed.
 *
 * Mutates `obj` in place.
 *
 * @param obj   - The root object to mutate.
 * @param path  - Dot-separated field path.
 * @param value - Value to set.
 */
function dotSet(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    if (!isPlainObject(current[part])) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const lastPart = parts[parts.length - 1] as string;
  current[lastPart] = value;
}

/**
 * Produces a deep clone of a plain-object tree using JSON round-trip.
 *
 * Arrays and primitives at the root are also handled correctly.
 *
 * @param value - Value to clone.
 * @returns A structurally identical but referentially independent copy.
 */
function deepClone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

// ============================================================================
// Applied-result builder
// ============================================================================

/**
 * Builds the merged result object by applying all resolved classifications
 * on top of a deep clone of `localGenerated` (A).
 *
 * Resolution mapping:
 * - `A` (identical, machine-local, auto-detect) — keep the local value (no-op, already in clone).
 * - `B` (user-intent, project-identity)          — overwrite with imported value.
 * - `manual-review` (unknown)                    — keep local value as safe default.
 *
 * @param localGenerated  - Locally regenerated content (A).
 * @param classifications - All field classifications produced by the walk.
 * @returns The merged object with all B-resolution fields overwritten.
 */
function buildApplied(localGenerated: unknown, classifications: FieldClassification[]): unknown {
  const result = deepClone(localGenerated) as Record<string, unknown>;

  for (const classification of classifications) {
    if (classification.resolution === 'B') {
      // B resolution: overwrite with the imported value.
      // When imported value is undefined (field absent in B), remove from result.
      if (classification.imported === undefined) {
        // Field was in A but absent in B — for a B resolution this means we
        // want to remove it (preserve the "absent" state from the source).
        // Walk the path and delete the terminal key.
        const parts = classification.path.split('.');
        const parentPath = parts.slice(0, -1).join('.');
        const key = parts[parts.length - 1] as string;
        const parent = parentPath === '' ? result : dotGet(result, parentPath);
        if (isPlainObject(parent)) {
          delete (parent as Record<string, unknown>)[key];
        }
      } else {
        dotSet(result, classification.path, classification.imported);
      }
    }
    // resolution A or manual-review: keep the local value — already in clone.
  }

  return result;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Runs the A/B regenerate-and-compare classification engine for a single
 * JSON file.
 *
 * Does NOT write anything to disk. Returns a {@link JsonRestoreReport}
 * containing the per-field classifications, the merged `applied` result, and
 * a count of fields that require manual review.
 *
 * The `localGenerated` field on the input is used directly as the A side.
 * Pass the result of the appropriate generator from `regenerators.ts` (or any
 * equivalent object for testing).
 *
 * Classification precedence (spec §6.3):
 *   identical > machine-local > user-intent > project-identity > auto-detect > unknown
 *
 * @task T354
 * @epic T311
 * @param input - Filename, imported content (B), and locally regenerated content (A).
 * @returns A complete `JsonRestoreReport` for the caller to persist.
 */
export function regenerateAndCompare(input: RegenerateAndCompareInput): JsonRestoreReport {
  const { filename, imported, localGenerated } = input;

  const classifications: FieldClassification[] = [];
  walkAndClassify(filename, '', localGenerated, imported, classifications);

  const applied = buildApplied(localGenerated, classifications);

  const conflictCount = classifications.filter((c) => c.resolution === 'manual-review').length;

  return {
    filename,
    localGenerated,
    imported,
    classifications,
    applied,
    conflictCount,
  };
}

/**
 * Convenience wrapper that runs `regenerateAndCompare` for all three JSON
 * files in a single call, generating the A sides from `projectRoot`.
 *
 * Useful in the CLI import command when all three files are present in the
 * bundle. Each generator runs independently.
 *
 * Does NOT write anything to disk.
 *
 * @task T354
 * @epic T311
 * @param projectRoot      - Absolute path to the project root (for A generation).
 * @param importedConfig   - Imported config.json content (B).
 * @param importedInfo     - Imported project-info.json content (B).
 * @param importedContext  - Imported project-context.json content (B).
 * @returns Object containing one `JsonRestoreReport` per managed JSON file.
 */
export function regenerateAndCompareAll(
  projectRoot: string,
  importedConfig: unknown,
  importedInfo: unknown,
  importedContext: unknown,
): {
  config: JsonRestoreReport;
  projectInfo: JsonRestoreReport;
  projectContext: JsonRestoreReport;
} {
  const config = regenerateAndCompare({
    filename: 'config.json',
    imported: importedConfig,
    localGenerated: regenerateConfigJson(projectRoot).content,
  });

  const projectInfo = regenerateAndCompare({
    filename: 'project-info.json',
    imported: importedInfo,
    localGenerated: regenerateProjectInfoJson(projectRoot).content,
  });

  const projectContext = regenerateAndCompare({
    filename: 'project-context.json',
    imported: importedContext,
    localGenerated: regenerateProjectContextJson(projectRoot).content,
  });

  return { config, projectInfo, projectContext };
}
