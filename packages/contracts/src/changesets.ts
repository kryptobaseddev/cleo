/**
 * CLEO-native task-anchored changeset entry contract.
 *
 * CLEO-native task-anchored changesets DSL that pins every change to one or
 * more CLEO task IDs (`T####` or `E-####`). The
 * resulting `.md` files in `.changeset/` form a write-only audit trail of
 * shipped work that the future `cleo release plan` aggregator can roll up
 * into release manifests.
 *
 * File format: YAML frontmatter between `---` fences carries the structured
 * fields below; the markdown body (everything after the closing fence) becomes
 * the optional `notes` field — longer-form explanation, migration steps,
 * developer commentary.
 *
 * @example minimal entry
 * ```md
 * ---
 * id: t9686-a-dispatch-envelope
 * tasks: [T9686-A]
 * kind: fix
 * summary: Stop worktree parent appending help text after subcommand.
 * ---
 * ```
 *
 * @example breaking entry
 * ```md
 * ---
 * id: t9686-b2-unification
 * tasks: [T9686-B2]
 * kind: breaking
 * prs: [328]
 * summary: Unify releases tables.
 * breaking: release_manifests dropped; readers must switch to releases.
 * ---
 *
 * Hard-rename `releases_view` to canonical `releases` table. All consumers
 * that read the legacy table must migrate before upgrade.
 * ```
 *
 * @epic T9738
 * @task T9738
 */

import { z } from 'zod';

// ─── Allowed `kind` values ────────────────────────────────────────────────────

/**
 * Discriminator for the type of change recorded by a changeset entry.
 *
 * Mirrors the conventional-commit semantic prefix set used elsewhere in the
 * CLEO repo (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`) plus
 * `perf` for performance work and `breaking` for entries that introduce a
 * breaking change requiring migration notes.
 */
export const CHANGESET_KINDS = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'test',
  'chore',
  'breaking',
] as const;

/** Allowed values of {@link ChangesetEntry.kind}. */
export type ChangesetKind = (typeof CHANGESET_KINDS)[number];

// ─── Release-note metadata ───────────────────────────────────────────────────

/**
 * Deterministic release-note section override used by zero-token renderers.
 *
 * These values intentionally mirror Keep-a-Changelog style headings so release
 * tooling can render higher-quality notes without an LLM/API/token dependency.
 */
export const CHANGESET_RELEASE_NOTE_SECTIONS = [
  'added',
  'changed',
  'fixed',
  'deprecated',
  'removed',
  'security',
  'breaking',
] as const;

/** Allowed values of {@link ChangesetReleaseNotesMetadata.section}. */
export type ChangesetReleaseNoteSection = (typeof CHANGESET_RELEASE_NOTE_SECTIONS)[number];

/** Audience labels for deterministic release-note routing. */
export const CHANGESET_RELEASE_NOTE_AUDIENCES = [
  'users',
  'operators',
  'developers',
  'maintainers',
] as const;

/** Allowed values of {@link ChangesetReleaseNotesMetadata.audience}. */
export type ChangesetReleaseNoteAudience = (typeof CHANGESET_RELEASE_NOTE_AUDIENCES)[number];

/** Scope labels for deterministic release-note routing. */
export const CHANGESET_RELEASE_NOTE_SCOPES = [
  'project',
  'package',
  'component',
  'docs',
  'ops',
  'security',
] as const;

/** Allowed values of {@link ChangesetReleaseNotesMetadata.scope}. */
export type ChangesetReleaseNoteScope = (typeof CHANGESET_RELEASE_NOTE_SCOPES)[number];

const nonEmptyReleaseNoteText = z.string().min(1, 'release-note metadata text must be non-empty');
const nonEmptyReleaseNoteList = z
  .array(nonEmptyReleaseNoteText)
  .min(1, 'release-note metadata list must contain at least one item');

/**
 * Optional deterministic metadata for release-note rendering.
 *
 * This is deliberately small, explicit, and strict: it gives release tooling
 * structured author-provided facts (section, audience, target, impact, etc.)
 * while preserving zero-token defaults and failing loudly on misspelled fields.
 */
export const ChangesetReleaseNotesMetadataSchema = z
  .object({
    /** Keep-a-Changelog style section/category override. */
    section: z.enum(CHANGESET_RELEASE_NOTE_SECTIONS).optional(),
    /** Intended readers for the note. */
    audience: z.array(z.enum(CHANGESET_RELEASE_NOTE_AUDIENCES)).min(1).optional(),
    /** Release-note scope. */
    scope: z.enum(CHANGESET_RELEASE_NOTE_SCOPES).optional(),
    /** Package/project/component targets affected by this entry. */
    targets: nonEmptyReleaseNoteList.optional(),
    /** User- or operator-visible impact statement. */
    impact: nonEmptyReleaseNoteText.optional(),
    /** Deterministic migration/action text, separate from breaking changes. */
    migration: nonEmptyReleaseNoteText.optional(),
    /** Deprecation detail for Deprecated sections. */
    deprecation: nonEmptyReleaseNoteText.optional(),
    /** Security detail for Security sections. */
    security: nonEmptyReleaseNoteText.optional(),
    /** Operator-facing rollout/verification note. */
    operatorNotes: nonEmptyReleaseNoteText.optional(),
    /** Explicit inclusion toggle for future release-scope filters. */
    includeInChangelog: z.boolean().optional(),
  })
  .strict();

/** Inferred TypeScript type for deterministic release-note metadata. */
export type ChangesetReleaseNotesMetadata = z.infer<typeof ChangesetReleaseNotesMetadataSchema>;

// ─── Task ID validator ────────────────────────────────────────────────────────

/**
 * Matches a CLEO task identifier: `T####` (task) or `E-####` (epic display
 * form). Storage-tier IDs are always `T####`; the `E-` prefix is the
 * display + import-mapping form per ADR-073 §1.2 — both are accepted so
 * humans can use whichever appears in PR titles.
 */
const TASK_ID_RE = /^(T\d+(-[A-Z][A-Za-z0-9]*)?|E-\d+(-[A-Z][A-Za-z0-9]*)?)$/;

// ─── Schema ───────────────────────────────────────────────────────────────────

/**
 * Zod schema for a single changeset entry. Validates frontmatter fields
 * + markdown body of a file under `.changeset/*.md`.
 *
 * Required fields:
 * - `id`     — slug matching the filename (without extension)
 * - `tasks`  — non-empty array of CLEO task IDs
 * - `kind`   — one of {@link CHANGESET_KINDS}
 * - `summary` — one-line user-facing description
 *
 * Optional fields:
 * - `prs`      — linked PR numbers
 * - `notes`    — longer-form markdown body
 * - `breaking` — required migration note when `kind === 'breaking'`
 * - `releaseNotes` — deterministic zero-token release-note metadata
 */
export const ChangesetEntrySchema = z
  .object({
    /** Filename identifier (without the `.md` extension); lowercase kebab-case for new files, legacy uppercase task IDs accepted. */
    id: z
      .string()
      .min(1, 'id must be non-empty')
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9-]*$/,
        'id must contain only ASCII letters, digits, and hyphens',
      ),
    /** One or more CLEO task IDs this change is anchored to. */
    tasks: z
      .array(z.string().regex(TASK_ID_RE, 'task ID must match T#### or E-#### format'))
      .min(1, 'tasks must contain at least one task ID'),
    /** Type of change. */
    kind: z.enum(CHANGESET_KINDS),
    /** Single-line user-facing description. */
    summary: z.string().min(1, 'summary must be non-empty'),
    /** Linked PR numbers, when known. */
    prs: z.array(z.number().int().positive()).optional(),
    /** Markdown body — longer-form explanation. */
    notes: z.string().optional(),
    /** Migration note. Required iff `kind === 'breaking'`. */
    breaking: z.string().optional(),
    /** Structured author-provided metadata for deterministic release notes. */
    releaseNotes: ChangesetReleaseNotesMetadataSchema.optional(),
  })
  .refine((entry) => entry.kind !== 'breaking' || (entry.breaking?.length ?? 0) > 0, {
    message: 'breaking entries must include a non-empty `breaking` migration note',
    path: ['breaking'],
  });

/**
 * Inferred TypeScript type for a parsed changeset entry.
 *
 * The shape is identical to the schema input — there are no transforms that
 * coerce between input and output types.
 */
export type ChangesetEntry = z.infer<typeof ChangesetEntrySchema>;
