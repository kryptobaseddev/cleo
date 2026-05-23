---
id: t10392-e1-slug-allocator
tasks: [T10392]
kind: feat
summary: "T10392 E1.1: central slug allocator chokepoint"
---

Introduces `packages/core/src/docs/slug-allocator.ts:reserveSlug` — the
chokepoint module that every attachment-slug writer (`cleo docs add`,
`cleo changeset add`, future writers) MUST call BEFORE invoking
`attachmentStore.put({ slug })`.

The allocator:

- Normalises slugs to canonical kebab-case via {@link normalizeSlug}.
- Acquires a per-slug in-process Mutex so concurrent reservations
  serialise within a single CLEO process.
- Probes the `attachments` table for an existing row holding the slug.
- Returns `{ ok: true, normalizedSlug }` on a free slug, or
  `{ ok: false, code: 'E_SLUG_RESERVED', suggestions }` on collision —
  suggestions are derived via the shared `deriveSlugSuggestions` helper
  so the shape matches `SlugCollisionError.suggestions`.
- Releases the per-slug lock BEFORE any caller acquires the global
  write lock — no deadlock between the two locks is possible because
  the allocator never escalates to the write lock.

`attachmentStore.put` adds a runtime assert (opt-in via
`CLEO_STRICT_SLUG_ALLOCATOR=1` in this PR; strict default flipped on by
T10386 / T10388) that throws `SlugNotReservedByAllocatorError` if a
writer attempts to write a slug that was not first reserved.

Closes the slug-collision class root cause uncovered by the T10294
spike (PR #576): two writers reaching the constraint through different
code paths and surfacing different envelopes for the same conflict.

Foundation for the T-E1.2 / T-E1.3 writer-wiring tasks under Saga
T10288 (SG-DOCS-INTEGRITY) Epic T10289 (E1-DOCS-SLUG-NAMESPACE).
