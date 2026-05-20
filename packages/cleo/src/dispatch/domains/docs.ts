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
import type {
  DocsAddParams,
  DocsAddResult,
  DocsFetchParams,
  DocsFetchResult,
  DocsGenerateParams,
  DocsGenerateResult,
  DocsListParams,
  DocsListResult,
  DocsRemoveParams,
  DocsRemoveResult,
  DocsType,
} from '@cleocode/contracts/operations/docs';
import type {
  AttachmentRef,
  LlmsTxtAttachment,
  LocalFileAttachment,
  UrlAttachment,
} from '@cleocode/core/internal';
import {
  type AttachmentBackend,
  createAttachmentStore,
  createAttachmentStoreV2,
  type DerefResult,
  generateDocsLlmsTxt,
  getCleoDirAbsolute,
  getProjectRoot,
  resolveAttachmentBackend,
  SlugCollisionError,
} from '@cleocode/core/internal';
import { defineTypedHandler, lafsError, lafsSuccess, typedDispatch } from '../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { handleErrorResult, unsupportedOp } from './_base.js';
import { dispatchMeta } from './_meta.js';

/**
 * Local copy of the closed taxonomy values for runtime validation.
 *
 * Kept in lock-step with `DOCS_TYPE_VALUES` exported from
 * `@cleocode/contracts/operations/docs` — the contracts module is the
 * authoritative SSoT; this constant exists only because the test runner's
 * alias map doesn't resolve subpath runtime imports for `@cleocode/contracts`,
 * forcing the dispatch layer to keep a local mirror.
 *
 * @task T9637
 */
const DOCS_TYPE_VALUES = [
  'spec',
  'adr',
  'research',
  'handoff',
  'note',
  'llm-readme',
] as const satisfies readonly DocsType[];

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
  readonly add: readonly [DocsAddParams, DocsAddResult];
  readonly remove: readonly [DocsRemoveParams, DocsRemoveResult];
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
 * Validate a type value against the closed {@link DOCS_TYPE_VALUES} set.
 *
 * @task T9637
 */
function validateDocsType(raw: unknown): raw is DocsType {
  return typeof raw === 'string' && (DOCS_TYPE_VALUES as readonly string[]).includes(raw as string);
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
    const isProjectScope = params.project === true;

    if (!ownerId && !isProjectScope) {
      return lafsError(
        'E_INVALID_INPUT',
        'Provide one of --task, --session, --observation, or --project to scope the list.',
        'list',
      );
    }

    // Validate `--type` filter if provided (T9637).
    let typeFilter: DocsType | undefined;
    if (params.type !== undefined) {
      if (!validateDocsType(params.type)) {
        return lafsError(
          'E_INVALID_TYPE',
          `type must be one of: ${DOCS_TYPE_VALUES.join('|')} — got '${String(params.type)}'`,
          'list',
        );
      }
      typeFilter = params.type;
    }

    const store = createAttachmentStore();
    const backend: AttachmentBackend = await resolveAttachmentBackend();

    if (isProjectScope) {
      // T9638 — project-scoped listing: union all attachment_refs into a flat
      // row list. The shape stays compatible with DocsAttachmentRow by
      // populating `ownerId` / `ownerType` per row instead of at the envelope.
      const rows = await store.listAllInProject(
        undefined,
        typeFilter !== undefined ? { type: typeFilter } : undefined,
      );

      return lafsSuccess<DocsListResult>(
        {
          ownerId: '',
          ownerType: 'task',
          project: true,
          ...(typeFilter !== undefined ? { type: typeFilter } : {}),
          count: rows.length,
          attachments: rows.map(({ metadata: m, slug, type, ownerId: oid, ownerType: ot }) => ({
            id: m.id,
            sha256: `${m.sha256.slice(0, 8)}…`,
            kind: m.attachment.kind,
            mime:
              m.attachment.kind === 'local-file' || m.attachment.kind === 'blob'
                ? m.attachment.mime
                : ((m.attachment as UrlAttachment).mime ?? '—'),
            size:
              m.attachment.kind === 'local-file' || m.attachment.kind === 'blob'
                ? m.attachment.size
                : undefined,
            description: m.attachment.description,
            labels: m.attachment.labels,
            createdAt: m.createdAt,
            refCount: m.refCount,
            ...(slug ? { slug } : {}),
            ...(type ? { type: type as DocsType } : {}),
            ownerId: oid,
            ownerType: ot,
          })),
          attachmentBackend: backend as DocsListResult['attachmentBackend'],
        },
        'list',
      );
    }

    // Owner-scoped listing (existing behaviour) — narrow to non-null after
    // the project-scope branch.
    const scopedOwner = ownerId as string;
    const ownerType = inferOwnerType(scopedOwner);
    // Legacy store still drives the envelope because it tracks URL and
    // llms-txt kinds the v2 interface does not expose. `backend` metadata
    // reports the path that FUTURE writes would take, so operators can
    // observe llmtxt adoption without changing the data contract.
    const ownerAttachments = await store.listByOwner(ownerType, scopedOwner);

    // T9637 — apply the type filter post-list. listByOwner returns
    // AttachmentMetadata (no slug/type), so we re-hydrate via getExtras().
    const enriched: Array<{
      meta: (typeof ownerAttachments)[number];
      slug: string | null;
      type: string | null;
    }> = [];
    for (const m of ownerAttachments) {
      const extras = await store.getExtras(m.id);
      const slug = extras?.slug ?? null;
      const type = extras?.type ?? null;
      if (typeFilter !== undefined && type !== typeFilter) continue;
      enriched.push({ meta: m, slug, type });
    }

    return lafsSuccess<DocsListResult>(
      {
        ownerId: scopedOwner,
        ownerType,
        ...(typeFilter !== undefined ? { type: typeFilter } : {}),
        count: enriched.length,
        attachments: enriched.map(({ meta: m, slug, type }) => ({
          id: m.id,
          sha256: `${m.sha256.slice(0, 8)}…`,
          kind: m.attachment.kind,
          mime:
            m.attachment.kind === 'local-file' || m.attachment.kind === 'blob'
              ? m.attachment.mime
              : ((m.attachment as UrlAttachment).mime ?? '—'),
          size:
            m.attachment.kind === 'local-file' || m.attachment.kind === 'blob'
              ? m.attachment.size
              : undefined,
          description: m.attachment.description,
          labels: m.attachment.labels,
          createdAt: m.createdAt,
          refCount: m.refCount,
          ...(slug ? { slug } : {}),
          ...(type ? { type: type as DocsType } : {}),
        })),
        // Cast: core returns 'llmtxt'|'legacy'; contracts uses 'legacy'|'llmstxt-v2' (drift T1529)
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

    const store = createAttachmentStore();

    // Resolution order (T9636 acceptance #5/#7):
    //   1. Full SHA-256 hex (64 chars, case-insensitive)
    //   2. Attachment ID (att_* / UUID)
    //   3. Slug (kebab-case match)
    //   4. SHA-256 prefix (>= 6 hex chars, unique match)
    //
    // The order keeps backward-compat: pre-T9636 callers pass att_id or full
    // sha256; new callers can pass slug. The slug check comes BEFORE prefix
    // resolution because slugs have a stricter pattern (lowercase letters
    // mixed with hyphens) than a hex prefix, so the discriminator is exact.
    const isSha256 = /^[0-9a-f]{64}$/i.test(ref);
    const looksLikeAttId = /^(att_|[0-9a-f]{8}-)/i.test(ref);
    const looksLikeSlug = SLUG_PATTERN.test(ref) && !/^[0-9a-f]+$/i.test(ref);
    const isHexPrefix = /^[0-9a-f]{6,63}$/i.test(ref);

    let fetchResult: Awaited<ReturnType<typeof store.get>> | null = null;
    let metadata = isSha256 ? null : looksLikeAttId ? await store.getMetadata(ref) : null;

    if (metadata) {
      // Resolved by ID — get bytes via sha256
      fetchResult = await store.get(metadata.sha256);
    } else if (isSha256) {
      fetchResult = await store.get(ref);
      if (fetchResult) {
        metadata = fetchResult.metadata;
      }
    }

    // Slug fallback
    if (!metadata && looksLikeSlug) {
      const bySlug = await store.findBySlug(ref);
      if (bySlug) {
        metadata = bySlug.metadata;
        fetchResult = await store.get(metadata.sha256);
      }
    }

    // SHA-256 prefix fallback (>=6 chars). We scan attachment_refs distinct
    // ids and find the unique row whose sha256 startsWith ref. Ambiguous
    // prefixes return E_AMBIGUOUS to avoid silently picking the wrong blob.
    if (!metadata && isHexPrefix) {
      const projectList = await store.listAllInProject();
      const seen = new Map<string, (typeof projectList)[number]>();
      for (const row of projectList) {
        if (row.metadata.sha256.toLowerCase().startsWith(ref.toLowerCase())) {
          seen.set(row.metadata.id, row);
        }
      }
      if (seen.size > 1) {
        return lafsError(
          'E_AMBIGUOUS',
          `sha256 prefix '${ref}' matches ${seen.size} attachments — provide more hex digits`,
          'fetch',
        );
      }
      const hit = seen.values().next().value;
      if (hit) {
        metadata = hit.metadata;
        fetchResult = await store.get(metadata.sha256);
      }
    }

    // Fallback: try plain getMetadata even if it didn't look like an att-id —
    // some pre-T9636 callers used arbitrary IDs.
    if (!metadata && !looksLikeAttId) {
      const direct = await store.getMetadata(ref);
      if (direct) {
        metadata = direct;
        fetchResult = await store.get(direct.sha256);
      }
    }

    if (!fetchResult || !metadata) {
      return lafsError('E_NOT_FOUND', `Attachment not found: ${ref}`, 'fetch');
    }

    const cwd = getProjectRoot();
    const cleoDir = getCleoDirAbsolute(cwd);

    // Derive storage path for local-file / blob kinds
    let storagePath: string | undefined;
    if (metadata.attachment.kind === 'local-file') {
      storagePath = (metadata.attachment as LocalFileAttachment).path;
    } else if (metadata.attachment.kind === 'blob') {
      const prefix = metadata.sha256.slice(0, 2);
      const rest = metadata.sha256.slice(2);
      const extMap: Record<string, string> = {
        'text/markdown': '.md',
        'text/plain': '.txt',
        'application/json': '.json',
        'application/pdf': '.pdf',
      };
      const mime =
        metadata.attachment.kind === 'blob' ? metadata.attachment.mime : 'application/octet-stream';
      const ext = extMap[mime] ?? '.bin';
      storagePath = resolve(cleoDir, 'attachments', 'sha256', prefix, `${rest}${ext}`);
    }

    // Base64-encode bytes only for small attachments (<= 1 MB)
    const MAX_INLINE = 1024 * 1024;
    const bytesBase64 =
      fetchResult.bytes.length <= MAX_INLINE ? fetchResult.bytes.toString('base64') : undefined;

    const backend: AttachmentBackend = await resolveAttachmentBackend();

    // Re-read slug so the wire envelope mirrors what's in the DB (T9636).
    const extras = await store.getExtras(metadata.id);

    return lafsSuccess<DocsFetchResult>(
      {
        // Project the domain AttachmentMetadata (nested `attachment` object) into the
        // flat DocsAttachmentRow wire format consumed by CLI + HTTP callers.
        metadata: {
          id: metadata.id,
          sha256: metadata.sha256,
          kind: metadata.attachment.kind,
          mime:
            metadata.attachment.kind === 'local-file' || metadata.attachment.kind === 'blob'
              ? metadata.attachment.mime
              : (metadata.attachment as UrlAttachment).mime,
          size:
            metadata.attachment.kind === 'local-file' || metadata.attachment.kind === 'blob'
              ? metadata.attachment.size
              : undefined,
          description: metadata.attachment.description,
          labels: metadata.attachment.labels,
          createdAt: metadata.createdAt,
          refCount: metadata.refCount,
          ...(extras?.slug ? { slug: extras.slug } : {}),
          ...(extras?.type ? { type: extras.type as DocsType } : {}),
        },
        path: storagePath,
        sizeBytes: fetchResult.bytes.length,
        ...(bytesBase64 !== undefined ? { bytesBase64 } : {}),
        inlined: bytesBase64 !== undefined,
        // Cast: core returns 'llmtxt'|'legacy'; contracts uses 'legacy'|'llmstxt-v2' (T1529)
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
      type: rawType,
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

    // T9636 — validate slug (shape only; uniqueness is checked by the store).
    let slug: string | undefined;
    if (rawSlug !== undefined) {
      const check = validateSlug(rawSlug);
      if (!check.valid) {
        return lafsError('E_INVALID_SLUG', check.reason, 'add');
      }
      slug = rawSlug as string;
    }

    // T9637 — validate type against the closed taxonomy set.
    let type: DocsType | undefined;
    if (rawType !== undefined) {
      if (!validateDocsType(rawType)) {
        return lafsError(
          'E_INVALID_TYPE',
          `type must be one of: ${DOCS_TYPE_VALUES.join('|')} — got '${String(rawType)}'`,
          'add',
        );
      }
      type = rawType;
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
        if (err instanceof SlugCollisionError) {
          // Construct the envelope directly so we can attach `suggestions` to
          // the error.details payload — `lafsError()` does not accept extra
          // fields beyond `code/message/fix`.
          return {
            success: false,
            error: {
              code: 'E_SLUG_TAKEN',
              message: `slug '${err.slug}' is already in use in this project`,
              details: { suggestions: err.suggestions },
            },
          };
        }
        throw err;
      }

      // T947 Wave B — also mirror the write through the unified v2 store
      // so llmtxt-backed manifests learn about the attachment. The v2
      // store is the future SSoT; the legacy put above remains the
      // authoritative write path until Wave C retires it.
      let backend: AttachmentBackend = 'legacy';
      try {
        const v2 = createAttachmentStoreV2(getProjectRoot());
        const v2Result = await v2.put(ownerId, {
          name: absPath.split(/[\\/]/).pop() ?? meta.sha256.slice(0, 12),
          data: new Uint8Array(bytes),
          contentType: mime,
        });
        backend = v2Result.backend;
      } catch {
        // Mirror write is best-effort — never fail docs add on it.
        backend = await resolveAttachmentBackend();
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
        if (err instanceof SlugCollisionError) {
          return {
            success: false,
            error: {
              code: 'E_SLUG_TAKEN',
              message: `slug '${err.slug}' is already in use in this project`,
              details: { suggestions: err.suggestions },
            },
          };
        }
        throw err;
      }

      // T945 Stage A — mint `llmtxt:<sha256>` node + `embeds` edge for the
      // URL attachment (the URL itself is the content-addressable identity).
      import('@cleocode/core/internal')
        .then(({ ensureLlmtxtNode }) =>
          ensureLlmtxtNode(getProjectRoot(), meta.sha256, `${ownerType}:${ownerId}`, url),
        )
        .catch(() => {
          /* Graph population is best-effort — never fail docs add. */
        });

      // URL writes stay legacy-only; v2 focuses on local-file / blob kinds.
      const backend: AttachmentBackend = 'legacy';

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

    // T947 Wave B — mirror the remove through v2 so llmtxt manifests
    // also soft-delete. Best-effort: the llmtxt path keys by blob name,
    // and we only know the attachment id here, so the mirror only hits
    // when v2 has already indexed this id (e.g. earlier put in same
    // process). Legacy refcount remains the authoritative truth.
    try {
      const v2 = createAttachmentStoreV2(getProjectRoot());
      await v2.remove(attachmentId, fromOwner);
    } catch {
      /* Mirror remove is best-effort. */
    }
    const backend: AttachmentBackend = await resolveAttachmentBackend();

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
    error?: { code: string | number; message: string; details?: Record<string, unknown> };
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
        // T9636 — preserve structured details (e.g. slug suggestions) so the
        // CLI can render alternative slugs without a separate API call.
        ...(envelope.error?.details !== undefined ? { details: envelope.error.details } : {}),
      },
    };
  }

  // Extract attachmentBackend from data (if present) and lift into meta.
  let attachmentBackend: AttachmentBackend | undefined;
  let responseData = envelope.data;

  if (responseData !== null && responseData !== undefined && typeof responseData === 'object') {
    const dataObj = responseData as Record<string, unknown>;
    if ('attachmentBackend' in dataObj && dataObj['attachmentBackend'] !== undefined) {
      attachmentBackend = dataObj['attachmentBackend'] as AttachmentBackend;
      // Remove from data so consumers don't see it doubled
      const { attachmentBackend: _lifted, ...cleanData } = dataObj;
      responseData = cleanData;
    }
  }

  return {
    meta: {
      ...dispatchMeta(gateway, 'docs', operation, startTime),
      ...(attachmentBackend !== undefined ? { attachmentBackend } : {}),
    },
    success: true,
    data: responseData,
  };
}

// ─── DocsHandler ──────────────────────────────────────────────────────────────

const QUERY_OPS = new Set<string>(['list', 'fetch', 'generate']);
const MUTATE_OPS = new Set<string>(['add', 'remove']);

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
      const envelope = await typedDispatch(
        _docsTypedHandler,
        operation as keyof DocsTypedOps & string,
        params ?? {},
      );
      return docsEnvelopeToResponse(envelope, 'query', operation, startTime);
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
      const envelope = await typedDispatch(
        _docsTypedHandler,
        operation as keyof DocsTypedOps & string,
        params ?? {},
      );
      return docsEnvelopeToResponse(envelope, 'mutate', operation, startTime);
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
      query: ['list', 'fetch', 'generate'],
      mutate: ['add', 'remove'],
    };
  }
}
