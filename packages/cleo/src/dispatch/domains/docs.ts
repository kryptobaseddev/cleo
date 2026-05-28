/**
 * Docs Domain Handler (Dispatch Layer)
 *
 * Handles attachment management operations exposed via `cleo docs`:
 *   - add    — attach a local file or URL to a CLEO owner entity
 *   - list   — list attachments for an owner entity
 *   - fetch  — retrieve attachment bytes and metadata by ID or SHA-256
 *   - remove — remove an attachment ref; purges blob when refCount hits zero
 *
 * All storage delegates to `AttachmentStore` from `@cleocode/core/internal`.
 * Owner type is auto-detected from the owner ID prefix:
 *   T###        → 'task'
 *   ses_*       → 'session'
 *   O-*         → 'observation'
 *   (default)   → 'task'
 *
 * Type-safe dispatch via `TypedDomainHandler<DocsTypedOps>` per ADR-058.
 * Param extraction uses manually-wired `DocsTypedOps` (not OpsFromCore —
 * docs operations delegate directly to store methods, not Core functions).
 * Zero `as string` / `as any` param casts at call sites.
 *
 * `attachmentBackend` is included in typed result payloads and lifted into
 * `meta` by the envelope-to-response converter for backward compatibility
 * with T947 Wave B observability consumers.
 *
 * @epic T760
 * @task T797
 * @see ADR-058 — Dispatch type inference
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DocAttachmentObservationPayload } from '@cleocode/contracts';
import { DocKindRegistry } from '@cleocode/contracts';
import type {
  DocsAddParams,
  DocsAddResult,
  DocsFetchParams,
  DocsFetchResult,
  DocsGenerateParams,
  DocsGenerateResult,
  DocsListOrderBy,
  DocsListParams,
  DocsListResult,
  DocsLlmOutputParams,
  DocsLlmOutputResult,
  DocsRemoveParams,
  DocsRemoveResult,
  DocsSupersedeParams,
  DocsSupersedeResult,
  DocsType,
  DocsUpdateParams,
  DocsUpdateResult,
  LlmOutputMode,
} from '@cleocode/contracts/operations/docs';
import { LLM_OUTPUT_MODES } from '@cleocode/contracts/operations/docs';
import { pushWarning } from '@cleocode/core';
import type {
  AttachmentRef,
  ExportDocumentOptions,
  LlmsTxtAttachment,
  LocalFileAttachment,
  UrlAttachment,
} from '@cleocode/core/internal';
import {
  type AttachmentBackend,
  AUTO_TOKEN,
  allocateAdrSlug,
  allocateAutoSlugForDispatch,
  consumeReservedSlug,
  createAttachmentBlobStore,
  createAttachmentStore,
  createAttachmentStoreDocsAccessor,
  createDocsReadModel,
  type DerefResult,
  DOCS_UPDATE_LIFECYCLE_STATUS_LIST,
  exportDocument,
  findSimilarDocs,
  generateDocsLlmsTxt,
  getProjectRoot,
  isLifecycleStatus,
  listDocVersions,
  makeClassifierForScanRoot,
  memoryObserve,
  mergeDocs,
  parseChangesetFrontmatter,
  publishDocs,
  publishDocsAsPr,
  rankDocs,
  recordPublication,
  releaseReservedSlug,
  reserveSlugForDispatch,
  resolveAttachmentBackend,
  resolveCanonicalCleoDir,
  resolveProjectByCwd,
  runDocsImport,
  SlugCollisionError,
  SUPERSEDE_NOT_FOUND_CODE,
  SUPERSEDE_SAME_SLUG_CODE,
  searchAllProjectDocs,
  searchDocs,
  supersedeDoc,
  syncFromGit,
  updateDocBySlug,
  validateDocBody,
  writeAuditEntry,
  writeChangesetEntry,
} from '@cleocode/core/internal';
import { defineTypedHandler, lafsError, lafsSuccess, typedDispatch } from '../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { handleErrorResult, unsupportedOp } from './_base.js';
import { dispatchMeta } from './_meta.js';

/**
 * Local mirror of `DOCS_LIST_DEFAULT_LIMIT` from `@cleocode/contracts`.
 *
 * Inlined to avoid promoting the contracts subpath import to runtime — the
 * cleo package's vitest config aliases only the bare `@cleocode/contracts`
 * specifier (subpath imports rely on the workspace symlink). Keeping every
 * cross-package symbol used inside this file type-only side-steps that
 * resolution path. The value MUST stay in sync with the contracts export
 * (validated by the docs-list-ux tests asserting `data.limit === 50` in
 * the default case).
 *
 * @task T9792
 */
const DOCS_LIST_DEFAULT_LIMIT = 50;

/**
 * T11062 — Slug collision agent-facing guidance (E_SLUG_RESERVED envelope).
 */
const SLUG_COLLISION_GUIDANCE = `slug '{slug}' is already reserved in this project. Three ways to proceed:

  1. Update the existing document:  cleo docs update {slug} [--file <path> | --content <text>]
  2. Use a different slug:          cleo docs add <owner> <file> --slug <alternative>
  3. Supersede with a new slug:      cleo docs supersede {slug} <new-slug>

Recovery command: cleo docs update {slug} --file <your-file>`;

/**
 * Canonical doc-kind registry — single source of truth for the user-facing
 * taxonomy (built-ins + `.cleo/docs-config.json` extensions).
 *
 * Loaded lazily so we pick up extensions on every CLI invocation without
 * paying the cost up-front during module init. Resolution caches the
 * registry per `projectRoot` so repeated calls within one CLI run are free.
 *
 * @task T9788 (E-DOCS-TAXONOMY-V2)
 */
const _registryCache = new Map<string, DocKindRegistry>();

function getDocKindRegistry(): DocKindRegistry {
  const root = getProjectRoot();
  const cached = _registryCache.get(root);
  if (cached) return cached;
  try {
    const registry = DocKindRegistry.load(root);
    _registryCache.set(root, registry);
    return registry;
  } catch {
    // Malformed config falls back to built-ins so a single bad file
    // never breaks `cleo docs *` entirely. The schema CLI surfaces
    // the parse error separately so operators can fix it.
    const fallback = DocKindRegistry.builtinOnly();
    _registryCache.set(root, fallback);
    return fallback;
  }
}

/**
 * Snapshot of registered kind names for runtime validation.
 *
 * Includes both built-ins and project-level extensions. Recomputed once
 * per registry load (cache invalidates with the registry itself).
 *
 * @task T9788
 */
function registeredKindValues(): readonly string[] {
  return getDocKindRegistry()
    .list()
    .map((d) => d.kind);
}

async function currentAttachmentBackend(): Promise<AttachmentBackend> {
  return resolveAttachmentBackend();
}

function exportTaskDocument(options: ExportDocumentOptions) {
  return exportDocument(options);
}

// ─── DocsTypedOps ─────────────────────────────────────────────────────────────

/**
 * Manually-wired `TypedOpRecord` for the docs domain.
 *
 * Uses contracts types directly (not OpsFromCore — docs operations delegate
 * to store methods rather than Core functions). Each entry is `[Params, Result]`.
 *
 * Result types carry an optional `attachmentBackend` field which the
 * envelope-to-response converter lifts from `data` into `meta` for
 * backward compatibility with T947 Wave B observability consumers.
 *
 * @see packages/contracts/src/operations/docs.ts
 * @task T1529 — ADR-058 typed-dispatch migration
 */
type DocsTypedOps = {
  readonly list: readonly [DocsListParams, DocsListResult];
  readonly fetch: readonly [DocsFetchParams, DocsFetchResult];
  readonly generate: readonly [DocsGenerateParams, DocsGenerateResult];
  readonly 'llm-output': readonly [DocsLlmOutputParams, DocsLlmOutputResult];
  readonly add: readonly [DocsAddParams, DocsAddResult];
  readonly remove: readonly [DocsRemoveParams, DocsRemoveResult];
  readonly update: readonly [DocsUpdateParams, DocsUpdateResult];
  readonly supersede: readonly [DocsSupersedeParams, DocsSupersedeResult];
};

// ─── Owner type inference ─────────────────────────────────────────────────────

/**
 * Infer the {@link AttachmentRef.ownerType} from an owner ID string.
 *
 * Heuristics:
 *   `T<digits>`  → 'task'
 *   `ses_`       → 'session'
 *   `O-`         → 'observation'
 *   (fallback)   → 'task'
 *
 * @param ownerId - Raw owner entity ID string
 */
function inferOwnerType(ownerId: string): AttachmentRef['ownerType'] {
  if (/^T\d+$/i.test(ownerId)) return 'task';
  if (ownerId.startsWith('ses_')) return 'session';
  if (ownerId.startsWith('O-')) return 'observation';
  // Broader prefixes for other BRAIN entity types
  if (ownerId.startsWith('D-') || ownerId.startsWith('dec_')) return 'decision';
  if (ownerId.startsWith('L-') || ownerId.startsWith('lrn_')) return 'learning';
  if (ownerId.startsWith('P-') || ownerId.startsWith('pat_')) return 'pattern';
  return 'task';
}

/**
 * Parse a raw labels string (comma-separated) into a string array.
 *
 * @param raw - Comma-separated label string or undefined
 */
function parseLabels(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  return raw
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Detect MIME type from a file extension.
 *
 * Minimal set — falls back to 'application/octet-stream'.
 *
 * @param filePath - Absolute or relative path to the file
 */
function mimeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'text/plain';
  if (lower.endsWith('.js')) return 'text/javascript';
  if (lower.endsWith('.css')) return 'text/css';
  return 'application/octet-stream';
}

// ─── Slug helpers (T9636) ────────────────────────────────────────────────────

/**
 * Slug validation: lowercase, kebab-case, 1–80 chars, no leading/trailing dash.
 *
 * @task T9636
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SLUG_MAX_LEN = 80;

/**
 * Validate a slug string against {@link SLUG_PATTERN}.
 *
 * @returns `{ valid: true }` when the slug matches; `{ valid: false, reason }`
 *   carrying a human-readable error otherwise.
 */
function validateSlug(raw: unknown): { valid: false; reason: string } | { valid: true } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { valid: false, reason: 'slug must be a non-empty string' };
  }
  if (raw.length > SLUG_MAX_LEN) {
    return { valid: false, reason: `slug exceeds ${SLUG_MAX_LEN} characters` };
  }
  if (!SLUG_PATTERN.test(raw)) {
    return {
      valid: false,
      reason:
        "slug must be lowercase kebab-case (matches /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) — got '" +
        raw +
        "'",
    };
  }
  return { valid: true };
}

/**
 * Validate a type value against the canonical {@link DocKindRegistry}.
 *
 * As of T9788 accepts every registered kind — built-in OR project-level
 * extension — so a custom kind declared in `.cleo/docs-config.json`
 * (e.g. `incident`) works seamlessly with `cleo docs add --type incident`.
 *
 * The type guard still narrows to {@link DocsType} (the built-in union)
 * because extensions cannot widen a compile-time union; runtime callers
 * that hit an extension kind get the runtime acceptance plus a stored
 * string field that downstream consumers read as a plain string.
 *
 * @task T9637
 * @task T9788
 */
function validateDocsType(raw: unknown): raw is DocsType {
  if (typeof raw !== 'string') return false;
  return getDocKindRegistry().has(raw);
}

/**
 * Build the human-readable list of registered kinds for error messages.
 *
 * @task T9788
 */
function registeredKindList(): string {
  return registeredKindValues().join('|');
}

/**
 * Normalise the orderBy value coming from raw params.
 *
 * Accepts the canonical {@link DocsListOrderBy} keys and falls back to
 * `'newest'` on any other input so an out-of-range value never poisons the
 * envelope. The CLI flag validation rejects out-of-range values up front, so
 * this is a defence-in-depth normaliser.
 *
 * @task T9792
 */
function normaliseOrderBy(raw: unknown): DocsListOrderBy {
  if (raw === 'sha' || raw === 'slug' || raw === 'newest') return raw;
  return 'newest';
}

/**
 * Resolve the effective row limit for `docs.list`.
 *
 * Returns `Number.POSITIVE_INFINITY` when the caller explicitly opted into
 * "no limit" with `limit <= 0`. This sentinel keeps the slice + truncation
 * branches unified without per-call special-cases.
 *
 * @task T9792
 */
function resolveListLimit(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw <= 0) return Number.POSITIVE_INFINITY;
    return Math.floor(raw);
  }
  return DOCS_LIST_DEFAULT_LIMIT;
}

/**
 * Comparator factories for the supported {@link DocsListOrderBy} keys.
 *
 * Each comparator works against the flat wire-format row produced by the
 * docs.list handler — slug-less rows sort AFTER slug-bearing ones so the
 * `slug` ordering produces a stable, agent-friendly listing.
 *
 * @task T9792
 */
function compareByOrderBy(
  orderBy: DocsListOrderBy,
): (a: { sha256: string; slug?: string; createdAt: string }, b: typeof a) => number {
  if (orderBy === 'sha') return (a, b) => a.sha256.localeCompare(b.sha256);
  if (orderBy === 'slug') {
    return (a, b) => {
      const left = a.slug ?? '';
      const right = b.slug ?? '';
      if (!left && right) return 1;
      if (left && !right) return -1;
      return left.localeCompare(right);
    };
  }
  // newest — descending by createdAt (ISO 8601 lexicographic == chronological)
  return (a, b) => b.createdAt.localeCompare(a.createdAt);
}

// ─── Doc-attachment memory observation helper (T9976) ─────────────────────────

/**
 * Build the observation title for a doc-attachment memory entry.
 *
 * Uses the slug when available (human-readable, FTS-searchable) or falls
 * back to the attachment ID so the entry is always addressable.
 *
 * @param slug         - Slug recorded for the attachment, if any.
 * @param attachmentId - Fallback attachment ID.
 */
function docObservationTitle(slug: string | undefined, attachmentId: string): string {
  return `Doc attached: ${slug ?? attachmentId}`;
}

/**
 * Emit a memory observation for a successful `docs.add` operation.
 *
 * The observation is fire-and-forget — a failure to write to brain.db
 * MUST NOT fail the docs add operation. The structured payload stored
 * in the narrative allows `cleo memory verify` to round-trip against
 * the docs store.
 *
 * The title `"Doc attached: <slug|attachmentId>"` lands in the FTS
 * index so `cleo memory find '<slug>'` surfaces the entry.
 *
 * @param payload - Structured doc-attachment payload (T9976).
 * @param projectRoot - Project root path for brain.db resolution.
 *
 * @task T9976
 */
function emitDocAttachmentObservation(
  payload: DocAttachmentObservationPayload,
  projectRoot: string,
): void {
  const title = docObservationTitle(payload.slug, payload.attachmentId);
  const narrative = JSON.stringify(payload);
  // Fire-and-forget — never await, never throw from the caller.
  // `_skipGate: true` bypasses the dedup extraction-gate (unique structured payload).
  // `sourceType: 'manual'` is intentional: avoids the mental-model queue (which
  // has a 5-second flush interval) by NOT setting `agent`. The mental-model queue
  // is only entered when `isMentalModelObservation` returns true, which requires
  // both a recognized type (feature/discovery/etc.) AND an agent name. Using
  // `sourceType: 'manual'` writes synchronously via `observeBrain`.
  memoryObserve(
    {
      text: narrative,
      title,
      type: 'feature',
      sourceType: 'manual',
    },
    projectRoot,
  ).catch(() => {
    /* Best-effort — never fail docs add on brain.db write errors. */
  });
}

// ─── Typed inner handler ──────────────────────────────────────────────────────

/**
 * Typed inner handler for the docs domain.
 *
 * All per-op logic lives here with fully-narrowed params (no `as string` casts).
 * The outer {@link DocsHandler} class delegates to this via `typedDispatch` +
 * {@link docsEnvelopeToResponse} so the registry sees the expected
 * `query`/`mutate` interface while every param access is type-safe.
 *
 * @see ADR-058 — typed-dispatch migration
 * @task T1529 — docs typed-dispatch migration (P0)
 */
const _docsTypedHandler = defineTypedHandler<DocsTypedOps>('docs', {
  // ── docs.list ──────────────────────────────────────────────────────────────

  list: async (params) => {
    // SSoT-EXEMPT:dispatch-normalize — docs.list accepts three aliased owner params;
    // normalization to ownerId is a docs-domain concern, not a Core concern.
    const ownerId = params.task ?? params.session ?? params.observation;
    // T9792 — when no owner scope is provided, auto-promote to project scope
    // (was: E_INVALID_INPUT). The CLI layer surfaces a hint when this default
    // kicks in so agents notice that a narrower flag may have been intended.
    const explicitProject = params.project === true;
    const isProjectScope = explicitProject || !ownerId;

    // Validate `--type` filter if provided (T9637).
    let typeFilter: DocsType | undefined;
    if (params.type !== undefined) {
      if (!validateDocsType(params.type)) {
        return lafsError(
          'E_INVALID_TYPE',
          `type must be one of: ${registeredKindList()} — got '${String(params.type)}'`,
          'list',
        );
      }
      typeFilter = params.type;
    }

    // T9792 — resolve browsing window + sort key. Both fields are mirrored
    // into the result envelope so consumers can paginate without re-deriving
    // the default. `Number.POSITIVE_INFINITY` is the "no limit" sentinel.
    const effectiveLimit = resolveListLimit(params.limit);
    const orderBy = normaliseOrderBy(params.orderBy);
    const comparator = compareByOrderBy(orderBy);

    // T9792 — surface a one-line hint when the auto-promote kicked in or
    // when the limit truncated the result set, so the JSON envelope tells
    // agents how to narrow / widen the next call.
    const autoPromoted = isProjectScope && !explicitProject;
    const hintParts: string[] = [];
    if (autoPromoted) {
      hintParts.push(
        'no scope set — defaulted to --project. Pass --task <id>, --session <id>, ' +
          'or --observation <id> for a narrower listing.',
      );
    }

    // T11050 — route list through the canonical DocsReadModel
    const model = createDocsReadModel();
    const backend: AttachmentBackend = await currentAttachmentBackend();

    if (isProjectScope) {
      // Project-scoped: use the read model's listProjectDocs
      const docs = await model.listProjectDocs({
        kind: typeFilter,
        limit: Number.isFinite(effectiveLimit) ? effectiveLimit : undefined,
      });

      const totalCount = docs.length;

      // Build the wire projection from ResolvedDoc[] — match DocsListResult shape
      const projected = docs.map((doc) => ({
        id: doc.id,
        sha256: `${doc.sha256.slice(0, 8)}…`,
        _sortSha: doc.sha256,
        kind: 'blob' as const,
        mime: doc.mimeType ?? '—',
        size: doc.sizeBytes,
        description: undefined,
        labels: undefined,
        createdAt: doc.createdAt,
        refCount: 0,
        ...(doc.slug ? { slug: doc.slug } : {}),
        ...(doc.kind ? { type: doc.kind as DocsType } : {}),
        ownerId: doc.ownerId,
        ownerType: doc.ownerType as AttachmentRef['ownerType'],
      }));

      projected.sort((a, b) =>
        comparator(
          { sha256: a._sortSha, slug: a.slug, createdAt: a.createdAt },
          { sha256: b._sortSha, slug: b.slug, createdAt: b.createdAt },
        ),
      );

      const truncated = totalCount > projected.length;
      if (truncated) {
        hintParts.push(
          `showing ${projected.length} of ${totalCount} — pass --limit <N> to widen or page further.`,
        );
      }

      return lafsSuccess<DocsListResult>(
        {
          ownerId: '',
          ownerType: 'task',
          project: true,
          ...(typeFilter !== undefined ? { type: typeFilter } : {}),
          count: projected.length,
          ...(truncated ? { totalCount } : {}),
          limit: Number.isFinite(effectiveLimit) ? effectiveLimit : 0,
          orderBy,
          ...(hintParts.length > 0 ? { hint: hintParts.join(' ') } : {}),
          attachments: projected.map(({ _sortSha: _drop, ...row }) => row),
          attachmentBackend: backend as DocsListResult['attachmentBackend'],
        },
        'list',
      );
    }

    // Owner-scoped: use the read model's resolveByOwner
    const scopedOwner = ownerId as string;
    const ownerType = inferOwnerType(scopedOwner);

    const ownerDocs = await model.resolveByOwner(scopedOwner, { ownerType, kind: typeFilter });

    const projectedOwner = ownerDocs.map((doc) => ({
      id: doc.id,
      sha256: `${doc.sha256.slice(0, 8)}…`,
      _sortSha: doc.sha256,
      kind: 'blob' as const,
      mime: doc.mimeType ?? '—',
      size: doc.sizeBytes,
      description: undefined,
      labels: undefined,
      createdAt: doc.createdAt,
      refCount: 0,
      ...(doc.slug ? { slug: doc.slug } : {}),
      ...(doc.kind ? { type: doc.kind as DocsType } : {}),
    }));

    projectedOwner.sort((a, b) =>
      comparator(
        { sha256: a._sortSha, slug: a.slug, createdAt: a.createdAt },
        { sha256: b._sortSha, slug: b.slug, createdAt: b.createdAt },
      ),
    );

    const totalCountOwner = projectedOwner.length;
    const slicedOwner = Number.isFinite(effectiveLimit)
      ? projectedOwner.slice(0, effectiveLimit)
      : projectedOwner;
    const truncatedOwner = totalCountOwner > slicedOwner.length;
    if (truncatedOwner) {
      hintParts.push(
        `showing ${slicedOwner.length} of ${totalCountOwner} — pass --limit <N> to widen or page further.`,
      );
    }

    return lafsSuccess<DocsListResult>(
      {
        ownerId: scopedOwner,
        ownerType,
        ...(typeFilter !== undefined ? { type: typeFilter } : {}),
        count: slicedOwner.length,
        ...(truncatedOwner ? { totalCount: totalCountOwner } : {}),
        limit: Number.isFinite(effectiveLimit) ? effectiveLimit : 0,
        orderBy,
        ...(hintParts.length > 0 ? { hint: hintParts.join(' ') } : {}),
        attachments: slicedOwner.map(({ _sortSha: _drop, ...row }) => row),
        attachmentBackend: backend as DocsListResult['attachmentBackend'],
      },
      'list',
    );
  },

  // ── docs.generate ──────────────────────────────────────────────────────────

  generate: async (params) => {
    const forId = params.for;
    if (!forId) {
      return lafsError('E_INVALID_INPUT', '--for <taskId|epicId> is required', 'generate');
    }

    const cwd = getProjectRoot();
    const result = await generateDocsLlmsTxt({ ownerId: forId, cwd });

    let attachmentId: string | undefined;
    let attachmentSha256: string | undefined;

    if (params.attach) {
      // Store the generated content back as an llms-txt attachment
      const store = createAttachmentStore();
      const ownerType = inferOwnerType(forId);
      const contentBytes = Buffer.from(result.content, 'utf-8');
      const llmsTxtDescriptor: Omit<LlmsTxtAttachment, 'sha256'> = {
        kind: 'llms-txt',
        source: 'generated',
        content: result.content,
        description: `llms.txt for ${forId} (${result.attachmentCount} docs)`,
        labels: ['llms-txt', 'generated'],
      };
      const meta = await store.put(
        contentBytes,
        llmsTxtDescriptor,
        ownerType,
        forId,
        'cleo-docs-generate',
        cwd,
      );
      attachmentId = meta.id;
      attachmentSha256 = meta.sha256;
    }

    return lafsSuccess<DocsGenerateResult>(
      {
        forId,
        content: result.content,
        attachmentCount: result.attachmentCount,
        usedLlmtxtPackage: result.usedLlmtxtPackage,
        ...(attachmentId !== undefined
          ? {
              attached: true,
              attachmentId,
              attachmentSha256,
            }
          : { attached: false }),
      },
      'generate',
    );
  },

  // ── docs.llm-output (T11137) ──────────────────────────────────────────────
  'llm-output': async (params) => {
    const forId = params.for;
    if (!forId) {
      return lafsError('E_INVALID_INPUT', '--for <entityId> is required', 'llm-output');
    }
    let mode: LlmOutputMode;
    if (params.mode !== undefined) {
      const raw = String(params.mode);
      if (!(LLM_OUTPUT_MODES as readonly string[]).includes(raw)) {
        return lafsError(
          'E_INVALID_INPUT',
          `--mode must be one of: ${LLM_OUTPUT_MODES.join('|')}`,
          'llm-output',
        );
      }
      mode = raw as LlmOutputMode;
    } else {
      mode = /^T\d+$/i.test(forId) ? 'task-export' : 'attachment-bundle';
    }
    const cwd = getProjectRoot();
    if (mode === 'task-export') {
      const result = await exportTaskDocument({
        taskId: forId,
        includeAttachments: params.includeAttachments !== false,
        includeMemoryRefs: params.includeMemoryRefs === true,
        projectRoot: cwd,
      });
      return lafsSuccess<DocsLlmOutputResult>(
        {
          forId,
          mode: 'task-export',
          content: result.markdown,
          sectionCount: result.pages,
          usedLlmtxtPackage: true,
        },
        'llm-output',
      );
    }
    const result = await generateDocsLlmsTxt({ ownerId: forId, cwd });
    let aid: string | undefined, asha: string | undefined;
    if (params.attach) {
      const store = createAttachmentStore();
      const desc: Omit<import('@cleocode/core/internal').LlmsTxtAttachment, 'sha256'> = {
        kind: 'llms-txt' as const,
        source: 'generated',
        content: result.content,
        description: `llms.txt for ${forId}`,
        labels: ['llms-txt', 'generated'],
      };
      const meta = await store.put(
        Buffer.from(result.content, 'utf-8'),
        desc,
        inferOwnerType(forId),
        forId,
        'cleo-docs-llm-output',
        cwd,
      );
      aid = meta.id;
      asha = meta.sha256;
    }
    return lafsSuccess<DocsLlmOutputResult>(
      {
        forId,
        mode: 'attachment-bundle',
        content: result.content,
        sectionCount: result.attachmentCount,
        usedLlmtxtPackage: result.usedLlmtxtPackage,
        ...(aid
          ? { attached: true, attachmentId: aid, attachmentSha256: asha }
          : { attached: false }),
      },
      'llm-output',
    );
  },

  // ── docs.fetch ─────────────────────────────────────────────────────────────

  fetch: async (params) => {
    const ref = params.attachmentRef;
    if (!ref) {
      return lafsError(
        'E_INVALID_INPUT',
        'attachmentRef is required (attachment ID or SHA-256 hex)',
        'fetch',
      );
    }

    // T11050 — route fetch through the canonical DocsReadModel
    const model = createDocsReadModel();
    const doc = (await model.resolveLatest(ref)) ?? (await model.resolveByAttachmentId(ref));
    if (!doc) {
      return lafsError('E_NOT_FOUND', `Attachment not found: ${ref}`, 'fetch');
    }

    // Fetch content through the read model
    const content = await model.fetchContent(doc);
    if (content === null) {
      return lafsError('E_NOT_FOUND', `Content not retrievable: ${ref}`, 'fetch');
    }

    const cwd = getProjectRoot();
    const cleoDir = resolveCanonicalCleoDir(resolveProjectByCwd(cwd));

    // Derive storage path for blob kinds
    let storagePath: string | undefined;
    if (doc.sha256) {
      const prefix = doc.sha256.slice(0, 2);
      const rest = doc.sha256.slice(2);
      const extMap: Record<string, string> = {
        'text/markdown': '.md',
        'text/plain': '.txt',
        'application/json': '.json',
        'application/pdf': '.pdf',
      };
      const ext = extMap[doc.mimeType ?? ''] ?? '.bin';
      storagePath = resolve(cleoDir, 'attachments', 'sha256', prefix, `${rest}${ext}`);
    }

    // Base64-encode bytes only for small attachments (<= 1 MB)
    const MAX_INLINE = 1024 * 1024;
    const contentBytes = Buffer.from(content, 'utf-8');
    const bytesBase64 =
      contentBytes.length <= MAX_INLINE ? contentBytes.toString('base64') : undefined;

    const backend: AttachmentBackend = await currentAttachmentBackend();

    return lafsSuccess<DocsFetchResult>(
      {
        metadata: {
          id: doc.id,
          sha256: doc.sha256,
          kind: 'blob',
          mime: doc.mimeType ?? 'text/plain',
          size: doc.sizeBytes,
          description: doc.summary ?? undefined,
          labels: undefined,
          createdAt: doc.createdAt,
          refCount: 0,
          ...(doc.slug ? { slug: doc.slug } : {}),
          ...(doc.kind ? { type: doc.kind as DocsType } : {}),
        },
        path: storagePath,
        sizeBytes: contentBytes.length,
        ...(bytesBase64 !== undefined ? { bytesBase64 } : {}),
        inlined: bytesBase64 !== undefined,
        attachmentBackend: backend as DocsFetchResult['attachmentBackend'],
      },
      'fetch',
    );
  },

  // ── docs.add ───────────────────────────────────────────────────────────────

  add: async (params) => {
    const {
      ownerId,
      file: filePath,
      url,
      desc: description,
      labels: rawLabels,
      attachedBy: rawAttachedBy,
      slug: rawSlug,
      title: rawTitle,
      type: rawType,
      strict: strictMode,
    } = params;
    if (!ownerId) {
      return lafsError('E_INVALID_INPUT', 'ownerId is required', 'add');
    }

    if (!filePath && !url) {
      return lafsError(
        'E_INVALID_INPUT',
        'Provide either a file path (positional or --file) or --url',
        'add',
      );
    }

    // T10159 (Saga T9855 / Epic T10157) — resolve the literal `AUTO` token
    // BEFORE shape validation. The slug `adr-AUTO-saga-fix` carries an
    // uppercase `AUTO` placeholder that would otherwise fail the strict
    // lowercase-kebab regex. `allocateAutoSlug` atomically scans the
    // `attachments` table for the kind's existing numeric portion (e.g.
    // adr-077-...) and substitutes the next available number into the
    // slug. Non-AUTO slugs pass through unchanged.
    let slug: string | undefined;
    if (rawSlug !== undefined) {
      let candidate = rawSlug as string;
      if (typeof candidate === 'string' && candidate.includes(AUTO_TOKEN)) {
        const allocated = await allocateAutoSlugForDispatch(getProjectRoot(), {
          kind: typeof rawType === 'string' ? rawType : '',
          rawSlug: candidate,
        });
        candidate = allocated.resolvedSlug;
      }
      const check = validateSlug(candidate);
      if (!check.valid) {
        return lafsError('E_INVALID_SLUG', check.reason, 'add');
      }
      slug = candidate;
    }

    // T9637 — validate type against the closed taxonomy set.
    let type: DocsType | undefined;
    if (rawType !== undefined) {
      if (!validateDocsType(rawType)) {
        return lafsError(
          'E_INVALID_TYPE',
          `type must be one of: ${registeredKindList()} — got '${String(rawType)}'`,
          'add',
        );
      }
      type = rawType;
    }

    // T10367 (Saga T10288 · Epic T10290 · E2.2) — changeset DocKind delegation.
    //
    // The `changeset` kind is `canonicalHome: 'ssot-first'` in `.cleo/canon.yml`
    // and the WriterRegistry (T10366) names `writeChangesetEntry` as the sole
    // writer. `cleo docs add --type changeset` therefore MUST flow through
    // the dual-write transaction in `packages/core/src/changesets/writer.ts`
    // instead of the generic attachment-store path below — otherwise the
    // bytes land in the SSoT blob store BUT skip the `.changeset/<slug>.md`
    // file mirror that the release-plan aggregator + human reviewers read.
    //
    // Contract:
    //   - File body MUST carry a valid changeset frontmatter (id, tasks,
    //     kind, summary). Missing frontmatter → E_REQUIRES_CHANGESET_VERB
    //     with a fix hint pointing at `cleo changeset add` for guided
    //     authoring (the CLI flag-prompt surface is the friendlier path
    //     when the operator only has free-form prose).
    //   - When --slug is provided alongside --type changeset, it MUST match
    //     the frontmatter `id`. The frontmatter is canonical; --slug is
    //     redundant but accepted for symmetry with the rest of `docs add`.
    //   - On success the LAFS envelope mirrors what `cleo changeset add`
    //     emits — `slug`, `attachmentId`, `sha256`, plus `type: 'changeset'`
    //     and `kind: 'blob'` (the SSoT blob kind).
    //
    // The file branch below is bypassed entirely in this path — there is
    // exactly ONE writer for the `changeset` kind (the SG-DOCS-INTEGRITY
    // invariant). Side-effects (memory observation, llmtxt graph mint, v2
    // mirror) are NOT replayed here because `writeChangesetEntry` already
    // owns the canonical write surface and downstream consumers read from
    // the SSoT blob via the same code path either verb invoked.
    if (type === 'changeset') {
      if (!filePath) {
        return lafsError(
          'E_INVALID_INPUT',
          'changeset writes require a --file path (URL attachments are not supported for changesets)',
          'add',
        );
      }
      const absPath = resolve(filePath);
      let bytes: Buffer;
      try {
        bytes = await readFile(absPath);
      } catch {
        return lafsError('E_FILE_ERROR', `Cannot read file: ${absPath}`, 'add');
      }
      const parsed = parseChangesetFrontmatter(bytes.toString('utf-8'));
      if (!parsed.ok) {
        // Map the discriminated parser failure to a single envelope code.
        // E_REQUIRES_CHANGESET_VERB tells the operator that this kind has
        // a dedicated CLI verb for guided authoring — `cleo changeset add`
        // prompts for every required field. The `details.parserError`
        // field carries the raw failure shape so agents can post-process
        // without re-running the parser.
        let message: string;
        if (parsed.error === 'missing-frontmatter') {
          message =
            'changeset file is missing the `---`-fenced YAML frontmatter. ' +
            'Required fields: id, tasks, kind, summary.';
        } else if (parsed.error === 'missing-required') {
          message = `changeset frontmatter is missing required fields: ${parsed.missing.join(', ')}.`;
        } else if (parsed.error === 'yaml-invalid') {
          const lineHint = parsed.line !== undefined ? ` (line ${parsed.line})` : '';
          message = `changeset frontmatter YAML is invalid${lineHint}: ${parsed.parserMessage}`;
        } else {
          // schema-invalid
          message = `changeset frontmatter failed schema validation: ${parsed.issues.join('; ')}`;
        }
        return {
          success: false,
          error: {
            code: 'E_REQUIRES_CHANGESET_VERB',
            message,
            details: {
              fix: 'Use `cleo changeset add --slug <id> --tasks <T####> --kind <kind> --summary <text>` for guided authoring.',
              parserError: parsed.error,
              ...(parsed.error === 'missing-required' ? { missing: parsed.missing } : {}),
              ...(parsed.error === 'schema-invalid' ? { issues: parsed.issues } : {}),
            },
          },
        };
      }

      // If --slug was also provided, cross-check against the frontmatter id.
      // The frontmatter wins — but a mismatch is almost always an operator
      // bug (typo in either surface) so we fail loud rather than silently
      // discard the flag.
      if (slug !== undefined && slug !== parsed.entry.id) {
        return {
          success: false,
          error: {
            code: 'E_SLUG_MISMATCH',
            message: `--slug '${slug}' does not match changeset frontmatter id '${parsed.entry.id}'. The frontmatter is canonical — drop --slug or align it.`,
          },
        };
      }

      const outcome = await writeChangesetEntry(parsed.entry, {
        projectRoot: getProjectRoot(),
        attachedBy:
          typeof rawAttachedBy === 'string' && rawAttachedBy.length > 0
            ? rawAttachedBy
            : 'cleo-docs-add',
      });
      if (!outcome.ok) {
        const err = outcome.error;
        if (err.code === 'E_SLUG_PATTERN_MISMATCH') {
          const hint = err.example ? ` (example: ${err.example})` : '';
          return lafsError('E_SLUG_PATTERN_MISMATCH', `${err.message}${hint}`, 'add');
        }
        if (err.code === 'E_INVALID_ENTRY') {
          return lafsError('E_INVALID_INPUT', err.message, 'add');
        }
        if (err.code === 'E_FILE_WRITE_FAILED') {
          return lafsError('E_FILE_ERROR', err.message, 'add');
        }
        // T10388 — uniform E_SLUG_RESERVED shape across both writers. The
        // changeset writer now reserves slugs through the central allocator
        // BEFORE any filesystem or DB mutation; collisions surface here with
        // 3 suggested alternatives. The legacy E_SSOT_WRITE_FAILED code is
        // retained in `details.aliases` for one release of back-compat so
        // downstream consumers grepping for the old code can still match.
        if (err.code === 'E_SLUG_RESERVED') {
          return {
            success: false,
            error: {
              code: 'E_SLUG_RESERVED',
              message: err.message,
              details: {
                suggestions: err.suggestions,
                aliases: err.aliases,
              },
            },
          };
        }
        // E_SSOT_WRITE_FAILED — bubble up so the operator can see the
        // underlying store error. The writer has already rolled back the
        // `.changeset/<slug>.md` file at this point.
        return lafsError('E_SSOT_WRITE_FAILED', err.message, 'add');
      }

      // T9976 — emit structured memory observation for the changeset write,
      // matching the regular docs-add behaviour. Fire-and-forget; the
      // observation is best-effort and never fails the dispatch envelope.
      const changesetPayload: DocAttachmentObservationPayload = {
        kind: 'doc-attachment',
        attachmentId: outcome.result.attachmentId,
        ownerId: outcome.result.ownerId,
        addedAt: new Date().toISOString(),
        slug: outcome.result.slug,
        type: 'changeset',
      };
      emitDocAttachmentObservation(changesetPayload, getProjectRoot());

      // T11139 — audit trail
      try {
        writeAuditEntry(getProjectRoot(), {
          op: 'docs.add',
          slug: outcome.result.slug,
          type: 'changeset',
          attachmentId: outcome.result.attachmentId,
          sha256: outcome.result.sha256,
          summary: `Added changeset '${outcome.result.slug}'`,
        });
      } catch {
        /* best-effort */
      }

      return lafsSuccess<DocsAddResult>(
        {
          attachmentId: outcome.result.attachmentId,
          sha256: outcome.result.sha256,
          // writeChangesetEntry returns a freshly-minted ref so refCount is 1
          // (or more if the same content was already addressed by another
          // owner). The store sets the canonical value; mirroring it here
          // keeps the envelope shape identical to the file/url branches.
          refCount: 1,
          kind: 'blob',
          ownerId: outcome.result.ownerId,
          ownerType: 'task',
          // Cast: core returns 'llmtxt' (Wave C — legacy backend retired for mirror store).
          attachmentBackend:
            (await currentAttachmentBackend()) as DocsAddResult['attachmentBackend'],
          slug: outcome.result.slug,
          type: 'changeset',
        },
        'add',
      );
    }

    // T10360 — when `--type adr` is set AND `--slug` is omitted, auto-allocate
    // the slug via the ADR chokepoint. The allocator probes the docs SSoT for
    // the highest existing ADR number, increments by 1, and reserves
    // `adr-NNN-<kebab-title>` via the T10392 reserveSlug chokepoint. The
    // returned slug is consumed by the imminent `attachmentStore.put` call
    // (same handshake as explicit `--slug` callers).
    //
    // `--title` is the canonical kebab-source. We validated its presence at
    // the CLI layer; here we re-check defensively for non-CLI callers
    // (HTTP, programmatic) so the error contract stays uniform.
    let adrNumber: number | undefined;
    if (type === 'adr' && slug === undefined) {
      if (typeof rawTitle !== 'string' || rawTitle.trim().length === 0) {
        return lafsError(
          'E_VALIDATION',
          'title is required when type=adr and slug is omitted — the allocator needs ' +
            'a title to assemble adr-NNN-<kebab-title>',
          'add',
        );
      }
      const allocation = await allocateAdrSlug(getProjectRoot(), { title: rawTitle });
      if (!allocation.ok) {
        return lafsError(allocation.code, allocation.message, 'add');
      }
      slug = allocation.slug;
      adrNumber = allocation.number;
    }

    // T9788 — when the registered kind requires an entityId, enforce the
    // kind's slug pattern on top of the shape check above. We accept a
    // missing slug (the store will assign one) but reject mismatches
    // with `E_SLUG_PATTERN_MISMATCH` + an example so the operator can fix
    // the input on retry.
    if (type !== undefined && slug !== undefined) {
      const patternCheck = getDocKindRegistry().validateSlug(type, slug);
      if (!patternCheck.ok) {
        // Release the auto-allocated reservation so it doesn't leak.
        if (adrNumber !== undefined) releaseReservedSlug(slug);
        const exampleHint = patternCheck.example ? ` (example: ${patternCheck.example})` : '';
        return lafsError('E_SLUG_PATTERN_MISMATCH', `${patternCheck.error}${exampleHint}`, 'add');
      }
    }

    // T10386 (Saga T10288 · Epic T10289) — central slug-allocator chokepoint.
    //
    // Every writer that intends to attach a slug MUST call reserveSlug()
    // BEFORE attachmentStore.put. The allocator surfaces a uniform
    // E_SLUG_RESERVED envelope (with 3 derived suggestions) across both
    // writers (cleo docs add + cleo changeset add) so the operator sees the
    // same shape regardless of which CLI verb tripped the collision.
    //
    // The `kind` arg to reserveSlug() does NOT partition the namespace
    // (T10390 / E1.5 decision: global namespace). When --type is omitted we
    // pass the empty string; the value is reserved for future per-kind
    // suggestion derivation but does not affect uniqueness today.
    //
    // The post-write `E_SLUG_TAKEN` mapping in the catch blocks below
    // remains as a back-compat alias for ONE release (E_SLUG_TAKEN was the
    // docs-only error code shipped by T9636/T9637 before the allocator
    // collapsed both writers onto a single error shape). Downstream
    // consumers grepping for the legacy code can match
    // `details.aliases: ['E_SLUG_TAKEN']` until E2 deprecates the alias.
    // T10360 — when adrNumber is set, allocateAdrSlug() already reserved the
    // slug via reserveSlug() internally; skip the second chokepoint call to
    // avoid double-reservation. For all other paths the chokepoint runs.
    if (slug !== undefined && adrNumber === undefined) {
      const reservation = await reserveSlugForDispatch(getProjectRoot(), {
        kind: type ?? '',
        slug,
      });
      if (!reservation.ok) {
        return {
          success: false,
          error: {
            code: 'E_SLUG_RESERVED',
            message: SLUG_COLLISION_GUIDANCE.replaceAll('{slug}', slug ?? ''),
            fix: `cleo docs update ${slug ?? '<slug>'} --file <your-file>`,
            details: {
              suggestions: reservation.suggestions,
              aliases: ['E_SLUG_TAKEN'],
            },
          },
        };
      }
    }

    const extras: { slug?: string; type?: string } = {};
    if (slug !== undefined) extras.slug = slug;
    if (type !== undefined) extras.type = type;

    const labels = parseLabels(rawLabels);
    const attachedBy = rawAttachedBy ?? 'human';
    const ownerType = inferOwnerType(ownerId);
    const store = createAttachmentStore();

    if (filePath) {
      // Local file attachment
      const absPath = resolve(filePath);
      let bytes: Buffer;
      try {
        bytes = await readFile(absPath);
      } catch {
        return lafsError('E_FILE_ERROR', `Cannot read file: ${absPath}`, 'add');
      }

      // T10160 — body schema validation per DocKind.
      //
      // Runs only when --type is supplied and the kind declares a
      // non-empty `requiredSections` in the canonical doc-kind taxonomy.
      // `strict: true` → missing sections fail the write with
      // `E_DOC_SCHEMA_MISMATCH`. Default (advisory) → a warning surfaces
      // through the AsyncLocalStorage warning collector so the envelope's
      // `meta.warnings` carries it; the write proceeds.
      //
      // URL attachments are skipped — there are no local bytes to scan.
      // Project-level extensions are picked up via `DocKindRegistry.load`
      // so a kind declared in `.cleo/docs-config.json` with
      // `requiredSections` participates in the same validator.
      if (type !== undefined) {
        const bodyText = bytes.toString('utf-8');
        let registry: DocKindRegistry | undefined;
        try {
          registry = DocKindRegistry.load(getProjectRoot());
        } catch {
          // Malformed extension config — fall back to built-ins-only.
          // `cleo check canon docs` surfaces the underlying diagnostic.
          registry = undefined;
        }
        const check = validateDocBody(type, bodyText, registry);
        if (!check.ok) {
          const missingList = check.missing.join(', ');
          if (strictMode === true) {
            return lafsError(
              'E_DOC_SCHEMA_MISMATCH',
              `body for kind '${type}' is missing required section(s): ${missingList}`,
              'add',
              `Add the missing H2 section(s) — '## ${check.missing[0] ?? ''}' — then retry. ` +
                `Pass --strict=false (default) to surface as an advisory warning instead of an error.`,
              {
                kind: type,
                missing: check.missing,
                strict: true,
              },
            );
          }
          // Advisory mode — push a warning and continue.
          pushWarning({
            code: 'W_DOC_SCHEMA_MISMATCH',
            message: `body for kind '${type}' is missing required section(s): ${missingList}. Add '--strict' to fail on schema violations.`,
          });
        }
      }

      const mime = mimeFromPath(absPath);
      const attachment: Omit<LocalFileAttachment, 'sha256'> = {
        kind: 'local-file',
        path: absPath,
        mime,
        size: bytes.length,
        ...(description ? { description } : {}),
        ...(labels ? { labels } : {}),
      };

      let meta: Awaited<ReturnType<typeof store.put>>;
      try {
        meta = await store.put(
          bytes,
          attachment,
          ownerType,
          ownerId,
          attachedBy,
          undefined,
          extras,
        );
      } catch (err) {
        // Release any reservation held by the allocator (explicit reserveSlug
        // OR auto-allocated ADR slug T10360) so retries do not see a stale
        // claim. Safe on any thrown error path because releaseReservedSlug()
        // is a no-op for un-reserved slugs.
        if (slug !== undefined) releaseReservedSlug(slug);
        if (err instanceof SlugCollisionError) {
          // T10386 — late-bound collision (cross-process race won by another
          // writer between reserveSlug() and put()). Surface the SAME
          // E_SLUG_RESERVED envelope as the early-bound chokepoint path so
          // operators see one uniform shape, with the legacy `E_SLUG_TAKEN`
          // code retained under `details.aliases` for one release of
          // back-compat.
          return {
            success: false,
            error: {
              code: 'E_SLUG_RESERVED',
              message: SLUG_COLLISION_GUIDANCE.replaceAll('{slug}', err.slug ?? ''),
              fix: `cleo docs update ${err.slug ?? '<slug>'} --file <your-file>`,
              details: {
                suggestions: err.suggestions,
                aliases: ['E_SLUG_TAKEN'],
              },
            },
          };
        }
        throw err;
      }

      // T10360 — `attachmentStore.put` only consumes the reservation when
      // `CLEO_STRICT_SLUG_ALLOCATOR=1`. In non-strict mode (current default)
      // the auto-allocated slug would otherwise leak in the in-process
      // reservedSlugs set indefinitely. Consume defensively here.
      if (adrNumber !== undefined && slug !== undefined) consumeReservedSlug(slug);

      // T947 Wave C — llmtxt mirror is now the canonical blob storage path.
      // The legacy store write above remains for slug/refcount/lifecycle
      // support in tasks.db; the mirror keeps manifest.db in sync.
      let backend: AttachmentBackend = 'llmtxt';
      try {
        const blobMirror = createAttachmentBlobStore(getProjectRoot());
        const mirrorResult = await blobMirror.put(ownerId, {
          name: absPath.split(/[\\/]/).pop() ?? meta.sha256.slice(0, 12),
          data: new Uint8Array(bytes),
          contentType: mime,
        });
        backend = mirrorResult.backend;
      } catch {
        // Mirror write is best-effort — never fail docs add on it.
        backend = await currentAttachmentBackend();
      }

      // T945 Stage A — mint `llmtxt:<sha256>` graph node + `embeds` edge
      // from owner to blob. Best-effort: wrapped in fire-and-forget so
      // graph-layer failure never blocks the attachment write path.
      import('@cleocode/core/internal')
        .then(({ ensureLlmtxtNode }) =>
          ensureLlmtxtNode(
            getProjectRoot(),
            meta.sha256,
            `${ownerType}:${ownerId}`,
            absPath.split('/').pop() ?? meta.sha256.slice(0, 12),
          ),
        )
        .catch(() => {
          /* Graph population is best-effort — never fail docs add. */
        });

      // T9976 — emit structured memory observation for docs.add (fire-and-forget).
      const filePayload: DocAttachmentObservationPayload = {
        kind: 'doc-attachment',
        attachmentId: meta.id,
        ownerId,
        addedAt: new Date().toISOString(),
        ...(slug !== undefined ? { slug } : {}),
        ...(type !== undefined ? { type } : {}),
      };
      emitDocAttachmentObservation(filePayload, getProjectRoot());

      // T11139 — audit trail
      try {
        writeAuditEntry(getProjectRoot(), {
          op: 'docs.add',
          slug,
          type,
          attachmentId: meta.id,
          sha256: meta.sha256,
          ownerId,
          summary: `Added doc '${slug ?? meta.sha256.slice(0, 12)}'${type ? ` of type '${type}'` : ''} for owner ${ownerId}`,
        });
      } catch {
        /* best-effort */
      }

      return lafsSuccess<DocsAddResult>(
        {
          attachmentId: meta.id,
          sha256: meta.sha256,
          refCount: meta.refCount,
          kind: 'local-file',
          ownerId,
          ownerType,
          // Cast: core returns 'llmtxt'|'legacy'; contracts uses 'legacy'|'llmstxt-v2' (T1529)
          attachmentBackend: backend as DocsAddResult['attachmentBackend'],
          ...(slug !== undefined ? { slug } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(adrNumber !== undefined ? { adrNumber } : {}),
        },
        'add',
      );
    }

    // URL attachment — store metadata without caching bytes
    if (url) {
      const attachment: Omit<UrlAttachment, never> = {
        kind: 'url',
        url,
        ...(description ? { description } : {}),
        ...(labels ? { labels } : {}),
      };

      // For URL-only attachments, use the URL as content so we have a sha256
      const urlBytes = Buffer.from(url, 'utf-8');
      let meta: Awaited<ReturnType<typeof store.put>>;
      try {
        meta = await store.put(
          urlBytes,
          attachment,
          ownerType,
          ownerId,
          attachedBy,
          undefined,
          extras,
        );
      } catch (err) {
        // Release any allocator reservation on the failure path (see file
        // branch above for the rationale).
        if (slug !== undefined) releaseReservedSlug(slug);
        if (err instanceof SlugCollisionError) {
          // T10386 — uniform E_SLUG_RESERVED shape across both writers.
          // Legacy `E_SLUG_TAKEN` is preserved under `details.aliases` for
          // one release of back-compat.
          return {
            success: false,
            error: {
              code: 'E_SLUG_RESERVED',
              message: SLUG_COLLISION_GUIDANCE.replaceAll('{slug}', err.slug ?? ''),
              fix: `cleo docs update ${err.slug ?? '<slug>'} --file <your-file>`,
              details: {
                suggestions: err.suggestions,
                aliases: ['E_SLUG_TAKEN'],
              },
            },
          };
        }
        throw err;
      }

      // T10360 — consume the auto-allocated reservation (see file-path branch).
      if (adrNumber !== undefined && slug !== undefined) consumeReservedSlug(slug);

      // T945 Stage A — mint `llmtxt:<sha256>` node + `embeds` edge for the
      // URL attachment (the URL itself is the content-addressable identity).
      import('@cleocode/core/internal')
        .then(({ ensureLlmtxtNode }) =>
          ensureLlmtxtNode(getProjectRoot(), meta.sha256, `${ownerType}:${ownerId}`, url),
        )
        .catch(() => {
          /* Graph population is best-effort — never fail docs add. */
        });

      // URL writes stay in tasks.db; v2 focuses on local-file / blob kinds.
      // Wave C — resolveAttachmentBackend() always returns 'llmtxt'.
      const backend: AttachmentBackend = await currentAttachmentBackend();

      // T9976 — emit structured memory observation for docs.add URL path (fire-and-forget).
      const urlPayload: DocAttachmentObservationPayload = {
        kind: 'doc-attachment',
        attachmentId: meta.id,
        ownerId,
        addedAt: new Date().toISOString(),
        ...(slug !== undefined ? { slug } : {}),
        ...(type !== undefined ? { type } : {}),
      };
      emitDocAttachmentObservation(urlPayload, getProjectRoot());

      // T11139 — audit trail
      try {
        writeAuditEntry(getProjectRoot(), {
          op: 'docs.add',
          slug,
          type,
          attachmentId: meta.id,
          sha256: meta.sha256,
          ownerId,
          summary: `Added URL doc '${slug ?? url}'${type ? ` of type '${type}'` : ''} for owner ${ownerId}`,
        });
      } catch {
        /* best-effort */
      }

      return lafsSuccess<DocsAddResult>(
        {
          attachmentId: meta.id,
          sha256: meta.sha256,
          refCount: meta.refCount,
          kind: 'url',
          url,
          ownerId,
          ownerType,
          // Cast: core returns 'llmtxt'|'legacy'; contracts uses 'legacy'|'llmstxt-v2' (T1529)
          attachmentBackend: backend as DocsAddResult['attachmentBackend'],
          ...(slug !== undefined ? { slug } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(adrNumber !== undefined ? { adrNumber } : {}),
        },
        'add',
      );
    }

    // Should not reach here
    return lafsError('E_INVALID_INPUT', 'Unreachable: no file or url', 'add');
  },

  // ── docs.remove ────────────────────────────────────────────────────────────

  remove: async (params) => {
    const { attachmentRef: ref, from: fromOwner } = params;

    if (!ref) {
      return lafsError(
        'E_INVALID_INPUT',
        'attachmentRef is required (attachment ID or SHA-256 hex)',
        'remove',
      );
    }
    if (!fromOwner) {
      return lafsError('E_INVALID_INPUT', '--from <ownerId> is required', 'remove');
    }

    const store = createAttachmentStore();
    const ownerType = inferOwnerType(fromOwner);

    // Resolve attachment ID if SHA-256 was given
    let attachmentId = ref;
    if (/^[0-9a-f]{64}$/i.test(ref)) {
      const result = await store.get(ref);
      if (!result) {
        return lafsError('E_NOT_FOUND', `No attachment found with SHA-256: ${ref}`, 'remove');
      }
      attachmentId = result.metadata.id;
    }

    const derefResult: DerefResult = await store.deref(attachmentId, ownerType, fromOwner);

    if (derefResult.status === 'not-found') {
      return lafsError(
        'E_NOT_FOUND',
        `Attachment ref not found: ${attachmentId} on owner ${fromOwner}`,
        'remove',
      );
    }

    const blobPurged = derefResult.status === 'removed';
    const refCountAfter = derefResult.status === 'derefd' ? derefResult.refCountAfter : 0;

    // T947 Wave C — mirror the remove so llmtxt manifests
    // also soft-delete. Best-effort.
    try {
      const blobMirror = createAttachmentBlobStore(getProjectRoot());
      await blobMirror.remove(attachmentId, fromOwner);
    } catch {
      /* Mirror remove is best-effort. */
    }
    // Wave C — always 'llmtxt' for llmtxt-backed stores.
    const backend: AttachmentBackend = await currentAttachmentBackend();

    // T11139 — audit trail
    try {
      writeAuditEntry(getProjectRoot(), {
        op: 'docs.remove',
        attachmentId,
        ownerId: fromOwner,
        summary: `Removed attachment ${attachmentId} from owner ${fromOwner}${blobPurged ? ' (blob purged)' : ''}`,
      });
    } catch {
      /* best-effort */
    }

    return lafsSuccess<DocsRemoveResult>(
      {
        removed: blobPurged,
        attachmentId,
        from: fromOwner,
        refCountAfter,
        blobPurged,
        // Cast: core returns 'llmtxt'|'legacy'; contracts uses 'legacy'|'llmstxt-v2' (T1529)
        attachmentBackend: backend as DocsRemoveResult['attachmentBackend'],
      },
      'remove',
    );
  },

  // ── docs.update (T10161 — E12.C4 / Saga T9855) ─────────────────────────────

  update: async (params) => {
    const { slug: rawSlug, file: filePath, content: inlineContent, status: rawStatus } = params;

    if (typeof rawSlug !== 'string' || rawSlug.length === 0) {
      return lafsError('E_INVALID_INPUT', 'slug is required', 'update');
    }

    // Exactly one of file or content must be provided.
    const hasFile = typeof filePath === 'string' && filePath.length > 0;
    const hasContent = typeof inlineContent === 'string';
    if (hasFile === hasContent) {
      return lafsError(
        'E_INVALID_INPUT',
        'Provide exactly one of --file <path> or --content <text>',
        'update',
        'Use `cleo docs update <slug> --file ./new.md` OR `cleo docs update <slug> --content "..."`.',
      );
    }

    // Validate --status against the canonical enum before touching the store.
    if (rawStatus !== undefined && !isLifecycleStatus(rawStatus)) {
      return lafsError(
        'E_INVALID_INPUT',
        `status must be one of: ${DOCS_UPDATE_LIFECYCLE_STATUS_LIST} — got '${String(rawStatus)}'`,
        'update',
      );
    }

    // Resolve a relative --file path against the dispatch cwd so the core
    // function receives an absolute path. Mirrors docs.add discipline.
    const projectRoot = getProjectRoot();
    const resolvedParams: typeof params = hasFile
      ? { ...params, file: resolve(filePath as string) }
      : params;

    const outcome = await updateDocBySlug(projectRoot, resolvedParams);

    if (!outcome.ok) {
      return lafsError(
        outcome.error.code,
        outcome.error.message,
        'update',
        undefined,
        'details' in outcome.error ? outcome.error.details : undefined,
      );
    }

    // T947 Wave C — mirror the updated blob so blobList /
    // publishDocs see the new version (T11053 / AC1). Best-effort.
    let backend: AttachmentBackend = 'llmtxt';
    try {
      const blobMirror = createAttachmentBlobStore(getProjectRoot());
      const updatedBytes = hasFile
        ? new Uint8Array(await readFile(resolve(filePath as string)))
        : new Uint8Array(Buffer.from(inlineContent as string, 'utf-8'));
      const contentType = hasFile ? mimeFromPath(resolve(filePath as string)) : 'text/plain';
      const store = createAttachmentStore();
      const rows = await store.listAllInProject(projectRoot);
      const ownerIds = Array.from(
        new Set(
          rows
            .filter((row) => row.metadata.id === outcome.result.attachmentId)
            .map((row) => row.ownerId),
        ),
      );
      const mirrorOwnerIds = ownerIds.length > 0 ? ownerIds : [`slug:${outcome.result.slug}`];
      for (const mirrorOwnerId of mirrorOwnerIds) {
        const mirrorResult = await blobMirror.put(mirrorOwnerId, {
          name: outcome.result.slug,
          data: updatedBytes,
          contentType,
        });
        backend = mirrorResult.backend;
      }
    } catch {
      backend = await currentAttachmentBackend();
    }

    // T11139 — audit trail
    try {
      writeAuditEntry(getProjectRoot(), {
        op: 'docs.update',
        slug: outcome.result.slug,
        type: outcome.result.type ?? undefined,
        attachmentId: outcome.result.attachmentId,
        sha256: outcome.result.sha256,
        previousSha256: outcome.result.previousSha256 ?? undefined,
        summary: `Updated doc '${outcome.result.slug}'${outcome.result.lifecycleStatus ? ` (status: ${outcome.result.lifecycleStatus})` : ''}`,
      });
    } catch {
      /* best-effort */
    }

    return lafsSuccess<DocsUpdateResult>(
      {
        slug: outcome.result.slug,
        ...(outcome.result.type !== null ? { type: outcome.result.type as DocsType } : {}),
        attachmentId: outcome.result.attachmentId,
        previousAttachmentId: outcome.result.previousAttachmentId,
        sha256: outcome.result.sha256,
        previousSha256: outcome.result.previousSha256,
        changed: outcome.result.changed,
        lifecycleStatus: outcome.result.lifecycleStatus,
        updatedAt: outcome.result.updatedAt,
        version: outcome.result.version,
        /** Version SSoT (T11181) — canonical version identifiers. */
        ownerVersion: outcome.result.ownerVersion,
        /** Sequential doc version counter (T11181). */
        docVersion: outcome.result.docVersion,
        squashed: outcome.result.squashed,
        summary: outcome.result.summary,
        // T11053 — surface which backend stored the updated blob so
        // observability consumers can confirm the V2 mirror succeeded.
        attachmentBackend: backend as DocsUpdateResult['attachmentBackend'],
        ...(outcome.result.dryRun === true ? { dryRun: true as const } : {}),
        ...(outcome.result.wouldWrite !== undefined
          ? { wouldWrite: outcome.result.wouldWrite }
          : {}),
        ...(outcome.result.wouldChange !== undefined
          ? { wouldChange: outcome.result.wouldChange }
          : {}),
      },
      'update',
    );
  },

  // ── docs.supersede ─────────────────────────────────────────────────────────

  supersede: async (params) => {
    const { oldSlug, newSlug, reason } = params;

    if (typeof oldSlug !== 'string' || oldSlug.length === 0) {
      return lafsError('E_INVALID_INPUT', '<oldSlug> is required', 'supersede');
    }
    if (typeof newSlug !== 'string' || newSlug.length === 0) {
      return lafsError('E_INVALID_INPUT', '<newSlug> is required', 'supersede');
    }

    try {
      const result = await supersedeDoc(getProjectRoot(), {
        oldSlug,
        newSlug,
        ...(typeof reason === 'string' && reason.length > 0 ? { reason } : {}),
      });

      const payload: DocsSupersedeResult = {
        oldSlug: result.oldSlug,
        newSlug: result.newSlug,
        oldAttachmentId: result.oldAttachmentId,
        newAttachmentId: result.newAttachmentId,
        supersededAt: result.supersededAt,
        edgeId: result.edgeId,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      };
      // T11139 — audit trail
      try {
        writeAuditEntry(getProjectRoot(), {
          op: 'docs.supersede',
          slug: result.newSlug,
          attachmentId: result.newAttachmentId,
          summary: `Superseded '${result.oldSlug}' → '${result.newSlug}'${result.reason ? ` (reason: ${result.reason})` : ''}`,
        });
      } catch {
        /* best-effort */
      }
      return lafsSuccess<DocsSupersedeResult>(payload, 'supersede');
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err && typeof err.code === 'number'
          ? // Map ExitCode (number) → stable LAFS string code expected by callers.
            err.code === 4
            ? SUPERSEDE_NOT_FOUND_CODE
            : err.code === 6
              ? SUPERSEDE_SAME_SLUG_CODE
              : 'E_INTERNAL'
          : 'E_INTERNAL';
      const message = err instanceof Error ? err.message : 'supersede failed';
      return lafsError(code, message, 'supersede');
    }
  },
});

// ─── Envelope-to-response converter ──────────────────────────────────────────

/**
 * Convert a docs LAFS envelope to a {@link DispatchResponse}.
 *
 * Lifts `attachmentBackend` from `data` into `meta` for backward compatibility
 * with T947 Wave B observability consumers that read `response.meta.attachmentBackend`.
 *
 * @param envelope  - LAFS envelope returned by the typed op function.
 * @param gateway   - CQRS gateway ('query' | 'mutate').
 * @param operation - Operation name forwarded to {@link dispatchMeta}.
 * @param startTime - `Date.now()` captured at handler entry.
 *
 * @internal
 */
function docsEnvelopeToResponse(
  envelope: {
    success: boolean;
    data?: unknown;
    error?: {
      code: string | number;
      message: string;
      details?: Record<string, unknown>;
      fix?: string;
    };
  },
  gateway: string,
  operation: string,
  startTime: number,
): DispatchResponse {
  if (!envelope.success) {
    return {
      meta: dispatchMeta(gateway, 'docs', operation, startTime),
      success: false,
      error: {
        code: String(envelope.error?.code ?? 'E_INTERNAL'),
        message: envelope.error?.message ?? 'Unknown error',
        ...(envelope.error?.fix !== undefined ? { fix: envelope.error.fix } : {}),
        // T9636 — preserve structured details (e.g. slug suggestions) so the
        // CLI can render alternative slugs without a separate API call.
        ...(envelope.error?.details !== undefined ? { details: envelope.error.details } : {}),
      },
    };
  }

  // Extract attachmentBackend from data (if present) and lift into meta.
  let attachmentBackend: AttachmentBackend | undefined;
  let dryRun: true | undefined;
  // T9792 — also lift `hint` (added by `docs.list` when defaults kick in)
  // so JSON consumers can read it from `meta.hint` without poking into the
  // result body.
  let hint: string | undefined;
  let responseData = envelope.data;

  if (responseData !== null && responseData !== undefined && typeof responseData === 'object') {
    const dataObj = responseData as Record<string, unknown>;
    let cleanedData: Record<string, unknown> = dataObj;
    let cleaned = false;
    if ('attachmentBackend' in cleanedData && cleanedData['attachmentBackend'] !== undefined) {
      attachmentBackend = cleanedData['attachmentBackend'] as AttachmentBackend;
      const { attachmentBackend: _lifted, ...rest } = cleanedData;
      cleanedData = rest;
      cleaned = true;
    }
    if ('hint' in cleanedData && typeof cleanedData['hint'] === 'string') {
      hint = cleanedData['hint'] as string;
      // Keep `hint` on the data payload too so direct result consumers see
      // it; meta.hint is a parallel surface for `--field meta.hint` queries.
    }
    if (cleanedData['dryRun'] === true) {
      dryRun = true;
    }
    if (cleaned) {
      responseData = cleanedData;
    }
  }

  return {
    meta: {
      ...dispatchMeta(gateway, 'docs', operation, startTime),
      ...(attachmentBackend !== undefined ? { attachmentBackend } : {}),
      ...(dryRun === true ? { dryRun: true } : {}),
      ...(hint !== undefined ? { hint } : {}),
    },
    success: true,
    data: responseData,
  };
}

// ─── DocsHandler ──────────────────────────────────────────────────────────────

const QUERY_OPS = new Set<string>([
  'list',
  'fetch',
  'generate',
  'export',
  'search',
  'find',
  'merge',
  'rank',
  'versions',
  'status',
]);
const MUTATE_OPS = new Set<string>([
  'add',
  'remove',
  'update',
  'supersede',
  'publish',
  'publish-pr',
  'sync',
  'import',
]);

async function dispatchDocsLegacyQuery(
  operation: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const projectRoot = getProjectRoot();
  switch (operation) {
    case 'export':
      return exportDocument({
        taskId: String(params['taskId']),
        includeAttachments: params['includeAttachments'] !== false,
        includeMemoryRefs: params['includeMemoryRefs'] === true,
        projectRoot,
      });
    case 'search': {
      const limit = typeof params['limit'] === 'number' ? params['limit'] : 10;
      if (typeof params['ownerId'] === 'string' && params['ownerId'].length > 0) {
        return searchDocs(String(params['query']), {
          ownerId: params['ownerId'],
          limit,
          projectRoot,
        });
      }
      return searchAllProjectDocs(String(params['query']), {
        limit,
        type: typeof params['type'] === 'string' ? params['type'] : undefined,
        projectRoot,
      });
    }
    case 'find':
      return findSimilarDocs(String(params['similarSlug']), {
        ...(typeof params['limit'] === 'number' ? { limit: params['limit'] } : {}),
        ...(typeof params['threshold'] === 'number' ? { threshold: params['threshold'] } : {}),
        allKinds: params['allKinds'] === true,
        projectRoot,
      });
    case 'merge':
      return mergeDocs(String(params['attA']), String(params['attB']), {
        strategy:
          params['strategy'] === 'cherry-pick' || params['strategy'] === 'multi-diff'
            ? params['strategy']
            : 'three-way',
        base: typeof params['base'] === 'string' ? params['base'] : undefined,
      });
    case 'rank':
      return rankDocs({
        ownerId: String(params['ownerId']),
        query: typeof params['query'] === 'string' ? params['query'] : undefined,
        projectRoot,
      });
    case 'versions':
      return listDocVersions({
        ownerId: String(params['ownerId']),
        name: typeof params['name'] === 'string' ? params['name'] : undefined,
        projectRoot,
      });
    case 'status': {
      const model = createDocsReadModel();
      return model.status(projectRoot);
    }
    default:
      throw new Error(`Unsupported docs query operation: ${operation}`);
  }
}

async function dispatchDocsLegacyMutate(
  operation: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const projectRoot = getProjectRoot();
  switch (operation) {
    case 'publish': {
      const result = await publishDocs({
        ownerId: String(params['ownerId']),
        toPath: String(params['toPath']),
        attachmentId:
          typeof params['attachmentId'] === 'string' ? params['attachmentId'] : undefined,
        projectRoot,
      });
      try {
        await recordPublication({
          ownerId: result.ownerId,
          blobName: result.blobName,
          publishedPath: result.relativePath,
          lastBlobSha: result.blobSha256,
          projectRoot,
        });
      } catch {
        /* Ledger write is best-effort. */
      }
      // T11139 — audit trail
      try {
        writeAuditEntry(projectRoot, {
          op: 'docs.publish',
          slug: result.blobName,
          attachmentId: result.blobSha256,
          summary: `Published doc '${result.blobName}' to ${result.relativePath}`,
        });
      } catch {
        /* best-effort */
      }
      return result;
    }
    case 'publish-pr': {
      const prResult = await publishDocsAsPr({
        slugOrId: String(params['slugOrId']),
        ...(typeof params['slug'] === 'string' ? { slug: params['slug'] } : {}),
        ...(typeof params['type'] === 'string' ? { type: params['type'] } : {}),
        ...(typeof params['title'] === 'string' ? { title: params['title'] } : {}),
        ...(typeof params['body'] === 'string' ? { body: params['body'] } : {}),
        ...(typeof params['base'] === 'string' ? { base: params['base'] } : {}),
      });
      // T11139 — audit trail
      if (prResult.success) {
        try {
          writeAuditEntry(projectRoot, {
            op: 'docs.publish-pr',
            slug: prResult.data.slug,
            type: prResult.data.type,
            attachmentId: prResult.data.blobSha,
            summary: `Published PR for doc '${prResult.data.slug}' (${prResult.data.action}) — ${prResult.data.prUrl}`,
          });
        } catch {
          /* best-effort */
        }
      }
      return prResult;
    }
    case 'sync': {
      const syncResult = await syncFromGit({
        ownerId: String(params['ownerId']),
        fromPath: String(params['fromPath']),
        blobName: typeof params['blobName'] === 'string' ? params['blobName'] : undefined,
        contentType: typeof params['contentType'] === 'string' ? params['contentType'] : undefined,
        projectRoot,
      });
      // T11139 — audit trail
      try {
        writeAuditEntry(projectRoot, {
          op: 'docs.sync',
          slug: (typeof params['blobName'] === 'string' && params['blobName']) || undefined,
          ownerId: String(params['ownerId']),
          summary: `Synced doc from '${String(params['fromPath'])}' for owner ${String(params['ownerId'])}`,
        });
      } catch {
        /* best-effort */
      }
      return syncResult;
    }
    case 'import': {
      const scanRoot = String(params['scanRoot']);
      const accessor = createAttachmentStoreDocsAccessor(projectRoot);
      try {
        const result = await runDocsImport({
          root: scanRoot,
          accessor,
          dryRun: params['dryRun'] === true,
          force: params['force'] === true,
          manifestPath:
            typeof params['manifestPath'] === 'string' ? params['manifestPath'] : undefined,
          auditDir: projectRoot,
          classify: makeClassifierForScanRoot(scanRoot, projectRoot),
        });
        // T11139 — audit trail
        try {
          writeAuditEntry(projectRoot, {
            op: 'docs.import',
            summary: `Imported ${result.counters.importCount} created, ${result.counters.noopCount} skipped, ${result.counters.errorCount} errors from '${scanRoot}'`,
          });
        } catch {
          /* best-effort */
        }
        return {
          dryRun: result.dryRun,
          counters: result.counters,
          entries: result.entries,
          manifestPath: result.manifestPath ?? null,
        };
      } finally {
        await accessor.close().catch(() => {
          /* never fail on close */
        });
      }
    }
    default:
      throw new Error(`Unsupported docs mutate operation: ${operation}`);
  }
}

/**
 * Domain handler for `cleo docs` attachment operations.
 *
 * Delegates all per-op logic to the typed inner handler `_docsTypedHandler`
 * (a `TypedDomainHandler<DocsTypedOps>`). This satisfies the registry's
 * `DomainHandler` interface while keeping every param access fully type-safe
 * per ADR-058.
 *
 * @see ADR-058 — Dispatch type inference
 * @task T1529 — typed-dispatch migration (P0)
 */
export class DocsHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  /**
   * Execute a read-only docs query operation.
   *
   * @param operation - The docs query op name (e.g. 'list', 'fetch', 'generate').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!QUERY_OPS.has(operation)) {
      return unsupportedOp('query', 'docs', operation, startTime);
    }

    try {
      if (operation in _docsTypedHandler.operations) {
        const envelope = await typedDispatch(
          _docsTypedHandler,
          operation as keyof DocsTypedOps & string,
          params ?? {},
        );
        return docsEnvelopeToResponse(envelope, 'query', operation, startTime);
      }

      return {
        meta: dispatchMeta('query', 'docs', operation, startTime),
        success: true,
        data: await dispatchDocsLegacyQuery(operation, params ?? {}),
      };
    } catch (error) {
      return handleErrorResult('query', 'docs', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  /**
   * Execute a state-modifying docs mutation operation.
   *
   * @param operation - The docs mutate op name (e.g. 'add', 'remove').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!MUTATE_OPS.has(operation)) {
      return unsupportedOp('mutate', 'docs', operation, startTime);
    }

    try {
      if (operation in _docsTypedHandler.operations) {
        const envelope = await typedDispatch(
          _docsTypedHandler,
          operation as keyof DocsTypedOps & string,
          params ?? {},
        );
        return docsEnvelopeToResponse(envelope, 'mutate', operation, startTime);
      }

      return {
        meta: dispatchMeta('mutate', 'docs', operation, startTime),
        success: true,
        data: await dispatchDocsLegacyMutate(operation, params ?? {}),
      };
    } catch (error) {
      return handleErrorResult('mutate', 'docs', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'list',
        'fetch',
        'generate',
        'export',
        'search',
        'find',
        'merge',
        'rank',
        'versions',
        'status',
      ],
      mutate: ['add', 'remove', 'update', 'supersede', 'publish', 'publish-pr', 'sync', 'import'],
    };
  }
}
