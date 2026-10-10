---
id: t13357-docs-links-writepath
tasks: [T13357]
kind: feat
summary: docs writes populate topics/related_tasks and refresh the wikilinks graph on every slugged write.
---

No runtime writer populated `attachments.topics`/`related_tasks`, so the wikilinks edge table sat at 0 rows. `store.put` now derives them at the write chokepoint (T#### mentions from text bodies → `related_tasks`, attachment labels → `topics`), `docs update` re-derives mentions from the new body, and `put`/`update`/`supersede` each rebuild `docs_wikilinks` post-commit (best-effort, never failing the write). New core module: `packages/core/src/docs/derive-links.ts`.
