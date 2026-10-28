/**
 * Docs modernize contract — the plan and receipt of `cleo docs modernize`.
 *
 * `cleo docs modernize <path>` turns a messy docs folder into clean, linked
 * CleoDocs. A dry run produces a {@link DocsModernizePlan}: one
 * {@link DocsModernizePlanRow} per markdown or text file, carrying the kind,
 * the stable slug, the disposition and the reasons (including every System
 * One judgment that was asked). `--apply` executes a plan and writes a
 * {@link DocsModernizeReceipt}; every receipt op records the state it
 * replaced, so `--rollback <runId>` can reverse the run.
 *
 * Types only — the planner and applier live in
 * `packages/core/src/docs/modernize/`.
 *
 * @task T14113
 * @epic T14106
 */

/** What modernize does with one file. */
export const DOCS_MODERNIZE_DISPOSITIONS = ['keep', 'rename', 'merge-into', 'delete'] as const;

/**
 * One of {@link DOCS_MODERNIZE_DISPOSITIONS}.
 *
 * - `keep` — the file already sits at its canonical path; it is ingested as is.
 * - `rename` — the file moves to `<kind folder>/<slug>.md` and is ingested there.
 * - `merge-into` — the file duplicates another; its content folds into the
 *   survivor named by `target`, and the file is superseded and removed.
 * - `delete` — the file carries nothing worth keeping (empty, or byte-identical
 *   to the survivor); it is superseded by `target` when one exists and removed.
 */
export type DocsModernizeDisposition = (typeof DOCS_MODERNIZE_DISPOSITIONS)[number];

/** Where an acted-on answer came from. */
export type DocsModernizeJudgmentSource = 'provider' | 'cache' | 'fallback';

/** The two System One questions modernize asks. */
export type DocsModernizeJudgmentQuestion = 'classify' | 'merge';

/**
 * One judgment taken for a plan row: the rule answer, the System One answer
 * when one was asked, and which of the two acted.
 */
export interface DocsModernizeJudgment {
  /** Which question was judged. */
  readonly question: DocsModernizeJudgmentQuestion;
  /** Decision-site id the question was asked through (`docs.modernize.*`). */
  readonly site: string;
  /** Effective site mode (`off`, `shadow` or `on`). */
  readonly mode: 'off' | 'shadow' | 'on';
  /** The rule fallback's answer. */
  readonly ruleAnswer: string;
  /** The System One answer, or null when none came back (off, unreachable, invalid). */
  readonly decidedAnswer: string | null;
  /** Confidence of the System One answer, or null when none came back. */
  readonly decidedConfidence: number | null;
  /** Where the decided answer came from; `fallback` when the rule answered. */
  readonly source: DocsModernizeJudgmentSource;
  /** The answer the plan acts on. */
  readonly acted: string;
}

/** One file's proposal. */
export interface DocsModernizePlanRow {
  /** Path relative to the modernize root, POSIX separators. */
  readonly path: string;
  /** SHA-256 of the file bytes, hex. */
  readonly sha256: string;
  /** Taxonomy kind (a `DocKindRegistry` kind). */
  readonly kind: string;
  /** Stable slug: no task, session or date tokens. */
  readonly slug: string;
  /** Human title (first H1, else derived from the slug). */
  readonly title: string;
  /** What happens to the file. */
  readonly disposition: DocsModernizeDisposition;
  /**
   * For `keep` / `rename`: the canonical path relative to the root.
   * For `merge-into` / `delete`: the survivor's slug, or null when there is none.
   */
  readonly target: string | null;
  /** Why, one line each. */
  readonly reasons: readonly string[];
  /** Every System One question asked for this row. */
  readonly judgments: readonly DocsModernizeJudgment[];
  /** Task (`T####`) and decision (`D####`) ids the old path named; kept as links, not in the slug. */
  readonly ownerTasks: readonly string[];
  /** The kind's folder the file belongs in (`''` for the root). */
  readonly category: string;
  /** Tracked files outside the root that cite the old path (listed, never rewritten). */
  readonly refs: readonly string[];
  /** True when the row came from an override file rather than the rules. */
  readonly overridden: boolean;
  /** Code paths this doc documents (from the override; written to front matter by the caller). */
  readonly covers: readonly string[];
  /** True when the old name broke the slug rule (task, session or date tokens) and the new one does not. */
  readonly baselineRemove: boolean;
}

/** One reviewer decision for a path; it wins over the rules and System One. */
export interface DocsModernizeOverride {
  /** What happens to the file. */
  readonly disposition: DocsModernizeDisposition;
  /** Canonical path (`keep`/`rename`) or survivor slug (`merge-into`/`delete`). */
  readonly target?: string;
  /** Why; recorded on the plan row. */
  readonly reason: string;
  /** Kind to use instead of the classified one. */
  readonly kind?: string;
  /** Slug to use instead of the derived one. */
  readonly slug?: string;
  /** Code paths this doc documents, copied onto the plan row. */
  readonly covers?: readonly string[];
}

/** `--overrides <file>`: decisions keyed by path relative to the modernize root. */
export type DocsModernizeOverrides = Readonly<Record<string, DocsModernizeOverride>>;

/** A dry-run proposal for a whole tree. */
export interface DocsModernizePlan {
  /** Absolute modernize root. */
  readonly root: string;
  /** ISO 8601 time the plan was made. */
  readonly generatedAt: string;
  /** One row per scanned file, sorted by path. */
  readonly rows: readonly DocsModernizePlanRow[];
  /** Files counted per disposition. */
  readonly counts: Readonly<Record<DocsModernizeDisposition, number>>;
  /**
   * `tree` reorganises the folder; `store-only` ingests every file into the
   * store (task-owned, slugless) and leaves the folder untouched.
   */
  readonly mode: 'tree' | 'store-only';
}

/** The reversible steps an apply run takes. */
export const DOCS_MODERNIZE_OPS = [
  'ingest',
  'merge',
  'supersede',
  'write-file',
  'remove-file',
] as const;

/** One of {@link DOCS_MODERNIZE_OPS}. */
export type DocsModernizeOpKind = (typeof DOCS_MODERNIZE_OPS)[number];

/**
 * One applied step with the state it replaced.
 *
 * - `ingest` — a doc stored under `slug`; `attachmentId` is the new row.
 * - `merge` — the survivor `slug` was updated; `beforeSha256` is its old content.
 * - `supersede` — `slug` was superseded by `target`.
 * - `write-file` — `path` was written; `beforeSha256` is the old bytes, or null when it was new.
 * - `remove-file` — `path` was removed; `beforeSha256` names the bytes kept in the blob store.
 */
export interface DocsModernizeReceiptOp {
  /** Step kind. */
  readonly op: DocsModernizeOpKind;
  /** Doc slug the step touched, when any. */
  readonly slug: string | null;
  /** File path relative to the root, when any. */
  readonly path: string | null;
  /** The other end: survivor slug for `supersede`. */
  readonly target: string | null;
  /** Attachment row created by the step, when any. */
  readonly attachmentId: string | null;
  /** Owner the `ingest` ref was made for (`T####` or the project sentinel); rollback drops that ref. */
  readonly ownerId: string | null;
  /** Content the step replaced or removed, when any. */
  readonly beforeSha256: string | null;
  /** Content the step wrote, when any. */
  readonly afterSha256: string | null;
}

/** The record of one apply run; the input to rollback. */
export interface DocsModernizeReceipt {
  /** Run id (`dm-<timestamp>`); names the receipt file. */
  readonly runId: string;
  /** Absolute modernize root. */
  readonly root: string;
  /** ISO 8601 time the run started. */
  readonly appliedAt: string;
  /** SHA-256 of the canonical JSON of the plan that was applied. */
  readonly planSha256: string;
  /** Steps in the order they ran. */
  readonly ops: readonly DocsModernizeReceiptOp[];
  /** Wikilink edges in the graph after the run. */
  readonly edgeCount: number;
  /** Every scanned file whose bytes were hash-verified in the blob store, before any removal. */
  readonly blobs: readonly { readonly path: string; readonly sha256: string }[];
  /** Files moved, relative to the root (stage exactly these). */
  readonly moves: readonly { readonly from: string; readonly to: string }[];
  /** Files removed, relative to the root. */
  readonly deleted: readonly string[];
  /** ISO 8601 time the run was rolled back, or null. */
  readonly rolledBackAt: string | null;
}
