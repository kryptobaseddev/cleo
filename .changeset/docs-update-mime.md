---
id: docs-update-mime
tasks: [T13918]
kind: fix
summary: "docs update --file keeps the MIME type docs add infers, so a Markdown doc still reads back as content"
---

`cleo docs update --file x.md` stored the new version as
`application/octet-stream`, so `docs fetch` returned `bytesBase64` instead of
`content` and callers reading `content` broke (Axiom repro). Update now infers
the type from the file extension with the same function `docs add` uses
(`text/markdown` for `.md`); the add path's private copy of that table is gone.
