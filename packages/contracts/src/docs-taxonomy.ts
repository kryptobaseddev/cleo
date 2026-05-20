/**
 * Canonical Doc-Kind Taxonomy Registry (T9788).
 *
 * Single source of truth for the user-facing document-kind taxonomy consumed
 * by `cleo docs` (add / list / publish-pr / list-types / schema). Prior to
 * this module the taxonomy was duplicated across three files:
 *
 * - `packages/contracts/src/operations/docs.ts` — `DOCS_TYPE_VALUES` (6 kinds)
 * - `packages/core/src/docs/publish-pr.ts` — `KNOWN_DOC_TYPES` (6 kinds)
 * - `packages/cleo/src/dispatch/domains/docs.ts` — local mirror (6 kinds)
 *
 * The three copies drifted independently. T9788 consolidates them behind
 * {@link DocKindRegistry} so a new kind requires editing exactly one place
 * (or one config file for project-level extensions).
 *
 * IMPORTANT — relationship to {@link import('./docs-accessor.js').DocKind}:
 * `DocKind` in `docs-accessor.ts` is the STORAGE-LAYER discriminator (which
 * backing store holds the bytes — llmtxt.db vs manifest.db). The taxonomy
 * here is the USER-FACING DOCUMENT CLASSIFICATION (what kind of document
 * the human / agent authored). The two are intentionally distinct:
 *
 * - `docs-accessor.DocKind` answers "where is it stored?"
 * - `docs-taxonomy.DocKindMetadata.kind` answers "what is it about?"
 *
 * Most user-facing docs are stored under `docs-accessor.DocKind = 'adr'` or
 * `'agent-output'`; their taxonomy `kind` (this file) carries the semantic
 * classification.
 *
 * Backward compatibility (T9788 AC8):
 * - Every prior `DOCS_TYPE_VALUES` value remains in {@link BUILTIN_DOC_KINDS}.
 * - Tests using literal strings `'spec'`, `'adr'`, etc. continue to pass.
 * - The stored `type` column shape is unchanged (still a string).
 *
 * @epic T9787 (E-DOCS-TAXONOMY-V2)
 * @task T9788
 * @see ADR-073 §1 — Task Hierarchy Charter (sibling registry pattern)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Core taxonomy metadata interface
// ---------------------------------------------------------------------------

/**
 * Metadata for a single document kind in the canonical registry.
 *
 * Built-in kinds are declared in {@link BUILTIN_DOC_KINDS}; project-level
 * extensions are loaded from `.cleo/docs-config.json` via
 * {@link DocKindRegistry.load}.
 *
 * @see {@link DocKindRegistry} — runtime accessor and validator
 */
export interface DocKindMetadata {
  /** Canonical kind id, lowercase kebab-case. */
  readonly kind: string;
  /** Human label for display in CLI output and UIs. */
  readonly label: string;
  /** One-line description shown by `cleo docs list-types`. */
  readonly description: string;
  /**
   * Default owner kind prefix when no explicit owner is provided.
   *
   * - `task` — `T###`
   * - `session` — `ses_*`
   * - `observation` — `O-*`
   * - `project` — repo-root project doc (no entity owner)
   */
  readonly defaultOwnerKind: 'task' | 'session' | 'observation' | 'project';
  /**
   * Publish-dir under the repo root for `cleo docs publish-pr`.
   *
   * Examples: `docs/adr`, `docs/spec`, `.changeset`, `docs/release`.
   */
  readonly publishDir: string;
  /**
   * When `true`, every doc of this kind MUST carry a slug matching
   * {@link entityIdPattern}.
   *
   * Used by `cleo docs add --type X --slug Y` to enforce naming
   * conventions for kinds whose downstream consumers parse the slug
   * (e.g. ADRs expect `adr-NNN-<rest>`).
   */
  readonly requiresEntityId: boolean;
  /**
   * Regex slug pattern. Validated when {@link requiresEntityId} is `true`.
   *
   * Stored as a {@link RegExp} so the validator can run without a
   * compile step. Extensions loaded from `.cleo/docs-config.json` parse
   * their string pattern into a `RegExp` at load time.
   */
  readonly entityIdPattern?: RegExp;
  /**
   * Marks an entry that was loaded from `.cleo/docs-config.json` rather
   * than the built-in {@link BUILTIN_DOC_KINDS} array.
   *
   * Built-in kinds leave this unset; extensions set it to `true`.
   */
  readonly isExtension?: boolean;
}

// ---------------------------------------------------------------------------
// Built-in registry (10 canonical kinds)
// ---------------------------------------------------------------------------

/**
 * Canonical list of built-in document kinds.
 *
 * Adding a kind requires:
 *   1. Append an entry here (preserving existing kinds for back-compat).
 *   2. Run the contracts build — every consumer picks the new kind up.
 *
 * Order is preserved by {@link DocKindRegistry.list}. Built-in kinds
 * always sort before extensions.
 *
 * @see {@link DocKindMetadata} — entry shape
 */
export const BUILTIN_DOC_KINDS: ReadonlyArray<DocKindMetadata> = [
  {
    kind: 'adr',
    label: 'ADR',
    description: 'Architectural decision record',
    defaultOwnerKind: 'task',
    publishDir: 'docs/adr',
    requiresEntityId: true,
    entityIdPattern: /^adr-\d{3,4}-[a-z0-9-]+$/,
  },
  {
    kind: 'spec',
    label: 'Spec',
    description: 'Technical specification',
    defaultOwnerKind: 'task',
    publishDir: 'docs/spec',
    requiresEntityId: false,
  },
  {
    kind: 'research',
    label: 'Research',
    description: 'Investigation / research note',
    defaultOwnerKind: 'task',
    publishDir: 'docs/research',
    requiresEntityId: false,
  },
  {
    kind: 'handoff',
    label: 'Handoff',
    description: 'Session / agent handoff',
    defaultOwnerKind: 'session',
    publishDir: 'docs/handoff',
    requiresEntityId: false,
  },
  {
    kind: 'note',
    label: 'Note',
    description: 'Agent observation / informal note',
    defaultOwnerKind: 'observation',
    publishDir: 'docs/note',
    requiresEntityId: false,
  },
  {
    kind: 'llm-readme',
    label: 'LLM README',
    description: 'Machine-readable README (llms.txt)',
    defaultOwnerKind: 'project',
    publishDir: '.',
    requiresEntityId: false,
  },
  {
    kind: 'changeset',
    label: 'Changeset',
    description: 'Atomic change entry (release-note input)',
    defaultOwnerKind: 'task',
    publishDir: '.changeset',
    requiresEntityId: true,
    entityIdPattern: /^t\d+-[a-z0-9-]+$/,
  },
  {
    kind: 'release-note',
    label: 'Release Note',
    description: 'Composed release notes',
    defaultOwnerKind: 'project',
    publishDir: 'docs/release',
    requiresEntityId: true,
    entityIdPattern: /^v\d{4}\.\d+\.\d+(-[a-z0-9-]+)?$/,
  },
  {
    kind: 'plan',
    label: 'Plan',
    description: 'Epic / saga decomposition plan',
    defaultOwnerKind: 'task',
    publishDir: 'docs/plan',
    requiresEntityId: false,
  },
  {
    kind: 'rcasd',
    label: 'RCASD',
    description: 'Root-cause analysis + scoped delivery',
    defaultOwnerKind: 'task',
    publishDir: '.cleo/rcasd',
    requiresEntityId: true,
    entityIdPattern: /^t\d+(-.+)?$/,
  },
];

/**
 * Tuple of every built-in kind id (lowercase kebab-case).
 *
 * Useful for `satisfies` checks and union derivation in downstream
 * contracts (e.g. `operations/docs.ts`). Kept frozen.
 */
export const BUILTIN_DOC_KIND_VALUES: ReadonlyArray<string> = Object.freeze(
  BUILTIN_DOC_KINDS.map((d) => d.kind),
);

/**
 * Union of every built-in kind id.
 *
 * Extensions loaded at runtime widen the runtime registry but NOT this
 * compile-time type — that is intentional: extensions are opt-in and
 * code that only handles the built-in surface stays type-safe.
 */
export type BuiltinDocKind = (typeof BUILTIN_DOC_KINDS)[number]['kind'];

// ---------------------------------------------------------------------------
// Extension config schema
// ---------------------------------------------------------------------------

/**
 * Wire shape of an extension entry in `.cleo/docs-config.json`.
 *
 * `entityIdPattern` is a string here (not a {@link RegExp}) because JSON
 * cannot carry compiled regexes. {@link DocKindRegistry.load} compiles it
 * to a `RegExp` while validating the config.
 */
export interface DocKindExtensionConfig {
  /** Canonical kind id, lowercase kebab-case. */
  readonly kind: string;
  /** Human label for display. */
  readonly label: string;
  /** One-line description for `cleo docs list-types`. */
  readonly description: string;
  /** Default owner kind prefix. */
  readonly defaultOwnerKind: 'task' | 'session' | 'observation' | 'project';
  /** Publish-dir under repo root. */
  readonly publishDir: string;
  /** When `true`, slug MUST match {@link entityIdPattern}. */
  readonly requiresEntityId: boolean;
  /**
   * Regex source string (no flags). Compiled to a `RegExp` at load time.
   *
   * Validated against {@link DocKindRegistry.SAFE_REGEX_LENGTH_LIMIT} so
   * a malformed config can't trigger pathological backtracking.
   */
  readonly entityIdPattern?: string;
}

/**
 * Top-level shape of `.cleo/docs-config.json`.
 *
 * Future fields stay backward compatible by being optional.
 */
export interface DocKindConfigFile {
  /** Project-level extension registry. */
  readonly extensions?: ReadonlyArray<DocKindExtensionConfig>;
}

// ---------------------------------------------------------------------------
// Slug validation result type
// ---------------------------------------------------------------------------

/**
 * Result of {@link DocKindRegistry.validateSlug}.
 *
 * - `ok: true` — slug is valid for the given kind.
 * - `ok: false` — slug fails validation; `error` carries a human-readable
 *   reason and `example` shows a passing slug.
 */
export type SlugValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly example?: string };

// ---------------------------------------------------------------------------
// Registry class
// ---------------------------------------------------------------------------

/**
 * Runtime accessor for the canonical doc-kind registry.
 *
 * Combines {@link BUILTIN_DOC_KINDS} with project-level extensions loaded
 * from `.cleo/docs-config.json`. Built-in entries always win on collision
 * — extensions cannot override a built-in kind.
 *
 * Usage:
 * ```ts
 * const registry = DocKindRegistry.load(projectRoot);
 * const adr = registry.get('adr');
 * const check = registry.validateSlug('adr', 'adr-001-intro');
 * ```
 *
 * @task T9788
 */
export class DocKindRegistry {
  /**
   * Maximum allowed length of an `entityIdPattern` source string.
   *
   * Caps the input surface so a malformed extension config cannot trigger
   * pathological regex backtracking. 256 chars is far more than any
   * realistic slug pattern (typical: 30–60 chars).
   */
  static readonly SAFE_REGEX_LENGTH_LIMIT = 256;

  private readonly byKind: ReadonlyMap<string, DocKindMetadata>;
  private readonly orderedEntries: ReadonlyArray<DocKindMetadata>;

  /**
   * Construct a registry from an explicit array of entries.
   *
   * Most callers should use {@link DocKindRegistry.load} instead; this
   * constructor is exposed for tests that want to bypass filesystem I/O.
   *
   * @param entries - Pre-validated doc-kind metadata (built-in + extensions).
   */
  constructor(entries: ReadonlyArray<DocKindMetadata>) {
    this.orderedEntries = entries;
    const map = new Map<string, DocKindMetadata>();
    for (const entry of entries) {
      // First write wins; built-ins are passed first by `load`, so this
      // automatically gives built-ins precedence over extensions.
      if (!map.has(entry.kind)) map.set(entry.kind, entry);
    }
    this.byKind = map;
  }

  /**
   * Load the canonical registry, merging built-ins with extensions from
   * `<projectRoot>/.cleo/docs-config.json`.
   *
   * Missing or unreadable config file → returns the built-in-only registry.
   * Malformed config (bad JSON, invalid entry, regex too long, etc.) →
   * throws {@link DocKindConfigError} so the caller can surface a clear
   * envelope rather than silently dropping extensions.
   *
   * @param projectRoot - Absolute path to the repo root.
   * @throws DocKindConfigError when the config exists but is invalid.
   */
  static load(projectRoot: string): DocKindRegistry {
    const configPath = join(projectRoot, '.cleo', 'docs-config.json');

    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf-8');
    } catch {
      // No config file → built-ins only.
      return new DocKindRegistry(BUILTIN_DOC_KINDS);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new DocKindConfigError(
        `${configPath}: invalid JSON — ${(err as Error).message}`,
        configPath,
      );
    }

    const config = validateDocKindConfig(parsed, configPath);
    const extensions = (config.extensions ?? []).map((ext) => compileExtension(ext, configPath));

    return new DocKindRegistry([...BUILTIN_DOC_KINDS, ...extensions]);
  }

  /**
   * Build a registry from already-parsed config — bypasses filesystem I/O.
   *
   * Used by tests and HTTP-dispatch callers that hand-construct a config
   * object instead of reading from disk.
   *
   * @param config - Parsed config object (or `undefined` for built-ins only).
   * @param sourceLabel - Optional label used in error messages.
   * @throws DocKindConfigError when the config object is invalid.
   */
  static fromConfig(
    config: DocKindConfigFile | undefined,
    sourceLabel = '<inline-config>',
  ): DocKindRegistry {
    if (!config) return new DocKindRegistry(BUILTIN_DOC_KINDS);
    const validated = validateDocKindConfig(config, sourceLabel);
    const extensions = (validated.extensions ?? []).map((ext) =>
      compileExtension(ext, sourceLabel),
    );
    return new DocKindRegistry([...BUILTIN_DOC_KINDS, ...extensions]);
  }

  /**
   * Default registry — built-in kinds only, no extensions.
   *
   * Suitable for code paths that never need project-level extensions
   * (e.g. unit tests, library-mode consumers).
   */
  static builtinOnly(): DocKindRegistry {
    return new DocKindRegistry(BUILTIN_DOC_KINDS);
  }

  /** True when `kind` is registered (built-in OR extension). */
  has(kind: string): boolean {
    return this.byKind.has(kind);
  }

  /** Look up metadata for a registered kind. Returns `undefined` on miss. */
  get(kind: string): DocKindMetadata | undefined {
    return this.byKind.get(kind);
  }

  /**
   * List every registered kind, built-ins first then extensions in
   * declaration order.
   *
   * Used by `cleo docs schema` and `cleo docs list-types`.
   */
  list(): ReadonlyArray<DocKindMetadata> {
    return this.orderedEntries;
  }

  /**
   * Validate a slug against the registered pattern for `kind`.
   *
   * Behaviour:
   * - Unknown kind → `{ ok: false, error: "unknown kind '<kind>'" }`.
   * - Known kind with `requiresEntityId === false` → always `{ ok: true }`.
   * - Known kind with `requiresEntityId === true` and no pattern → defensive
   *   `{ ok: false }` since the registry entry is internally inconsistent.
   * - Known kind with pattern → tests `slug` against the pattern.
   *
   * @param kind - Registered kind id.
   * @param slug - Slug to validate.
   * @returns Pass/fail result with a human-readable error on failure.
   */
  validateSlug(kind: string, slug: string): SlugValidationResult {
    const meta = this.byKind.get(kind);
    if (!meta) {
      return { ok: false, error: `unknown kind '${kind}'` };
    }
    if (!meta.requiresEntityId) {
      return { ok: true };
    }
    if (!meta.entityIdPattern) {
      // Defensive: registry entry marked requiresEntityId but lacks the
      // pattern. Built-in entries always carry one; an extension that
      // omits it is rejected at load time, so this branch is reachable
      // only via the public constructor with a hand-crafted array.
      return {
        ok: false,
        error: `kind '${kind}' requires an entityIdPattern but the registry entry omits one`,
      };
    }
    if (!meta.entityIdPattern.test(slug)) {
      return {
        ok: false,
        error: `slug '${slug}' does not match pattern ${meta.entityIdPattern.source} for kind '${kind}'`,
        example: buildSlugExample(meta),
      };
    }
    return { ok: true };
  }

  /**
   * Map a kind to its `publishDir` (e.g. `'adr'` → `'docs/adr'`).
   *
   * Returns `undefined` for unknown kinds — callers decide whether to
   * fall back to a default (e.g. `'docs/note'`) or surface an error.
   */
  publishDirFor(kind: string): string | undefined {
    return this.byKind.get(kind)?.publishDir;
  }
}

/**
 * Error thrown by {@link DocKindRegistry.load} and
 * {@link DocKindRegistry.fromConfig} when the supplied config is invalid.
 *
 * Carries the offending source path / label so the CLI surface can render
 * a `details` payload pointing the user at the right file.
 */
export class DocKindConfigError extends Error {
  /** Source identifier — file path on disk, or `<inline-config>` for tests. */
  readonly source: string;

  constructor(message: string, source: string) {
    super(message);
    this.name = 'DocKindConfigError';
    this.source = source;
  }
}

// ---------------------------------------------------------------------------
// Config validation helpers
// ---------------------------------------------------------------------------

/**
 * Narrow an arbitrary parsed-JSON value to {@link DocKindConfigFile}.
 *
 * Performs structural validation only — regex compilation happens in
 * {@link compileExtension}.
 *
 * @internal
 */
function validateDocKindConfig(raw: unknown, source: string): DocKindConfigFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DocKindConfigError(`${source}: top-level value must be an object`, source);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.extensions === undefined) {
    return {};
  }
  if (!Array.isArray(obj.extensions)) {
    throw new DocKindConfigError(`${source}: 'extensions' must be an array`, source);
  }
  const extensions: DocKindExtensionConfig[] = [];
  for (let i = 0; i < obj.extensions.length; i++) {
    const item = obj.extensions[i];
    extensions.push(validateExtensionEntry(item, source, i));
  }
  return { extensions };
}

/**
 * Narrow one extension entry from the parsed `extensions[]` array.
 *
 * @internal
 */
function validateExtensionEntry(
  raw: unknown,
  source: string,
  index: number,
): DocKindExtensionConfig {
  const where = `${source} extensions[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DocKindConfigError(`${where}: must be an object`, source);
  }
  const obj = raw as Record<string, unknown>;

  const kind = requireString(obj, 'kind', where, source);
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) {
    throw new DocKindConfigError(
      `${where}: 'kind' must be lowercase kebab-case (got '${kind}')`,
      source,
    );
  }
  const builtinNames = new Set(BUILTIN_DOC_KIND_VALUES);
  if (builtinNames.has(kind)) {
    throw new DocKindConfigError(
      `${where}: kind '${kind}' shadows a built-in — built-ins cannot be overridden`,
      source,
    );
  }
  const label = requireString(obj, 'label', where, source);
  const description = requireString(obj, 'description', where, source);
  const defaultOwnerKind = requireString(obj, 'defaultOwnerKind', where, source);
  if (
    defaultOwnerKind !== 'task' &&
    defaultOwnerKind !== 'session' &&
    defaultOwnerKind !== 'observation' &&
    defaultOwnerKind !== 'project'
  ) {
    throw new DocKindConfigError(
      `${where}: 'defaultOwnerKind' must be task|session|observation|project (got '${defaultOwnerKind}')`,
      source,
    );
  }
  const publishDir = requireString(obj, 'publishDir', where, source);
  const requiresEntityId = obj.requiresEntityId;
  if (typeof requiresEntityId !== 'boolean') {
    throw new DocKindConfigError(`${where}: 'requiresEntityId' must be a boolean`, source);
  }

  let entityIdPattern: string | undefined;
  if (obj.entityIdPattern !== undefined) {
    if (typeof obj.entityIdPattern !== 'string') {
      throw new DocKindConfigError(`${where}: 'entityIdPattern' must be a string`, source);
    }
    if (obj.entityIdPattern.length > DocKindRegistry.SAFE_REGEX_LENGTH_LIMIT) {
      throw new DocKindConfigError(
        `${where}: 'entityIdPattern' exceeds ${DocKindRegistry.SAFE_REGEX_LENGTH_LIMIT} chars`,
        source,
      );
    }
    entityIdPattern = obj.entityIdPattern;
  }

  if (requiresEntityId && entityIdPattern === undefined) {
    throw new DocKindConfigError(
      `${where}: 'entityIdPattern' is required when 'requiresEntityId' is true`,
      source,
    );
  }

  return {
    kind,
    label,
    description,
    defaultOwnerKind,
    publishDir,
    requiresEntityId,
    ...(entityIdPattern !== undefined ? { entityIdPattern } : {}),
  };
}

/**
 * Compile an extension config into a `DocKindMetadata` (regex compiled,
 * `isExtension` set).
 *
 * @internal
 */
function compileExtension(ext: DocKindExtensionConfig, source: string): DocKindMetadata {
  let entityIdPattern: RegExp | undefined;
  if (ext.entityIdPattern !== undefined) {
    try {
      entityIdPattern = new RegExp(ext.entityIdPattern);
    } catch (err) {
      throw new DocKindConfigError(
        `${source}: invalid regex for kind '${ext.kind}': ${(err as Error).message}`,
        source,
      );
    }
  }
  return {
    kind: ext.kind,
    label: ext.label,
    description: ext.description,
    defaultOwnerKind: ext.defaultOwnerKind,
    publishDir: ext.publishDir,
    requiresEntityId: ext.requiresEntityId,
    ...(entityIdPattern !== undefined ? { entityIdPattern } : {}),
    isExtension: true,
  };
}

/**
 * Extract a required string field from a parsed JSON object.
 *
 * @internal
 */
function requireString(
  obj: Record<string, unknown>,
  field: string,
  where: string,
  source: string,
): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new DocKindConfigError(`${where}: '${field}' must be a non-empty string`, source);
  }
  return value;
}

/**
 * Build a best-effort example slug from a metadata entry's pattern.
 *
 * Used by {@link DocKindRegistry.validateSlug} to give the caller a
 * concrete sample slug that would pass. Built-in patterns ship with
 * hard-coded samples; extensions fall back to the pattern source.
 *
 * @internal
 */
function buildSlugExample(meta: DocKindMetadata): string | undefined {
  // Hard-coded samples for built-in kinds keep the error message friendly.
  // Extensions get the raw pattern as a fallback.
  switch (meta.kind) {
    case 'adr':
      return 'adr-001-intro';
    case 'changeset':
      return 't9788-docs-taxonomy';
    case 'release-note':
      return 'v2026.5.93';
    case 'rcasd':
      return 't9788-investigation';
    default:
      return meta.entityIdPattern?.source;
  }
}
