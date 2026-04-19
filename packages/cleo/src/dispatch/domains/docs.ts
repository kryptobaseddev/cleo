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
 * @epic T760
 * @task T797
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp } from './_base.js';
import { dispatchMeta } from './_meta.js';

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

// ─── DocsHandler ──────────────────────────────────────────────────────────────

/**
 * Domain handler for `cleo docs` attachment operations.
 */
export class DocsHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        // ── docs.list ────────────────────────────────────────────────────
        case 'list': {
          const taskId = params?.task as string | undefined;
          const sessionId = params?.session as string | undefined;
          const observationId = params?.observation as string | undefined;

          const ownerId = taskId ?? sessionId ?? observationId;
          if (!ownerId) {
            return errorResult(
              'query',
              'docs',
              operation,
              'E_INVALID_INPUT',
              'Provide one of --task, --session, or --observation to scope the list.',
              startTime,
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

          return {
            meta: {
              ...dispatchMeta('query', 'docs', operation, startTime),
              attachmentBackend: backend,
            },
            success: true,
            data: {
              ownerId,
              ownerType,
              count: attachments.length,
              attachments: attachments.map((m) => ({
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
              })),
            },
          };
        }

        // ── docs.generate ────────────────────────────────────────────────
        case 'generate': {
          const forId = params?.for as string | undefined;
          if (!forId) {
            return errorResult(
              'query',
              'docs',
              operation,
              'E_INVALID_INPUT',
              '--for <taskId|epicId> is required',
              startTime,
            );
          }

          const attach = params?.attach as boolean | undefined;
          const cwd = getProjectRoot();

          const result = await generateDocsLlmsTxt({
            ownerId: forId,
            cwd,
          });

          let attachmentId: string | undefined;
          let attachmentSha256: string | undefined;

          if (attach) {
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

          return {
            meta: dispatchMeta('query', 'docs', operation, startTime),
            success: true,
            data: {
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
          };
        }

        // ── docs.fetch ───────────────────────────────────────────────────
        case 'fetch': {
          const ref = params?.attachmentRef as string | undefined;
          if (!ref) {
            return errorResult(
              'query',
              'docs',
              operation,
              'E_INVALID_INPUT',
              'attachmentRef is required (attachment ID or SHA-256 hex)',
              startTime,
            );
          }

          const store = createAttachmentStore();

          // Try by attachment ID first, then by SHA-256.
          const isSha256 = /^[0-9a-f]{64}$/i.test(ref);
          let result: Awaited<ReturnType<typeof store.get>> | null = null;
          let metadata = await store.getMetadata(ref);

          if (metadata) {
            // Resolved by ID — get bytes via sha256
            result = await store.get(metadata.sha256);
          } else if (isSha256) {
            result = await store.get(ref);
            if (result) {
              metadata = result.metadata;
            }
          }

          if (!result || !metadata) {
            return errorResult(
              'query',
              'docs',
              operation,
              'E_NOT_FOUND',
              `Attachment not found: ${ref}`,
              startTime,
            );
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
              metadata.attachment.kind === 'blob'
                ? metadata.attachment.mime
                : 'application/octet-stream';
            const ext = extMap[mime] ?? '.bin';
            storagePath = resolve(cleoDir, 'attachments', 'sha256', prefix, `${rest}${ext}`);
          }

          // Base64-encode bytes only for small attachments (<= 1 MB)
          const MAX_INLINE = 1024 * 1024;
          const bytesBase64 =
            result.bytes.length <= MAX_INLINE ? result.bytes.toString('base64') : undefined;

          const backend: AttachmentBackend = await resolveAttachmentBackend();

          return {
            meta: {
              ...dispatchMeta('query', 'docs', operation, startTime),
              attachmentBackend: backend,
            },
            success: true,
            data: {
              metadata,
              path: storagePath,
              sizeBytes: result.bytes.length,
              ...(bytesBase64 !== undefined ? { bytesBase64 } : {}),
              inlined: bytesBase64 !== undefined,
            },
          };
        }

        default:
          return unsupportedOp('query', 'docs', operation, startTime);
      }
    } catch (error) {
      return handleErrorResult('query', 'docs', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        // ── docs.add ─────────────────────────────────────────────────────
        case 'add': {
          const ownerId = params?.ownerId as string | undefined;
          if (!ownerId) {
            return errorResult(
              'mutate',
              'docs',
              operation,
              'E_INVALID_INPUT',
              'ownerId is required',
              startTime,
            );
          }

          const filePath = params?.file as string | undefined;
          const url = params?.url as string | undefined;

          if (!filePath && !url) {
            return errorResult(
              'mutate',
              'docs',
              operation,
              'E_INVALID_INPUT',
              'Provide either a file path (positional or --file) or --url',
              startTime,
            );
          }

          const description = params?.desc as string | undefined;
          const labels = parseLabels(params?.labels);
          const attachedBy = (params?.attachedBy as string | undefined) ?? 'human';
          const ownerType = inferOwnerType(ownerId);
          const store = createAttachmentStore();

          if (filePath) {
            // Local file attachment
            const absPath = resolve(filePath);
            let bytes: Buffer;
            try {
              bytes = await readFile(absPath);
            } catch {
              return errorResult(
                'mutate',
                'docs',
                operation,
                'E_FILE_ERROR',
                `Cannot read file: ${absPath}`,
                startTime,
              );
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

            return {
              meta: {
                ...dispatchMeta('mutate', 'docs', operation, startTime),
                attachmentBackend: backend,
              },
              success: true,
              data: {
                attachmentId: meta.id,
                sha256: meta.sha256,
                refCount: meta.refCount,
                kind: 'local-file',
                ownerId,
                ownerType,
              },
            };
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

            return {
              meta: {
                ...dispatchMeta('mutate', 'docs', operation, startTime),
                attachmentBackend: backend,
              },
              success: true,
              data: {
                attachmentId: meta.id,
                sha256: meta.sha256,
                refCount: meta.refCount,
                kind: 'url',
                url,
                ownerId,
                ownerType,
              },
            };
          }

          // Should not reach here
          return errorResult(
            'mutate',
            'docs',
            operation,
            'E_INVALID_INPUT',
            'Unreachable: no file or url',
            startTime,
          );
        }

        // ── docs.remove ──────────────────────────────────────────────────
        case 'remove': {
          const ref = params?.attachmentRef as string | undefined;
          const fromOwner = params?.from as string | undefined;

          if (!ref) {
            return errorResult(
              'mutate',
              'docs',
              operation,
              'E_INVALID_INPUT',
              'attachmentRef is required (attachment ID or SHA-256 hex)',
              startTime,
            );
          }
          if (!fromOwner) {
            return errorResult(
              'mutate',
              'docs',
              operation,
              'E_INVALID_INPUT',
              '--from <ownerId> is required',
              startTime,
            );
          }

          const store = createAttachmentStore();
          const ownerType = inferOwnerType(fromOwner);

          // Resolve attachment ID if SHA-256 was given
          let attachmentId = ref;
          if (/^[0-9a-f]{64}$/i.test(ref)) {
            const result = await store.get(ref);
            if (!result) {
              return errorResult(
                'mutate',
                'docs',
                operation,
                'E_NOT_FOUND',
                `No attachment found with SHA-256: ${ref}`,
                startTime,
              );
            }
            attachmentId = result.metadata.id;
          }

          const derefResult: DerefResult = await store.deref(attachmentId, ownerType, fromOwner);

          if (derefResult.status === 'not-found') {
            return errorResult(
              'mutate',
              'docs',
              operation,
              'E_NOT_FOUND',
              `Attachment ref not found: ${attachmentId} on owner ${fromOwner}`,
              startTime,
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

          return {
            meta: {
              ...dispatchMeta('mutate', 'docs', operation, startTime),
              attachmentBackend: backend,
            },
            success: true,
            data: {
              removed: blobPurged,
              attachmentId,
              from: fromOwner,
              refCountAfter,
              blobPurged,
            },
          };
        }

        default:
          return unsupportedOp('mutate', 'docs', operation, startTime);
      }
    } catch (error) {
      return handleErrorResult('mutate', 'docs', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['list', 'fetch', 'generate'],
      mutate: ['add', 'remove'],
    };
  }
}
