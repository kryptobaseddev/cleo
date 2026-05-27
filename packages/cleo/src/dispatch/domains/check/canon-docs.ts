/**
 * check.canon.docs — CI gate for raw markdown writes against `.cleo/canon.yml`.
 *
 * Reads the canon routing registry, walks `git diff --diff-filter=A` between
 * a configurable base ref and `HEAD`, and flags any newly-added `*.md` file
 * that lands inside a `rawMdPaths` directory whose owning DocKind has
 * `rawMdAllowed: false`.
 *
 * The lockdown closes the gap T9625 left open: SSoT already exists (T9788
 * DocKindRegistry, T9791 1,427 imported docs), `cleo docs add` already
 * routes through it (T9793, T9794), but agents could still bypass the
 * pipeline with a plain `Write` to `.cleo/adrs/ADR-XXX.md`. This gate
 * blocks the bypass at PR-time without touching any existing legacy file.
 *
 * Semantics:
 *   - Pure additions (`--diff-filter=A`) only — renames/modifies/deletes
 *     are ignored so the gate never flags pre-existing migration artefacts.
 *   - Path match is "starts-with" against `rawMdPaths`, normalised to use
 *     `/` separators and a trailing `/` so `.cleo/adrs/sub/foo.md` is
 *     correctly attributed to the `.cleo/adrs/` entry.
 *   - When `rawMdAllowed: true` the entry is treated as a publish mirror
 *     (e.g. `.changeset/`) and skipped entirely.
 *   - When `canon.yml` is missing the gate is a no-op (success envelope)
 *     so projects without the lockdown opted-in see no behaviour change.
 *
 * @epic T9787 — SG-DOCS-CANON-CLOSURE
 * @task T9796 — E-DOCS-CANON-LOCKDOWN
 * @see ADR-076 — Canonical Docs SSoT (supersedes ADR-028)
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One DocKind entry in `.cleo/canon.yml`.
 *
 * See `.cleo/canon.schema.json` for the JSON-Schema contract.
 */
export interface CanonKindEntry {
  /** `'ssot'` — blob-store-only; `'ssot-first'` — dual-write via cleo verb. */
  readonly canonicalHome: 'ssot' | 'ssot-first';
  /** Relative path to the human-reviewable mirror (e.g. `docs/adr/`). */
  readonly publishMirror: string;
  /** When `false`, NEW *.md under `rawMdPaths` fails the gate. */
  readonly rawMdAllowed: boolean;
  /** Directories the gate scans. Optional when `rawMdAllowed: false`. */
  readonly rawMdPaths?: ReadonlyArray<string>;
}

/**
 * Optional `similarity:` block parsed from `.cleo/canon.yml`. Mirrors the
 * shape of `core/docs/similarity-check.ts:SimilarityConfig` so the CLI can
 * surface project-level overrides for the docs-add slug similarity check
 * without taking a core dependency at the canon-loader layer (T10361).
 *
 * @see packages/core/src/docs/similarity-check.ts
 */
export interface CanonSimilarityConfig {
  /** Score above this triggers the warn/block. Defaults to `0.85`. */
  readonly warnThreshold: number;
  /** `'warn'` (print + continue) or `'block'` (exit unless `--allow-similar`). */
  readonly mode: 'warn' | 'block';
}

/**
 * Parsed shape of `.cleo/canon.yml`.
 *
 * Validated at runtime by {@link loadCanonRegistry}; callers receive the
 * narrowed type only when validation passes.
 */
export interface CanonRegistry {
  /** Schema version. Currently always `1`. */
  readonly version: number;
  /** Map of DocKind id (e.g. `'adr'`, `'changeset'`) to its routing entry. */
  readonly kinds: Readonly<Record<string, CanonKindEntry>>;
  /** Optional similarity-check overrides (T10361). */
  readonly similarity?: CanonSimilarityConfig;
}

/** One violation surfaced by the docs canon gate. */
export interface CanonDocsViolation {
  /** Repo-relative path of the offending file (e.g. `.cleo/adrs/ADR-XXX.md`). */
  readonly file: string;
  /** Owning DocKind id from `canon.yml` (e.g. `'adr'`). */
  readonly kind: string;
  /** The `rawMdPaths` entry that matched (e.g. `'.cleo/adrs/'`). */
  readonly matchedPath: string;
  /** Suggested fix-command text (`cleo docs add ... --type <kind>`). */
  readonly fix: string;
}

/** Aggregate result returned by {@link runCanonDocsCheck}. */
export interface CanonDocsCheckResult {
  /** True when no violations were found. */
  readonly passed: boolean;
  /** Git diff base ref that was scanned. */
  readonly baseRef: string;
  /** Number of `*.md` additions inspected. */
  readonly scanned: number;
  /** Violations grouped per file. Empty when `passed === true`. */
  readonly violations: ReadonlyArray<CanonDocsViolation>;
  /**
   * When `canon.yml` is missing, this is `'no-canon'` — the gate becomes
   * a no-op success. When `canon.yml` is present, this is `'enforced'`.
   */
  readonly mode: 'enforced' | 'no-canon';
}

/** Parameters accepted by {@link runCanonDocsCheck}. */
export interface CanonDocsCheckParams {
  /** Absolute path to the project root. */
  readonly projectRoot: string;
  /**
   * Git revision to diff against. Defaults to `origin/main`.
   *
   * CI surface passes `origin/${{ github.base_ref }}` so PRs targeting any
   * branch (not just `main`) get a correct, branch-relative scan.
   */
  readonly baseRef?: string;
  /**
   * Test override — when supplied, bypasses `git diff` and uses these
   * repo-relative paths as the candidate set. Used by unit tests so they
   * can validate routing without needing a live commit graph.
   */
  readonly candidateFiles?: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a configured directory path so it always:
 *   1. Uses forward slashes (matches `git diff` output).
 *   2. Ends with a trailing `/` so `startsWith` cannot accidentally
 *      match e.g. `.cleo/adrs-archive/` against `.cleo/adrs/`.
 *
 * @internal
 */
function normaliseDir(dir: string): string {
  const slashed = dir.split(sep).join('/');
  return slashed.endsWith('/') ? slashed : `${slashed}/`;
}

/**
 * Run `git diff --diff-filter=A --name-only <base>...HEAD` and return the
 * `*.md` additions. Failures (missing ref, not-a-repo) surface as an empty
 * list — the gate stays permissive when the diff cannot be computed so a
 * shallow CI clone or fresh repo never produces a false positive.
 *
 * @internal
 */
function listAddedMarkdownFiles(projectRoot: string, baseRef: string): string[] {
  try {
    const out = execSync(`git diff --diff-filter=A --name-only ${baseRef}...HEAD`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.endsWith('.md'));
  } catch {
    return [];
  }
}

/**
 * Validate the parsed YAML against the `CanonRegistry` shape. Throws on
 * structural defects with a message identifying the offending field so the
 * CI gate surfaces a clear `E_CANON_INVALID` envelope.
 *
 * @internal
 */
function validateCanonRegistry(raw: unknown, source: string): CanonRegistry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source}: top-level value must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const version = obj['version'];
  if (typeof version !== 'number' || version !== 1) {
    throw new Error(`${source}: 'version' must be the integer 1 (got ${String(version)})`);
  }
  const kindsRaw = obj['kinds'];
  if (kindsRaw === null || typeof kindsRaw !== 'object' || Array.isArray(kindsRaw)) {
    throw new Error(`${source}: 'kinds' must be an object`);
  }
  const kinds: Record<string, CanonKindEntry> = {};
  for (const [kindId, entryRaw] of Object.entries(kindsRaw as Record<string, unknown>)) {
    kinds[kindId] = validateKindEntry(kindId, entryRaw, source);
  }
  // T10361 — optional `similarity:` block. Absent => downstream consumers
  // fall back to DEFAULT_SIMILARITY_THRESHOLD / DEFAULT_SIMILARITY_MODE.
  const similarity = validateSimilarity(obj['similarity'], source);
  return similarity !== undefined ? { version, kinds, similarity } : { version, kinds };
}

/**
 * Validate the optional top-level `similarity:` block. Returns `undefined`
 * when omitted (defaults applied by the caller). Throws on structural
 * defects so the canon-load surface emits a clear `E_CANON_INVALID`.
 *
 * @internal
 * @task T10361
 */
function validateSimilarity(raw: unknown, source: string): CanonSimilarityConfig | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source}: 'similarity' must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const warnThresholdRaw = obj['warnThreshold'];
  let warnThreshold = 0.85;
  if (warnThresholdRaw !== undefined) {
    if (
      typeof warnThresholdRaw !== 'number' ||
      Number.isNaN(warnThresholdRaw) ||
      warnThresholdRaw < 0 ||
      warnThresholdRaw > 1
    ) {
      throw new Error(
        `${source}: 'similarity.warnThreshold' must be a number in [0, 1] (got ${String(warnThresholdRaw)})`,
      );
    }
    warnThreshold = warnThresholdRaw;
  }
  const modeRaw = obj['mode'];
  let mode: 'warn' | 'block' = 'warn';
  if (modeRaw !== undefined) {
    if (modeRaw !== 'warn' && modeRaw !== 'block') {
      throw new Error(
        `${source}: 'similarity.mode' must be 'warn' or 'block' (got ${String(modeRaw)})`,
      );
    }
    mode = modeRaw;
  }
  return { warnThreshold, mode };
}

/** @internal */
function validateKindEntry(kindId: string, raw: unknown, source: string): CanonKindEntry {
  const where = `${source} kinds.${kindId}`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}: must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const canonicalHome = obj['canonicalHome'];
  if (canonicalHome !== 'ssot' && canonicalHome !== 'ssot-first') {
    throw new Error(
      `${where}: 'canonicalHome' must be 'ssot' or 'ssot-first' (got ${String(canonicalHome)})`,
    );
  }
  const publishMirror = obj['publishMirror'];
  if (typeof publishMirror !== 'string' || publishMirror.length === 0) {
    throw new Error(`${where}: 'publishMirror' must be a non-empty string`);
  }
  const rawMdAllowed = obj['rawMdAllowed'];
  if (typeof rawMdAllowed !== 'boolean') {
    throw new Error(`${where}: 'rawMdAllowed' must be a boolean`);
  }
  const rawMdPathsRaw = obj['rawMdPaths'];
  let rawMdPaths: ReadonlyArray<string> | undefined;
  if (rawMdPathsRaw !== undefined) {
    if (!Array.isArray(rawMdPathsRaw)) {
      throw new Error(`${where}: 'rawMdPaths' must be an array`);
    }
    for (const p of rawMdPathsRaw) {
      if (typeof p !== 'string' || p.length === 0) {
        throw new Error(`${where}: 'rawMdPaths' entries must be non-empty strings`);
      }
    }
    rawMdPaths = rawMdPathsRaw as ReadonlyArray<string>;
  }
  return {
    canonicalHome,
    publishMirror,
    rawMdAllowed,
    ...(rawMdPaths !== undefined ? { rawMdPaths } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load `.cleo/canon.yml` from `projectRoot`. Returns `undefined` when the
 * file is missing (the gate becomes a no-op success). Throws on parse or
 * structural errors so the CI gate can surface them as `E_CANON_INVALID`.
 *
 * @param projectRoot - Absolute path to the repo root.
 */
export function loadCanonRegistry(projectRoot: string): CanonRegistry | undefined {
  const path = join(projectRoot, '.cleo', 'canon.yml');
  if (!existsSync(path)) {
    return undefined;
  }
  const text = readFileSync(path, 'utf8');
  const parsed = parseYaml(text) as unknown;
  return validateCanonRegistry(parsed, path);
}

/**
 * Run the docs canon gate.
 *
 * Walks `git diff --diff-filter=A --name-only <baseRef>...HEAD` (or the
 * test-supplied `candidateFiles`), then flags every `*.md` file that lands
 * under a `rawMdPaths` entry whose owning kind has `rawMdAllowed: false`.
 *
 * The default `baseRef` is `origin/main`. CI invocations override it with
 * `origin/${{ github.base_ref }}` so non-main PR bases work.
 *
 * @param params - Project root + optional base ref + test overrides.
 * @returns Structured result enumerating every violation.
 */
export function runCanonDocsCheck(params: CanonDocsCheckParams): CanonDocsCheckResult {
  const { projectRoot, baseRef = 'origin/main', candidateFiles } = params;

  const registry = loadCanonRegistry(projectRoot);
  if (!registry) {
    return {
      passed: true,
      baseRef,
      scanned: 0,
      violations: [],
      mode: 'no-canon',
    };
  }

  // Build the [matchedPath, kindId] list, only for kinds that actively block.
  const blockingPaths: Array<{ dir: string; kind: string }> = [];
  for (const [kind, entry] of Object.entries(registry.kinds)) {
    if (entry.rawMdAllowed) continue;
    if (!entry.rawMdPaths || entry.rawMdPaths.length === 0) continue;
    for (const p of entry.rawMdPaths) {
      blockingPaths.push({ dir: normaliseDir(p), kind });
    }
  }

  const candidates = candidateFiles ?? listAddedMarkdownFiles(projectRoot, baseRef);
  const violations: CanonDocsViolation[] = [];

  for (const file of candidates) {
    // Normalise to forward slashes — `git diff` already uses `/`, but the
    // test surface may pass Windows-style separators.
    const normalised = file.split(sep).join('/');
    for (const { dir, kind } of blockingPaths) {
      if (normalised.startsWith(dir)) {
        violations.push({
          file: normalised,
          kind,
          matchedPath: dir,
          fix: `cleo docs add <taskId> ${normalised} --type ${kind}`,
        });
        break;
      }
    }
  }

  return {
    passed: violations.length === 0,
    baseRef,
    scanned: candidates.length,
    violations,
    mode: 'enforced',
  };
}
