/**
 * DocKind Writer Registry — single source of truth for "which verb writes
 * which DocKind".
 *
 * ## Why this module exists
 *
 * Before this module, the mapping from `BuiltinDocKind` to its canonical
 * writer was implicit and spread across multiple call sites:
 *
 *   - `cleo docs add`        → `packages/cleo/src/dispatch/domains/docs.ts:add`
 *   - `cleo changeset add`   → `packages/core/src/changesets/writer.ts:writeChangesetEntry`
 *   - System-managed kinds   → no exported writer (composed by tooling)
 *
 * Two parallel writer paths can (and historically did) call
 * `attachmentStore.put({ slug })` for the SAME `BuiltinDocKind` through
 * different code paths and surface conflicts through DIFFERENT envelopes.
 * T10294 (PR #576) RCA classified this as the slug-collision class — see
 * `option (c)`: collapse writers AND introduce a chokepoint allocator.
 *
 * This module is the writer-registry half of that fix. The allocator half is
 * already delivered by T10392 (`reserveSlug` in
 * {@link ./slug-allocator.js}). Together they make the contract explicit:
 *
 *   1. For every `BuiltinDocKind` there is EXACTLY ONE
 *      {@link WriterDescriptor} in the registry.
 *   2. Every caller that wants to write a doc of a given kind goes through
 *      {@link WriterRegistry.write}, which calls {@link reserveSlug} BEFORE
 *      the actual writer.
 *   3. A multi-writer regression trips {@link WriterRegistry.for} at
 *      registry-build time — surfaced as a programmer error in dev/CI
 *      rather than a silent envelope drift in production.
 *
 * ## Scope of T10366 (foundation)
 *
 * T10366 establishes the registry CONTRACT and shape. Actual writer
 * delegation wiring lands in T10367 + T10368. {@link WriterRegistry.write}
 * therefore currently:
 *   - Validates the kind.
 *   - Calls {@link reserveSlug} (the T10392 chokepoint).
 *   - Returns a placeholder `attachmentId` on success — downstream tasks
 *     replace the placeholder with the actual writer dispatch.
 *
 * The descriptor map IS the contract — downstream consumers (T10367 wires
 * `docs add`, T10368 wires `changeset add`) read the `coreFn`/`dispatchOp`
 * fields to resolve the writer at the same call site.
 *
 * ## Scope of T10368 (audit + system-managed exemptions)
 *
 * T10368 adds the {@link SystemManagedEntry} map + lookup helper
 * {@link WriterRegistry.isSystemManaged} so legitimate non-DocKind writers
 * (`CHANGELOG.md` composer, `.cleo/release/*.plan.json` writer, stage
 * artifact composer, RCASD migration tool, etc.) are explicitly registered
 * with an ADR pointer rather than surfacing as a silent SSoT bypass.
 *
 * The T10369 lint gate consumes this map to exempt known artifacts from the
 * "one writer per DocKind" enforcement — anything writing `.md` from inside
 * `packages/core/src/**` that does NOT route through {@link WriterRegistry.write}
 * AND is NOT in {@link SYSTEM_MANAGED_ENTRIES} is a regression.
 *
 * ## canon.yml parity
 *
 * Every descriptor with `mode: 'ssot-first'` MUST match a kind in
 * `.cleo/canon.yml` whose `canonicalHome === 'ssot-first'`. The parity
 * test (`writer-registry.test.ts`) enforces this by loading both the
 * registry and the canon-yml file and asserting one-for-one alignment.
 *
 * @task T10366 (foundation), T10368 (system-managed map)
 * @epic T10290
 * @saga T10288
 * @adr ADR-076 (canon routing), ADR-083 (Cleo persona), ADR-028 (release manifest)
 */

import type { BuiltinDocKind } from '@cleocode/contracts';
import { BUILTIN_DOC_KIND_VALUES } from '@cleocode/contracts';
import { reserveSlug, type SlugReserveResult } from './slug-allocator.js';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Verb classification for a writer descriptor.
 *
 * - `'docs add'`          — the kind is created via `cleo docs add`.
 * - `'changeset add'`     — the kind is created via `cleo changeset add`
 *                            (dual-write to file + SSoT).
 * - `'system-managed'`    — the kind is written by tooling (e.g. release
 *                            composer, llms.txt generator) rather than a
 *                            user-facing CLI verb. `coreFn` is still set
 *                            so downstream code can resolve the producer.
 */
export type WriterVerb = 'docs add' | 'changeset add' | 'system-managed';

/**
 * Routing taxonomy parallel to `.cleo/canon.yml`'s `canonicalHome`.
 *
 * - `'ssot'`            — canonical bytes live ONLY in the blob store.
 * - `'ssot-first'`      — dual-write via a dedicated `cleo` verb; the
 *                          publishMirror is git-tracked by contract.
 * - `'system-managed'`  — written by tooling; SSoT routing is implicit
 *                          (no user-facing routing decision).
 */
export type WriterMode = 'ssot' | 'ssot-first' | 'system-managed';

/**
 * Canonical descriptor for the writer of a single `BuiltinDocKind`.
 *
 * Every field is intentionally a primitive so the descriptor map can be
 * serialised, inspected by drift tooling, and asserted against
 * `.cleo/canon.yml` in tests.
 */
export interface WriterDescriptor {
  /** The DocKind this descriptor governs. */
  readonly kind: BuiltinDocKind;
  /** User-facing CLI verb that writes this kind. */
  readonly verb: WriterVerb;
  /** Dispatch op identifier — matches `<domain>.<op>` in the dispatch layer. */
  readonly dispatchOp: string;
  /**
   * Name of the canonical core function that actually writes the bytes.
   *
   * For `'docs add'` the entry point IS the dispatch handler (no exported
   * core function), so `coreFn` points at the dispatch op shorthand. For
   * `'changeset add'` it points at the core writer
   * ({@link writeChangesetEntry}). For `'system-managed'` it names the
   * producer function (e.g. `generateDocsLlmsTxt`).
   */
  readonly coreFn: string;
  /** Routing mode — parallel to `.cleo/canon.yml`'s `canonicalHome`. */
  readonly mode: WriterMode;
  /** Repo-relative path where the writer code lives. */
  readonly sourcePath: string;
}

/**
 * Result of a {@link WriterRegistry.write} call.
 *
 * Discriminated by `ok`. On failure the `code` field carries the canonical
 * error identifier; `details` is reserved for downstream tasks to attach
 * `suggestions` (slug-collision case) or wrapped writer errors.
 */
export type WriteResult =
  | {
      readonly ok: true;
      readonly attachmentId: string;
      readonly slug: string;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'E_SLUG_RESERVED'
        | 'E_INVALID_KIND'
        | 'E_FILE_WRITE_FAILED'
        | 'E_SSOT_WRITE_FAILED'
        | 'E_NOT_IMPLEMENTED';
      readonly details?: unknown;
    };

/**
 * Payload shape accepted by {@link WriterRegistry.write}.
 *
 * Intentionally permissive — each kind's writer (wired by T10367/T10368)
 * narrows the payload further at the delegation site. The registry only
 * cares about the slug for the allocator handshake; the rest is opaque.
 */
export interface WritePayload {
  readonly slug: string;
  readonly [key: string]: unknown;
}

/**
 * Options forwarded to {@link reserveSlug} (and, downstream, to the actual
 * writer).
 */
export interface WriteOptions {
  /** Optional cwd for `.cleo/` resolution. */
  readonly cwd?: string;
}

/**
 * Argument shape accepted by {@link WriterRegistry.write}.
 */
export interface WriteArgs {
  readonly kind: BuiltinDocKind;
  readonly slug: string;
  readonly payload: WritePayload;
  readonly opts?: WriteOptions;
}

// ─── Custom error thrown by `for(kind)` on multi-writer collision ────────────

/**
 * Programmer-error raised by {@link WriterRegistry.for} when more than one
 * descriptor exists for the same DocKind.
 *
 * Multi-writer collision is the slug-collision class root cause T10294
 * identified. Catching it at registry build time keeps the regression from
 * shipping. Tests assert this is never raised under the built-in map.
 */
export class WriterRegistryCollisionError extends Error {
  /** The DocKind that had more than one descriptor. */
  readonly kind: BuiltinDocKind;

  constructor(kind: BuiltinDocKind, count: number) {
    super(
      `WriterRegistry: kind '${kind}' has ${count} descriptors; ` +
        'exactly one writer per DocKind is required (T10366)',
    );
    this.name = 'WriterRegistryCollisionError';
    this.kind = kind;
  }
}

// ─── Descriptor list (declaration order = test enumeration order) ────────────

/**
 * Canonical descriptor list — exactly ONE entry per `BuiltinDocKind`.
 *
 * Declared as an array so the test suite can detect duplicates by counting
 * occurrences of each kind. {@link WriterRegistry} consumes this and
 * materialises the lookup map.
 *
 * Order matches `BUILTIN_DOC_KINDS` so a diff between the two surfaces is
 * easy to spot. A new kind in {@link
 * '@cleocode/contracts'.BUILTIN_DOC_KINDS} REQUIRES a matching descriptor
 * here — the test suite enforces this by asserting `kinds === values`.
 */
const DESCRIPTORS: ReadonlyArray<WriterDescriptor> = Object.freeze([
  {
    kind: 'adr',
    verb: 'docs add',
    dispatchOp: 'docs.add',
    coreFn: 'docs.add (dispatch handler)',
    mode: 'ssot',
    sourcePath: 'packages/cleo/src/dispatch/domains/docs.ts',
  },
  {
    kind: 'spec',
    verb: 'docs add',
    dispatchOp: 'docs.add',
    coreFn: 'docs.add (dispatch handler)',
    mode: 'ssot',
    sourcePath: 'packages/cleo/src/dispatch/domains/docs.ts',
  },
  {
    kind: 'research',
    verb: 'docs add',
    dispatchOp: 'docs.add',
    coreFn: 'docs.add (dispatch handler)',
    mode: 'ssot',
    sourcePath: 'packages/cleo/src/dispatch/domains/docs.ts',
  },
  {
    kind: 'handoff',
    verb: 'docs add',
    dispatchOp: 'docs.add',
    coreFn: 'docs.add (dispatch handler)',
    mode: 'ssot',
    sourcePath: 'packages/cleo/src/dispatch/domains/docs.ts',
  },
  {
    kind: 'note',
    verb: 'docs add',
    dispatchOp: 'docs.add',
    coreFn: 'docs.add (dispatch handler)',
    mode: 'ssot',
    sourcePath: 'packages/cleo/src/dispatch/domains/docs.ts',
  },
  {
    kind: 'llm-readme',
    verb: 'system-managed',
    dispatchOp: 'docs.generate',
    coreFn: 'generateDocsLlmsTxt',
    mode: 'system-managed',
    sourcePath: 'packages/core/src/docs/docs-generator.ts',
  },
  {
    kind: 'changeset',
    verb: 'changeset add',
    dispatchOp: 'changeset.add',
    coreFn: 'writeChangesetEntry',
    mode: 'ssot-first',
    sourcePath: 'packages/core/src/changesets/writer.ts',
  },
  {
    kind: 'release-note',
    verb: 'system-managed',
    dispatchOp: 'release.reconcile',
    coreFn: 'composeReleaseNotes',
    mode: 'system-managed',
    sourcePath: 'packages/core/src/release/reconcile.ts',
  },
  {
    kind: 'plan',
    verb: 'docs add',
    dispatchOp: 'docs.add',
    coreFn: 'docs.add (dispatch handler)',
    mode: 'ssot',
    sourcePath: 'packages/cleo/src/dispatch/domains/docs.ts',
  },
  {
    kind: 'rcasd',
    verb: 'docs add',
    dispatchOp: 'docs.add',
    coreFn: 'docs.add (dispatch handler)',
    mode: 'ssot',
    sourcePath: 'packages/cleo/src/dispatch/domains/docs.ts',
  },
]);

// ─── System-managed exemption map (T10368) ────────────────────────────────────

/**
 * One entry per legitimate non-DocKind writer that emits `.md` (or other
 * canonical artifact bytes) from inside `packages/core/src/**`.
 *
 * Each entry MUST cite an ADR that ratifies the bypass. T10369's lint gate
 * walks the repo looking for `.md` writers, cross-references this map, and
 * fails the build for any uncited new writer.
 *
 * The {@link relativePathGlob} field is a project-root-relative glob (NOT a
 * regex). The lint script normalises both sides through the same matcher,
 * so trailing slashes and `**` segments work as in `.gitignore`.
 *
 * @task T10368
 */
export interface SystemManagedEntry {
  /** Short identifier — used in log lines + lint output. */
  readonly id: string;
  /** Closest matching BuiltinDocKind, OR `null` when the artifact isn't a DocKind. */
  readonly kind: BuiltinDocKind | null;
  /** Glob (project-root-relative) of the file path(s) this writer produces. */
  readonly relativePathGlob: string;
  /** Repo-relative source file containing the writer call. */
  readonly sourcePath: string;
  /** Specific call site (path:line) for at-a-glance grep targeting. */
  readonly callsite: string;
  /** ADR pointer that ratifies the SSoT bypass. */
  readonly adrRef: string;
  /** Free-form reason — surfaced by the lint script on failure. */
  readonly reason: string;
}

/**
 * Canonical list of T10368-audited system-managed writers.
 *
 * Maintenance contract:
 *   - Adding a NEW `.md` writer in `packages/core/src/**` requires either
 *     routing it through {@link WriterRegistry.write} OR appending an entry
 *     here with an ADR pointer.
 *   - Removing an entry requires removing the matching writer (or rerouting
 *     it through `WriterRegistry.write`).
 *
 * Audit table reference: see T10368 PR description for the full classification
 * of every `writeFileSync(*.md)` callsite in `packages/core/src/**`.
 *
 * @task T10368
 */
const SYSTEM_MANAGED_ENTRIES: ReadonlyArray<SystemManagedEntry> = Object.freeze([
  {
    id: 'release.plan-json',
    kind: null,
    relativePathGlob: '.cleo/release/*.plan.json',
    sourcePath: 'packages/core/src/release/plan.ts',
    callsite: 'packages/core/src/release/plan.ts:writePlanFile',
    adrRef: 'ADR-028 (release manifest format)',
    reason:
      'Release Plan envelopes are JSON not Markdown and live alongside the DB ' +
      'releases row by design. Writer is the single composer; no DocKind binding.',
  },
  {
    id: 'release.changelog',
    kind: 'release-note',
    relativePathGlob: 'CHANGELOG.md',
    sourcePath: 'packages/core/src/release/plan.ts',
    callsite: 'packages/core/src/release/plan.ts:writeChangelogSection',
    adrRef: 'ADR-028 §2.5 (CHANGELOG composer)',
    reason:
      'CHANGELOG.md is composed from aggregated changesets at release-plan time. ' +
      'The descriptor for `release-note` already marks the kind as system-managed; ' +
      'this entry pins the exact callsite for the lint gate.',
  },
  {
    id: 'lifecycle.rcasd-migration',
    kind: 'rcasd',
    relativePathGlob: '.cleo/rcasd/**/*.md',
    sourcePath: 'packages/core/src/lifecycle/consolidate-rcasd.ts',
    callsite: 'packages/core/src/lifecycle/consolidate-rcasd.ts:moveWithFrontmatter',
    adrRef: 'ADR-076 (canon routing — migration tooling exemption)',
    reason:
      'RCASD consolidation tool moves pre-existing rcasd `.md` files between ' +
      'on-disk layouts and re-injects frontmatter. Not a new authoring path — ' +
      'a migration helper for files already on disk.',
  },
  {
    id: 'lifecycle.stage-artifact',
    kind: 'rcasd',
    relativePathGlob: '.cleo/stages/*/*-*.md',
    sourcePath: 'packages/core/src/lifecycle/stage-artifacts.ts',
    callsite: 'packages/core/src/lifecycle/stage-artifacts.ts:ensureStageArtifact',
    adrRef: 'ADR-076 (canon routing — stage artifact composer)',
    reason:
      'Stage artifacts are composed deterministically from epic id + stage. ' +
      'Authoring is by the lifecycle engine, not the user — no DocKind slug.',
  },
  {
    id: 'sessions.handoff-markdown',
    kind: 'handoff',
    relativePathGlob: '**/*-handoff*.md',
    sourcePath: 'packages/core/src/sessions/handoff-markdown.ts',
    callsite: 'packages/core/src/sessions/handoff-markdown.ts:emitHandoffMarkdown',
    adrRef: 'ADR-076 (canon routing — handoff renderer)',
    reason:
      'Pure markdown renderer for the handoff envelope. Callers that want a ' +
      'canonical SSoT-tracked handoff use `cleo docs add --type handoff` ' +
      '(which uses this renderer internally). The renderer itself does not ' +
      'create a DocKind row.',
  },
  {
    id: 'nexus.wiki-overview',
    kind: null,
    relativePathGlob: '**/nexus/wiki/**/*.md',
    sourcePath: 'packages/core/src/nexus/wiki-index.ts',
    callsite: 'packages/core/src/nexus/wiki-index.ts:rebuildWikiIndex',
    adrRef: 'ADR-076 (canon routing — nexus wiki is not a DocKind)',
    reason:
      'Nexus wiki overview + community pages are derived artifacts of the ' +
      'nexus graph; they are regenerated on every wiki rebuild and are not ' +
      'a DocKind in the canon registry.',
  },
  {
    id: 'docs.publish-mirror',
    kind: null,
    relativePathGlob: 'docs/**/*.md',
    sourcePath: 'packages/core/src/docs/publish-pr.ts',
    callsite: 'packages/core/src/docs/publish-pr.ts:writePublishMirror',
    adrRef: 'ADR-076 (canon routing — publish mirror)',
    reason:
      'publishMirror writes are the canon-routed copy step (the second half ' +
      'of `cleo docs publish`). They consume bytes that ALREADY routed through ' +
      'the SSoT via `cleo docs add` — pinned here so the lint gate skips them.',
  },
  {
    id: 'bootstrap.global-agents-md',
    kind: null,
    relativePathGlob: '**/.agents/AGENTS.md',
    sourcePath: 'packages/core/src/bootstrap.ts',
    callsite: 'packages/core/src/bootstrap.ts:bootstrap (sanitize CAAMP)',
    adrRef: 'ADR-076 (canon routing — global bootstrap is not a DocKind)',
    reason:
      'Bootstrap sanitizes the global `~/.agents/AGENTS.md` hub (strips legacy ' +
      '<!-- CLEO:START --> blocks + CAAMP corruption). Not a DocKind authoring ' +
      'path — it mutates a user-owned global config file in place during init.',
  },
  {
    id: 'init.pr-template',
    kind: null,
    relativePathGlob: '.github/pull_request_template.md',
    sourcePath: 'packages/core/src/init.ts',
    callsite: 'packages/core/src/init.ts:installGithubTemplates',
    adrRef: 'ADR-076 (canon routing — github scaffolding is not a DocKind)',
    reason:
      '`cleo init` copies the bundled pull_request_template.md into the host ' +
      'project `.github/` directory. Authoring is by the init scaffolder (the ' +
      'template ships in the npm package) — no user-facing slug, no DocKind row.',
  },
  {
    id: 'injection.global-cleo-injection',
    kind: null,
    relativePathGlob: '**/.cleo/templates/CLEO-INJECTION.md',
    sourcePath: 'packages/core/src/injection.ts',
    callsite: 'packages/core/src/injection.ts:installGlobalCleoInjection',
    adrRef: 'ADR-076 (canon routing — global protocol injection is not a DocKind)',
    reason:
      'Installs the bundled `CLEO-INJECTION.md` protocol template into the ' +
      'global `<cleoHome>/templates/` directory. Bytes are vendored in the npm ' +
      'package — the install step is deterministic and idempotent, not a ' +
      'DocKind authoring path.',
  },
]);

/**
 * Convert a glob pattern into a RegExp. Supports `*` (segment-internal) and
 * `**` (cross-segment). Used by {@link WriterRegistry.isSystemManaged} to
 * match repo-relative paths against the registered globs.
 *
 * @internal
 * @task T10368
 */
function globToRegExp(glob: string): RegExp {
  // Escape regex special chars except `*` and `?`.
  let body = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const next = glob[i + 1];
    if (c === '*' && next === '*') {
      body += '.*';
      i++; // consume second '*'
    } else if (c === '*') {
      body += '[^/]*';
    } else if (c === '?') {
      body += '.';
    } else if (c !== undefined && /[.+^${}()|[\]\\]/.test(c)) {
      body += `\\${c}`;
    } else {
      body += c ?? '';
    }
  }
  return new RegExp(`^${body}$`);
}

// ─── Registry class ───────────────────────────────────────────────────────────

/**
 * Central registry mapping every `BuiltinDocKind` to its canonical writer.
 *
 * Static-only — there is exactly ONE registry per process. Tests that need
 * to inspect descriptors use {@link WriterRegistry.list} (read-only). The
 * static-class shape is deliberate: callers reach it as
 * `WriterRegistry.for(kind)` mirroring `DocKindRegistry` in
 * `@cleocode/contracts`, and the lazy `descriptors` field gives us a
 * compile-time anchor for the collision check (runs once at module load).
 *
 * @task T10366
 */
// biome-ignore lint/complexity/noStaticOnlyClass: matches DocKindRegistry shape; static-readonly map runs the collision check at module load so a regression trips dev/CI immediately. A standalone-function form would lose the "registry as a typed namespace" affordance callers already use.
export class WriterRegistry {
  /**
   * Internal lookup map. Built once at module load from {@link DESCRIPTORS}
   * via {@link WriterRegistry.buildDescriptorMap}. Multi-writer collisions
   * raise {@link WriterRegistryCollisionError} at build time.
   *
   * @internal
   */
  private static readonly descriptors: ReadonlyMap<BuiltinDocKind, WriterDescriptor> =
    WriterRegistry.buildDescriptorMap();

  /**
   * Build the lookup map from {@link DESCRIPTORS}, asserting uniqueness.
   *
   * @internal
   */
  private static buildDescriptorMap(): ReadonlyMap<BuiltinDocKind, WriterDescriptor> {
    const counts = new Map<BuiltinDocKind, number>();
    for (const desc of DESCRIPTORS) {
      counts.set(desc.kind, (counts.get(desc.kind) ?? 0) + 1);
    }
    for (const [kind, count] of counts) {
      if (count > 1) {
        throw new WriterRegistryCollisionError(kind, count);
      }
    }
    const map = new Map<BuiltinDocKind, WriterDescriptor>();
    for (const desc of DESCRIPTORS) {
      map.set(desc.kind, desc);
    }
    return map;
  }

  /**
   * Look up the writer descriptor for a given DocKind.
   *
   * @throws Error with code `E_INVALID_KIND` when `kind` is not registered.
   */
  static for(kind: BuiltinDocKind): WriterDescriptor {
    const desc = WriterRegistry.descriptors.get(kind);
    if (!desc) {
      throw new Error(`E_INVALID_KIND: no writer registered for DocKind '${kind}'`);
    }
    return desc;
  }

  /**
   * Read-only view of every registered descriptor (declaration order).
   *
   * Used by tests + drift tooling — never mutate the result. Built-in
   * kinds always sort in the order declared by `BUILTIN_DOC_KINDS`.
   */
  static list(): ReadonlyArray<WriterDescriptor> {
    return DESCRIPTORS;
  }

  /**
   * Confirm the registry holds exactly one descriptor per `BuiltinDocKind`.
   *
   * Tests assert this as a fast smoke check. Returns the offending kind on
   * collision (the build-time constructor would have thrown earlier, but the
   * static helper keeps the test surface friendly).
   */
  static validateNoCollisions():
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly kind: BuiltinDocKind;
        readonly count: number;
      } {
    const counts = new Map<BuiltinDocKind, number>();
    for (const desc of DESCRIPTORS) {
      counts.set(desc.kind, (counts.get(desc.kind) ?? 0) + 1);
    }
    for (const [kind, count] of counts) {
      if (count > 1) return { ok: false, kind, count };
    }
    return { ok: true };
  }

  /**
   * True when every `BuiltinDocKind` from
   * {@link BUILTIN_DOC_KIND_VALUES} has a descriptor.
   *
   * Used by the parity test to fail-fast when a new kind is added to
   * `BUILTIN_DOC_KINDS` without a matching writer descriptor.
   */
  static hasCompleteCoverage(): boolean {
    const registered = new Set(DESCRIPTORS.map((d) => d.kind));
    for (const kind of BUILTIN_DOC_KIND_VALUES) {
      if (!registered.has(kind as BuiltinDocKind)) return false;
    }
    return true;
  }

  /**
   * Read-only view of every system-managed entry (T10368).
   *
   * Consumed by the T10369 lint gate to exempt known artifacts from the
   * "one writer per DocKind" enforcement.
   */
  static listSystemManaged(): ReadonlyArray<SystemManagedEntry> {
    return SYSTEM_MANAGED_ENTRIES;
  }

  /**
   * Match a project-root-relative path against every registered
   * {@link SystemManagedEntry} glob and return the FIRST hit (or `null` when
   * no entry matches).
   *
   * The lint gate calls this for every `.md` writer call site discovered in
   * `packages/core/src/**`; a `null` return means the writer is uncited and
   * must either route through {@link WriterRegistry.write} or get a new
   * entry in {@link SYSTEM_MANAGED_ENTRIES}.
   *
   * Matching is glob-based (see {@link globToRegExp}). Paths are normalised
   * to forward slashes for cross-platform consistency.
   *
   * @task T10368
   */
  static isSystemManaged(relativePath: string): SystemManagedEntry | null {
    const normalised = relativePath.replace(/\\/g, '/');
    for (const entry of SYSTEM_MANAGED_ENTRIES) {
      const re = globToRegExp(entry.relativePathGlob);
      if (re.test(normalised)) {
        return entry;
      }
    }
    return null;
  }

  /**
   * Lookup helper — find the system-managed entry by its `id` field.
   *
   * Useful for refactored writers that want to emit a routing log line
   * citing the registry entry without re-parsing the glob.
   *
   * @task T10368
   */
  static findSystemManagedById(id: string): SystemManagedEntry | null {
    for (const entry of SYSTEM_MANAGED_ENTRIES) {
      if (entry.id === id) return entry;
    }
    return null;
  }

  /**
   * Foundation entry point for the unified write contract.
   *
   * T10366 (this task) wires the slug-allocator handshake; T10367 +
   * T10368 layer in the actual writer delegation. Behaviour today:
   *
   *   1. Look up the descriptor for `args.kind` — `E_INVALID_KIND` on miss.
   *   2. Call {@link reserveSlug} — `E_SLUG_RESERVED` propagates on conflict.
   *   3. Return `E_NOT_IMPLEMENTED` with the descriptor so downstream tasks
   *      can prove the registry was consulted.
   *
   * Once T10367/T10368 wire delegation the `E_NOT_IMPLEMENTED` branch is
   * replaced by an actual writer dispatch — the public signature stays
   * unchanged.
   *
   * @param args - The kind, slug, payload, and optional cwd.
   * @returns Discriminated `WriteResult`.
   */
  static async write(args: WriteArgs): Promise<WriteResult> {
    // 1. Resolve the descriptor (throws on unknown kind).
    let descriptor: WriterDescriptor;
    try {
      descriptor = WriterRegistry.for(args.kind);
    } catch {
      return { ok: false, code: 'E_INVALID_KIND', details: { kind: args.kind } };
    }

    // 2. Reserve the slug through the T10392 chokepoint.
    const reservation: SlugReserveResult = await reserveSlug(args.kind, args.slug, args.opts);
    if (!reservation.ok) {
      return {
        ok: false,
        code: 'E_SLUG_RESERVED',
        details: { suggestions: reservation.suggestions },
      };
    }

    // 3. Delegation placeholder — downstream tasks (T10367/T10368) replace
    // this branch with the actual writer dispatch. The descriptor is
    // surfaced so callers can verify the registry was consulted, and the
    // reserved slug is returned via `details` so the caller's release path
    // can call `releaseReservedSlug` if it decides to abort.
    return {
      ok: false,
      code: 'E_NOT_IMPLEMENTED',
      details: {
        message:
          'WriterRegistry.write is a foundation entry point — actual writer ' +
          'delegation lands in T10367 (docs add) and T10368 (changeset add).',
        descriptor,
        normalizedSlug: reservation.normalizedSlug,
      },
    };
  }
}
