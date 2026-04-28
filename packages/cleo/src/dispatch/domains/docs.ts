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
} from '@cleocode/core/internal';
import { defineTypedHandler, lafsError, lafsSuccess, typedDispatch } from '../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { handleErrorResult, unsupportedOp } from './_base.js';
import { dispatchMeta } from './_meta.js';

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
    if (!ownerId) {
      return lafsError(
        'E_INVALID_INPUT',
        'Provide one of --task, --session, or --observation to scope the list.',
        'list',
      );
    }

    const ownerType = inferOwnerType(ownerId);
    // Legacy store still drives the envelope because it tracks URL and
    // llms-txt kinds the v2 interface does not expose. `backend` metadata
    // reports the path that FUTURE writes would take, so operators can
    // observe llmtxt adoption without changing the data contract.
    const store = createAttachmentStore();
    const attachments = await store.listByOwner(ownerType, ownerId);
    const backend: AttachmentBackend = await resolveAttachmentBackend();

    return lafsSuccess<DocsListResult>(
      {
        ownerId,
        ownerType,
        count: attachments.length,
        attachments: attachments.map((m) => ({
          id: m.id,
          sha256: `${m.sha256.slice(0, 8)}…`,
          // Cast: contracts AttachmentKind doesn't include 'llmtxt-doc' (contracts gap T1529)
          kind: m.attachment.kind as DocsListResult['attachments'][0]['kind'],
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

    // Try by attachment ID first, then by SHA-256.
    const isSha256 = /^[0-9a-f]{64}$/i.test(ref);
    let fetchResult: Awaited<ReturnType<typeof store.get>> | null = null;
    let metadata = await store.getMetadata(ref);

    if (metadata) {
      // Resolved by ID — get bytes via sha256
      fetchResult = await store.get(metadata.sha256);
    } else if (isSha256) {
      fetchResult = await store.get(ref);
      if (fetchResult) {
        metadata = fetchResult.metadata;
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

    return lafsSuccess<DocsFetchResult>(
      {
        // Cast: core's AttachmentMetadata vs contracts/operations/docs AttachmentMetadata differ
        // in their nested attachment field structure (T1529 contracts gap). The runtime
        // value is compatible for all callers; the two interfaces diverged at the type level.
        metadata: metadata as unknown as DocsFetchResult['metadata'],
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

      const meta = await store.put(bytes, attachment, ownerType, ownerId, attachedBy);

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
      const meta = await store.put(urlBytes, attachment, ownerType, ownerId, attachedBy);

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
    error?: { code: string | number; message: string };
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
