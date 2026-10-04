/**
 * Lifecycle statuses of a canonical doc.
 *
 * A leaf module with no schema imports: the operation registry
 * (`dispatch/operations-registry.ts`) and the dispatch input sanitizer read
 * these on every command, and `./docs.js` imports zod for its payload schemas.
 * `./docs.js` re-exports both names.
 *
 * @task T10161
 * @task T13126 - split out of operations/docs.ts
 */

/**
 * Allowed `lifecycle_status` values mirrored from the attachments-table enum
 * (`ATTACHMENT_LIFECYCLE_STATUSES` in
 * `packages/core/src/store/schema/attachments.ts`). Kept inline here so the
 * contract surface stays self-contained — the dispatch handler narrows raw
 * `--status` input against this set before touching the store.
 *
 * @task T10161 (Epic T10157 / Saga T9855)
 */
export const DOCS_LIFECYCLE_STATUSES = [
  'draft',
  'proposed',
  'accepted',
  'superseded',
  'archived',
  'deprecated',
] as const;

export type DocsLifecycleStatus = (typeof DOCS_LIFECYCLE_STATUSES)[number];
