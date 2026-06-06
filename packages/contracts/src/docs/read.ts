/**
 * `docs.read` core-SDK contract — the envelope-typed surface an external
 * consumer (the Obsidian plugin, `cleo docs view`) calls to render a single
 * CLEO doc directly from `cleo.db`, the SOLE doc authority (saga T11778).
 *
 * The response carries the doc **body** plus its full provenance **frontmatter**
 * (slug, version anchors, supersession pointers, related tasks, topics). Binary
 * or non-UTF-8 bodies are surfaced as base64 (T11825 AC2) so a consumer can
 * render images/PDFs/files stored as blobs without a second round-trip.
 *
 * Part of the T10400 core-SDK API standard — this is a typed contract, not an
 * ad-hoc shape (T11825 AC3).
 *
 * @task T11825 (Epic T11781 / Saga T11778)
 * @adr ADR-078 — Docs SSoT as provenance graph
 */

import { z } from 'zod';

/**
 * Provenance frontmatter for a doc, sourced from the `attachments` columns that
 * back the docs SSoT. Mirrors what a published doc's YAML frontmatter would
 * carry, but read live from the DB rather than a file.
 *
 * @task T11825
 */
export interface DocFrontmatter {
  /** Stable human-readable slug (`attachments.slug`). */
  readonly slug: string;
  /** Doc-kind taxonomy tag (e.g. `adr`, `spec`), or null for untyped blobs. */
  readonly kind: string | null;
  /** Display title (falls back to slug). */
  readonly title: string | null;
  /** One-sentence human summary, distinct from the body. */
  readonly summary: string | null;
  /** Document workflow state (`draft | active | superseded | …`). */
  readonly lifecycleStatus: string;
  /** Sequential doc-version counter for this slug (`attachments.doc_version`). */
  readonly docVersion: number;
  /** CLEO release version that wrote this row (`attachments.owner_version`). */
  readonly ownerVersion: string | null;
  /** Slug of the doc this one supersedes, or null. */
  readonly supersedes: string | null;
  /** Slug of the doc that supersedes this one, or null. */
  readonly supersededBy: string | null;
  /** Canonical topic slugs this doc carries (`attachments.topics`). */
  readonly topics: readonly string[];
  /** `T####` task ids this doc relates to (`attachments.related_tasks`). */
  readonly relatedTasks: readonly string[];
  /** SHA-256 content address of the body. */
  readonly sha256: string;
  /** ISO-8601 creation instant. */
  readonly createdAt: string;
}

/**
 * The body payload of a doc read.
 *
 * Exactly one of {@link text} / {@link base64} is populated: UTF-8-decodable
 * content is surfaced as `text` with `encoding: 'utf-8'`; binary content is
 * surfaced as `base64` with `encoding: 'base64'`.
 *
 * @task T11825
 */
export interface DocBody {
  /** How {@link DocReadResponse.body} content is encoded. */
  readonly encoding: 'utf-8' | 'base64';
  /** UTF-8 body text, present when `encoding === 'utf-8'`. */
  readonly text?: string;
  /** Base64-encoded body bytes, present when `encoding === 'base64'`. */
  readonly base64?: string;
  /** Decoded byte length of the body. */
  readonly sizeBytes: number;
  /** IANA MIME type, when known. */
  readonly mimeType: string | null;
}

/**
 * The full `docs.read` response envelope payload.
 *
 * @task T11825
 */
export interface DocReadResponse {
  /** Provenance frontmatter. */
  readonly frontmatter: DocFrontmatter;
  /** Rendered body (text or base64). */
  readonly body: DocBody;
}

/** Zod schema for {@link DocFrontmatter}. */
export const docFrontmatterSchema = z.object({
  slug: z.string(),
  kind: z.string().nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  lifecycleStatus: z.string(),
  docVersion: z.number().int(),
  ownerVersion: z.string().nullable(),
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable(),
  topics: z.array(z.string()).readonly(),
  relatedTasks: z.array(z.string()).readonly(),
  sha256: z.string(),
  createdAt: z.string(),
});

/** Zod schema for {@link DocBody}. */
export const docBodySchema = z.object({
  encoding: z.enum(['utf-8', 'base64']),
  text: z.string().optional(),
  base64: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().nullable(),
});

/** Zod schema for {@link DocReadResponse}. */
export const docReadResponseSchema = z.object({
  frontmatter: docFrontmatterSchema,
  body: docBodySchema,
});

/**
 * Type guard for {@link DocReadResponse}.
 *
 * @param value - Unknown value to validate.
 * @returns True when `value` conforms to the `docs.read` response schema.
 * @task T11825
 */
export function isDocReadResponse(value: unknown): value is DocReadResponse {
  return docReadResponseSchema.safeParse(value).success;
}
