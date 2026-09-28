---
id: nexus-status-bounded-files
tasks: [T12560]
kind: fix
summary: cleo nexus status no longer emits every assessed file; it reports counts and one page
---

`cleo nexus status` returned `assessment.files` whole, one row per assessed
file at about 635 B each. The envelope grew with the repository: 3.9 MB here,
and 391 MB for one reporter. Agents are told to make this call first.

The default output now keeps the freshness facts (`nodeCount`, `lastIndexedAt`,
`staleFileCount`, `fileCount`). It adds `assessment.fileCount` and
`assessment.filesByStatus`, plus a 20-row `assessment.filesPage` with `offset`,
`limit`, `total`, `returned` and `nextOffset`. `files` is marked in
`assessment._withheld` with the full list's UTF-8 size, so a page is never
presented as the complete list.

Page with `--limit`, `--offset` and `--file-status`, where `--limit 0` means
every matching row. Use `--files` to get the complete list under
`assessment.files`.
