/**
 * The keys under which CLEO payloads carry a list of records.
 *
 * ## Why this is a shared constant (T12077)
 *
 * Different operations name their collection differently — `tasks.list` emits
 * `tasks`, the SDK's generic list emits `items`, `tasks.find` emits `results`,
 * and `tasks.next` emits `suggestions`. Each consumer that wants "the rows"
 * has historically inlined its own guess, and each wrong guess fails SILENTLY,
 * because an absent key is indistinguishable from an empty result set.
 *
 * Three separate outages traced to exactly this:
 *
 * 1. **T12067** — `output-mode.ts` knew only `tasks`/`items`, in three
 *    separately-inlined lists. `cleo find … --output count` reported 1626
 *    while `--output id` reported `No ids.` against the same payload.
 * 2. **T12077 (this)** — `cleo next --output id` / `--output count` reported
 *    nothing and zero while the envelope held 836 candidates, because
 *    `suggestions` was in nobody's list.
 * 3. **T12077 (the severe one)** — `defaultPickTask` in the sentient loop read
 *    `response.data.tasks` from `cleo.tasks.find()`, which returns
 *    `{results, total}` *unwrapped*. The key was wrong AND the `data` envelope
 *    it was reaching through does not exist on the SDK surface, so
 *    `allCandidates` was **always `[]`**. The autonomous loop therefore
 *    returned `no-task` on every tick it had ever run — 24 ticks, 0 tasks
 *    picked, across three months — and looked exactly like "there is no work
 *    to do" rather than like a bug.
 *
 * The lesson those three share is that this list must exist in ONE place that
 * both the render layer and the SDK consumers import. Adding an operation with
 * a new collection key now means adding it here, once.
 *
 * @task T12077
 */

/**
 * Collection keys in resolution order.
 *
 * Order matters only when a payload carries more than one (it should not);
 * earlier keys win, which keeps the canonical `tasks` shape authoritative.
 */
export const COLLECTION_KEYS = [
  'tasks',
  'items',
  'results',
  'suggestions',
  // gh#1402 / gh#1405 — instances 4, 5 and 6 of the defect this file documents.
  // `saga list` emits `sagas` and `--output id` returned an EMPTY STREAM against
  // 58 rows; `backup list` emits `backups`; `worktree list` emits `worktrees`
  // and, carrying no `total`/`count` sibling, reported `--output count` = 0
  // against 9 records — so both projection modes agreed on a wrong answer and
  // the cross-check that caught the other two was absent.
  'sagas',
  'backups',
  'worktrees',
] as const;

/** A key under which a payload may carry its rows. */
export type CollectionKey = (typeof COLLECTION_KEYS)[number];

/**
 * The field that identifies a record, for collections whose identity is not `id`.
 *
 * ## Why a registry rather than "assume `id`" (gh#1405)
 *
 * `--output id` projected `record.id` unconditionally and dropped every row
 * lacking one. Two collections in this codebase legitimately have no `id`:
 *
 * | collection  | identity    | measured                                    |
 * |-------------|-------------|---------------------------------------------|
 * | `worktrees` | `path`      | 9 records, 0 ids emitted, `--output count` 0 |
 * | `backups`   | `backupId`  | 55 records, 0 ids emitted                    |
 *
 * The filter was silent, so an absent identity rendered exactly like an empty
 * collection. That matters most for `worktree list`, which is the enumeration a
 * cleanup decision reads: a confident `0` reads as "there are no worktrees",
 * which is the precondition for pruning.
 *
 * A collection absent from this map identifies by `id`.
 *
 * @task gh#1405
 */
export const COLLECTION_IDENTITY_FIELDS: Readonly<Partial<Record<CollectionKey, string>>> = {
  worktrees: 'path',
  backups: 'backupId',
};

/** Default identity field for collections not named in {@link COLLECTION_IDENTITY_FIELDS}. */
export const DEFAULT_IDENTITY_FIELD = 'id';
