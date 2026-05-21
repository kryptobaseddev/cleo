/**
 * CLEO-native changeset writer — dual-write to file + SSoT.
 *
 * Bridges the file-on-disk audit trail (`.changeset/*.md`, kept for human PR
 * review surface) with the canonical docs SSoT blob store. Every successful
 * write lands in BOTH places or NEITHER:
 *
 *   1. Renders the {@link ChangesetEntry} as `---` fenced YAML frontmatter
 *      plus the optional markdown body (`notes`).
 *   2. Writes `.changeset/<slug>.md` to disk via tmp-then-rename for atomicity.
 *   3. Stores the SAME bytes as a content-addressed blob via the attachment
 *      store with `extras: { type: 'changeset', slug: '<slug>' }`.
 *
 * If step 3 fails the file from step 2 is removed. If step 2 succeeds but the
 * SSoT row is partially written, the attachment ref is dereferenced. This
 * keeps the two surfaces eventually-consistent under crash semantics.
 *
 * The slug is validated against the `changeset` kind's `entityIdPattern`
 * (`/^t\d+-[a-z0-9-]+$/`) from {@link DocKindRegistry}. Invalid slugs return
 * `E_SLUG_PATTERN_MISMATCH` so the operator can correct the input.
 *
 * @epic T9793 (E-DOCS-CHANGESET-INTEGRATION)
 * @task T9793
 * @see ADR-068 — DB Charter: changeset bytes live in manifest.db blob store
 * @see docs-taxonomy.ts — `changeset` kind registry entry
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BlobAttachment } from '@cleocode/contracts';
import { type ChangesetEntry, ChangesetEntrySchema, DocKindRegistry } from '@cleocode/contracts';
import { createAttachmentStore } from '../store/attachment-store.js';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Options accepted by {@link writeChangesetEntry}.
 */
export interface WriteChangesetOptions {
  /**
   * Absolute path to the project root containing `.changeset/`.
   *
   * Resolved to `.changeset/<slug>.md` for the file write and used to
   * locate the attachment SSoT (`.cleo/attachments/index.db`).
   */
  readonly projectRoot: string;
  /**
   * Identity to record on the SSoT row.
   *
   * Defaults to `'cleo-changeset'`. Surfaces in `attachment_refs.attachedBy`
   * so operators can audit which CLI surface created the entry.
   */
  readonly attachedBy?: string;
}

/**
 * Result of a successful dual-write.
 */
export interface WriteChangesetResult {
  /** Absolute path to the written `.changeset/<slug>.md`. */
  readonly filePath: string;
  /** Slug used (matches the filename without `.md`). */
  readonly slug: string;
  /** Attachment ID (`att_<base62>`) of the SSoT blob. */
  readonly attachmentId: string;
  /** SHA-256 of the bytes written to BOTH surfaces. */
  readonly sha256: string;
  /** Owner task ID — the first task in the entry's `tasks` array. */
  readonly ownerId: string;
}

/**
 * Discriminated error result for {@link writeChangesetEntry}.
 */
export type WriteChangesetError =
  | {
      readonly code: 'E_SLUG_PATTERN_MISMATCH';
      readonly message: string;
      readonly example?: string;
    }
  | { readonly code: 'E_INVALID_ENTRY'; readonly message: string }
  | { readonly code: 'E_FILE_WRITE_FAILED'; readonly message: string }
  | { readonly code: 'E_SSOT_WRITE_FAILED'; readonly message: string };

/**
 * Discriminated union returned by {@link writeChangesetEntry}.
 */
export type WriteChangesetOutcome =
  | { readonly ok: true; readonly result: WriteChangesetResult }
  | { readonly ok: false; readonly error: WriteChangesetError };

// ─── Markdown serialisation ──────────────────────────────────────────────────

/**
 * Render a {@link ChangesetEntry} as the canonical `---`-fenced markdown form.
 *
 * The output matches what {@link parseChangesetFile} round-trips: identical
 * fields, identical YAML scalar style for arrays, identical body trim rules.
 *
 * @internal
 */
export function renderChangesetMarkdown(entry: ChangesetEntry): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${entry.id}`);
  lines.push(`tasks: [${entry.tasks.join(', ')}]`);
  lines.push(`kind: ${entry.kind}`);
  // The summary may contain colons or quotes — pass through unchanged because
  // the parser uses a permissive YAML parse and the field is a scalar.
  lines.push(`summary: ${entry.summary}`);
  if (entry.prs && entry.prs.length > 0) {
    lines.push(`prs: [${entry.prs.join(', ')}]`);
  }
  if (entry.breaking !== undefined && entry.breaking.length > 0) {
    // Use the YAML block-scalar `|-` (strip) form so multi-line breaking
    // notes survive round-trip without a parser-added trailing newline.
    // The `|` (clip) variant appends one trailing newline; `|-` does not.
    lines.push('breaking: |-');
    for (const noteLine of entry.breaking.split('\n')) {
      lines.push(`  ${noteLine}`);
    }
  }
  lines.push('---');

  // Body — when `notes` is present it becomes the markdown body; we omit it
  // from the frontmatter so the parser populates `notes` from the body alone
  // (matches the existing `.changeset/*.md` convention).
  if (entry.notes !== undefined && entry.notes.length > 0) {
    lines.push('');
    lines.push(entry.notes.trimEnd());
  }
  lines.push('');
  return lines.join('\n');
}

// ─── Dual-write transaction ──────────────────────────────────────────────────

/**
 * Dual-write a changeset entry to BOTH `.changeset/<slug>.md` AND the docs
 * SSoT blob store. Either both writes succeed, or neither persists.
 *
 * The owner task ID for the SSoT row is the FIRST entry in `entry.tasks` —
 * subsequent task IDs ride along in the changeset's `tasks` field but the
 * blob is anchored to one owner (the convention used elsewhere by the docs
 * domain). Aggregators read the full `tasks` array from the parsed markdown.
 *
 * @param entry - Pre-validated changeset entry (schema-validated again here
 *   to keep this function safe to call with raw user input).
 * @param opts - Project root + optional `attachedBy` identity.
 * @returns Discriminated outcome with `result` on success or `error` on any
 *   failure. NEVER throws — file or SSoT errors map to `E_*` codes so callers
 *   can surface them as LAFS envelopes.
 *
 * @example
 * ```ts
 * const outcome = await writeChangesetEntry(
 *   {
 *     id: 't9793-changeset-ssot',
 *     tasks: ['T9793'],
 *     kind: 'feat',
 *     summary: 'Changeset DocKind becomes SSoT-first via dual-write.',
 *   },
 *   { projectRoot: '/path/to/repo' },
 * );
 * if (outcome.ok) {
 *   console.log(outcome.result.filePath);
 *   console.log(outcome.result.attachmentId);
 * }
 * ```
 */
export async function writeChangesetEntry(
  entry: ChangesetEntry,
  opts: WriteChangesetOptions,
): Promise<WriteChangesetOutcome> {
  // ── 0. Validate the entry schema. ───────────────────────────────────────
  // Defensive — callers normally pass schema-validated entries, but this
  // module is also the canonical write path so re-checking here keeps the
  // contract simple.
  const parsed = ChangesetEntrySchema.safeParse(entry);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: { code: 'E_INVALID_ENTRY', message: issues } };
  }
  const validated = parsed.data;

  // ── 1. Validate the slug against the `changeset` kind's pattern. ────────
  // The slug IS the entry id (and the filename without `.md`). The doc-kind
  // registry's `entityIdPattern` for `changeset` is `^t\d+-[a-z0-9-]+$`.
  const registry = DocKindRegistry.builtinOnly();
  const slugCheck = registry.validateSlug('changeset', validated.id);
  if (!slugCheck.ok) {
    return {
      ok: false,
      error: {
        code: 'E_SLUG_PATTERN_MISMATCH',
        message: slugCheck.error,
        ...(slugCheck.example !== undefined ? { example: slugCheck.example } : {}),
      },
    };
  }

  // ── 2. Render bytes. ────────────────────────────────────────────────────
  const markdown = renderChangesetMarkdown(validated);
  const bytes = Buffer.from(markdown, 'utf-8');

  // ── 3. File write (tmp-then-rename for atomicity). ──────────────────────
  const changesetDir = join(opts.projectRoot, '.changeset');
  const filePath = join(changesetDir, `${validated.id}.md`);
  const tmpPath = `${filePath}.${process.pid}.tmp`;

  try {
    mkdirSync(changesetDir, { recursive: true });
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, filePath);
  } catch (err: unknown) {
    // Best-effort cleanup of the tmp file if it survived.
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* Already gone or unwritable — ignore. */
    }
    return {
      ok: false,
      error: {
        code: 'E_FILE_WRITE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // ── 4. SSoT write — content-addressed blob via attachment store. ────────
  // Owner is the FIRST task in `tasks`. The full task list rides along in
  // the markdown body (which the aggregator re-parses), so no information
  // is lost when the SSoT only knows about one owner.
  const ownerId = validated.tasks[0];
  if (ownerId === undefined) {
    // Schema guarantees `tasks.length >= 1` so this is unreachable; included
    // for type narrowing.
    return {
      ok: false,
      error: { code: 'E_INVALID_ENTRY', message: 'tasks array empty after validation' },
    };
  }

  const store = createAttachmentStore();
  const attachment: Omit<BlobAttachment, 'sha256'> = {
    kind: 'blob',
    // storageKey is filled in by the store after hashing — we just need to
    // satisfy the discriminated union for the type checker.
    storageKey: '',
    mime: 'text/markdown',
    size: bytes.length,
    description: `Changeset: ${validated.summary}`,
    labels: ['changeset', validated.kind],
  };

  try {
    const meta = await store.put(
      bytes,
      attachment,
      'task',
      ownerId,
      opts.attachedBy ?? 'cleo-changeset',
      opts.projectRoot,
      { slug: validated.id, type: 'changeset' },
    );
    return {
      ok: true,
      result: {
        filePath,
        slug: validated.id,
        attachmentId: meta.id,
        sha256: meta.sha256,
        ownerId,
      },
    };
  } catch (err: unknown) {
    // ROLLBACK: SSoT write failed — remove the file we just wrote so the
    // two surfaces stay in sync. Best-effort: if file removal also fails,
    // the operator can re-run `cleo changeset add` to retry the SSoT row.
    try {
      rmSync(filePath, { force: true });
    } catch {
      /* File removal best-effort. */
    }
    return {
      ok: false,
      error: {
        code: 'E_SSOT_WRITE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
