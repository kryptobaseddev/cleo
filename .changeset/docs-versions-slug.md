---
id: docs-versions-slug
tasks: [T13725]
kind: fix
summary: docs versions --for accepts a doc slug; dispatch keeps a CleoError's named code
---

`cleo docs versions --for <slug>` passed the slug verbatim as a blob owner id
and always returned an empty list. It now resolves owner id first, then slug:
an owner id (`T###`, `ses_*`, `O-*`) is listed as-is, even when empty; any
other arg is looked up as a doc slug and lists its owning task's blobs. An
arg that is neither fails with `E_NOT_FOUND`.

Dispatch error handling now maps a thrown `CleoError` to its named code, fix
and details instead of `E_INTERNAL`. Only a real `CleoError` is mapped, so a
child-process rejection whose `code` is an exit status stays `E_INTERNAL`.
