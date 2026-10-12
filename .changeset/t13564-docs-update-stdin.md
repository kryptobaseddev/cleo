---
id: t13564-docs-update-stdin
tasks: [T13564]
kind: fix
summary: "cleo docs update --content - reads stdin instead of storing '-'"
---

`cleo docs add --content -` reads the body from stdin, but `cleo docs update
--content -` stored the single character `-` as the new body, silently
replacing a canonical doc's content. `docs update` now reads stdin for
`--content -` too, and an update whose body is empty or a bare `-` is
refused, so a missed stdin read can never overwrite a doc.
