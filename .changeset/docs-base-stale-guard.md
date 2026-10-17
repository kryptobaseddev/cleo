---
id: docs-base-stale-guard
tasks: [T13835, T13836]
kind: fix
summary: a stale-base docs update is refused (E_DOC_BASE_STALE) once sections were inserted, removed or renamed since its base, instead of silently dropping a landed section
---

`cleo docs update --base-version-uid` merged a stale edit section by section,
pairing sections by position. When another writer had inserted a section (or
inserted a duplicate `## ` heading earlier) since the base, the merge dropped a
landed section from the head and recorded no conflict. The update now compares
the base's `## ` headings with the current head's before any write; when they
differ it refuses with `E_DOC_BASE_STALE` and tells the writer to re-fetch the
head and re-apply the edit. Edits whose base still has the head's section
layout merge as before. The implicit trigger (stored section state diverging
from the head without a declared base) is not covered and stays open under
T13835/T13836.
