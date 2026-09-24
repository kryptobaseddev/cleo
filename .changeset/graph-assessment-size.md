---
id: graph-assessment-size
tasks: [T12348]
kind: perf
summary: "`cleo nexus status` no longer reads or prints the 472 MB reference list: the graph assessment summary is stored apart from its references, and index stats come from SQL aggregates"
---

On this repository the published `graph_assessment` was one 472 MB JSON value.
Of that, 469 MB was 647,308 retained unresolved/unmodeled references and 3.75 MB
was everything else. Every reader parsed and validated all of it.

`cleo nexus status` took about 10 s at 4.5 GB RSS and printed a 472 MB
envelope. Every analysis re-read the value before starting and echoed the
whole thing in its own result.

**Storage.** `graph_assessment` now holds the summary plus `referenceCount`.
The list lives under `graph_assessment_references`. Both are written in the
publishing transaction, so they always describe the same generation.

- Re-recording provenance for an unchanged generation rewrites only the
  summary, not the list.
- A historical index with inline `references` stays readable as stored. It
  converts on its next analysis.

**Readers.**

- `readKnowledgeIndexAssessment` returns the summary.
- The list is read only through the new `readKnowledgeIndexReferences`. It
  checks the stored list against the recorded count.
- `cleo nexus status` and `cleo nexus analyze` report the summary.
- `cleo nexus status --references` still returns the full list.
- The knowledge-coverage gap counts from `referenceCount` and now points at
  `--references`.

**Index stats.** `getIndexStats` answers counts, file count and last-indexed
time from SQL aggregates. It no longer loads 89k node rows and 185k relation
ids into memory. `cleo nexus status` also skips re-hashing every indexed file
when the file manifest already answered freshness, because that count was
overridden anyway.

**What stays the same.** No query answer changes except the size of the
status and analyze envelopes. The incremental-versus-full equivalence tests
read the list where it now lives, and they now assert that the list they
compare is non-empty.
