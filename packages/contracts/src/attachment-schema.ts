/**
 * Zod validation schemas for {@link Attachment} and related types.
 *
 * Kept in a separate file from the plain TypeScript types so that consumers
 * that do not need runtime validation (e.g. type-only imports) pay zero cost.
 *
 * All schemas are named `*Schema` and their inferred types are compatible with
 * the canonical TypeScript interfaces in `./attachment.ts`.
 *
 * Uses `z.discriminatedUnion('kind', [...])` for O(1) variant lookup on the
 * `kind` discriminant.
 *
 * @epic T760
 * @task T795
 */

import { z } from 'zod';

// ─── Shared field schemas ──────────────────────────────────────────────────────

/**
 * Common optional fields shared by all attachment variants.
 *
 * Not exported as a standalone validator — always composed into full variant
 * schemas via `.extend()`.
 */
const attachmentCommonSchema = z.object({
  /** Free-text description of what this attachment contains. */
  description: z.string().optional(),
  /** Labels for filtering (e.g., `["rfc", "spec"]`). */
  labels: z.array(z.string()).optional(),
});

// ─── Variant schemas ───────────────────────────────────────────────────────────

/**
 * Zod schema for {@link LocalFileAttachment}.
 *
 * Validates that `path` is non-empty, `sha256` is a 64-character hex string,
 * and `size` is a non-negative integer.
 */
export const localFileAttachmentSchema = attachmentCommonSchema.extend({
  kind: z.literal('local-file'),
  /** Path to the file (absolute or project-root-relative, forward-slashes only). */
  path: z.string().min(1),
  /** SHA-256 hex digest (64 hex characters). */
  sha256: z.string().length(64),
  /** IANA MIME type. */
  mime: z.string().min(1),
  /** File size in bytes (non-negative integer). */
  size: z.number().int().nonnegative(),
});

/**
 * Zod schema for {@link UrlAttachment}.
 *
 * Validates that `url` is a well-formed absolute URL. The optional `cachedSha256`
 * is validated as a 64-character hex string when present.
 */
export const urlAttachmentSchema = attachmentCommonSchema.extend({
  kind: z.literal('url'),
  /** The remote URL — must be a valid absolute URL. */
  url: z.string().url(),
  /** SHA-256 of the cached body (64 hex characters). */
  cachedSha256: z.string().length(64).optional(),
  /** ISO 8601 timestamp when the body was cached. */
  cachedAt: z.string().datetime().optional(),
  /** IANA MIME type detected from the Content-Type header. */
  mime: z.string().optional(),
});

/**
 * Zod schema for {@link BlobAttachment}.
 *
 * Validates that `sha256` is 64 hex characters, `storageKey` is non-empty,
 * and `size` is a non-negative integer.
 */
export const blobAttachmentSchema = attachmentCommonSchema.extend({
  kind: z.literal('blob'),
  /** SHA-256 hex digest of the uncompressed content (64 hex characters). */
  sha256: z.string().length(64),
  /** Storage key inside `.cleo/attachments/sha256/`. */
  storageKey: z.string().min(1),
  /** IANA MIME type. */
  mime: z.string().min(1),
  /** Size of the uncompressed content in bytes. */
  size: z.number().int().nonnegative(),
});

/**
 * Zod schema for {@link LlmsTxtAttachment}.
 *
 * Validates that `content` is non-empty, `sha256` is 64 hex characters, and
 * `source` is one of the two allowed literal values.
 */
export const llmsTxtAttachmentSchema = attachmentCommonSchema.extend({
  kind: z.literal('llms-txt'),
  /** Where the llms.txt content originated. */
  source: z.enum(['url', 'generated']),
  /** Full markdown content of the llms.txt (stored inline). */
  content: z.string().min(1),
  /** SHA-256 hex digest of `content` (64 hex characters). */
  sha256: z.string().length(64),
});

/**
 * Zod schema for {@link LlmtxtDocAttachment}.
 *
 * Validates that `slug` is non-empty and `backend` is one of the two allowed
 * literal values. `pinnedVersion` is an opaque string when present.
 */
export const llmtxtDocAttachmentSchema = attachmentCommonSchema.extend({
  kind: z.literal('llmtxt-doc'),
  /** Document slug from the llmtxt backend. */
  slug: z.string().min(1),
  /** Which backend owns the document. */
  backend: z.enum(['local', 'remote']),
  /**
   * Version string pinned at attach time.
   *
   * Opaque: integer version for local backends, API-assigned string for remote.
   */
  pinnedVersion: z.string().optional(),
});

// ─── Discriminated union ──────────────────────────────────────────────────────

/**
 * Zod discriminated-union schema for {@link Attachment}.
 *
 * Uses `z.discriminatedUnion('kind', [...])` for O(1) variant lookup.
 * Parse with `attachmentSchema.parse(input)` or
 * `attachmentSchema.safeParse(input)`.
 *
 * @example
 * ```ts
 * const att = attachmentSchema.parse({
 *   kind: 'local-file',
 *   path: 'docs/rfc-003.md',
 *   sha256: 'a'.repeat(64),
 *   mime: 'text/markdown',
 *   size: 8192,
 *   description: 'RFC draft v3',
 * });
 * ```
 */
export const attachmentSchema = z.discriminatedUnion('kind', [
  localFileAttachmentSchema,
  urlAttachmentSchema,
  blobAttachmentSchema,
  llmsTxtAttachmentSchema,
  llmtxtDocAttachmentSchema,
]);

/** Inferred TypeScript type from {@link attachmentSchema}. */
export type AttachmentSchemaInput = z.input<typeof attachmentSchema>;

// ─── AttachmentMetadata schema ────────────────────────────────────────────────

/**
 * Zod schema for {@link AttachmentMetadata}.
 *
 * Validates the persisted registry row. The embedded `attachment` field is
 * validated recursively through the discriminated union.
 */
export const attachmentMetadataSchema = z.object({
  /**
   * Unique attachment ID.
   *
   * Pattern: `att_<base62>` or UUID fallback. Must be non-empty.
   */
  id: z.string().min(1),
  /**
   * Content hash — SHA-256 hex (64 chars) for byte-backed kinds, empty string
   * for kinds that delegate content storage externally.
   */
  sha256: z.string(),
  /** The full attachment value (validated through the discriminated union). */
  attachment: attachmentSchema,
  /** ISO 8601 creation timestamp. */
  createdAt: z.string().datetime(),
  /**
   * Reference count — how many `AttachmentRef` rows point at this attachment.
   *
   * Must be a non-negative integer.
   */
  refCount: z.number().int().nonnegative(),
});

/** Inferred TypeScript type from {@link attachmentMetadataSchema}. */
export type AttachmentMetadataSchemaInput = z.input<typeof attachmentMetadataSchema>;

// ─── AttachmentRef schema ─────────────────────────────────────────────────────

/**
 * Zod schema for {@link AttachmentRef}.
 *
 * Validates the junction row linking one attachment to one owner. `ownerType`
 * is restricted to the six supported CLEO entity types.
 */
export const attachmentRefSchema = z.object({
  /** ID of the attachment (→ `attachments.id`). Must be non-empty. */
  attachmentId: z.string().min(1),
  /**
   * The domain entity type that owns this attachment.
   *
   * Restricted to the six supported CLEO entity types.
   */
  ownerType: z.enum(['task', 'observation', 'session', 'decision', 'learning', 'pattern']),
  /** ID of the owning entity. Must be non-empty. */
  ownerId: z.string().min(1),
  /** ISO 8601 timestamp when the ref was created. */
  attachedAt: z.string().datetime(),
  /**
   * Agent identity (or `"human"`) that created the ref.
   *
   * Optional; populated from the active session credential when available.
   */
  attachedBy: z.string().optional(),
});

/** Inferred TypeScript type from {@link attachmentRefSchema}. */
export type AttachmentRefSchemaInput = z.input<typeof attachmentRefSchema>;
