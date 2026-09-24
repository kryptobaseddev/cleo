---
id: nexus-incremental-analysis
tasks: [T12315]
kind: feat
summary: `cleo nexus analyze` is incremental by default and provably equal to a full rebuild — it re-parses only changed files, re-resolves everything, and says why whenever it falls back to `--full`
---

`--incremental` detected changed files correctly and then parsed every file
anyway (`filesToParse` was never narrowed), so one edited file cost a complete
rebuild. Only the zero-change fast path was real.

Analysis now reuses each unchanged file's **extraction** — not its published
rows. Cross-file resolution consumes raw call sites, access sites, import
bindings and re-export records that the graph tables never stored, so they are
persisted per file in `_nexus_parse_cache` (new nexus migration), keyed by path
and valid only for the exact content hash and extractor-build fingerprint that
produced them. Everything downstream of extraction — import and barrel
resolution, heritage, calls, accesses, communities and flows — reruns over the
merged extraction of every file, so a renamed export, a deleted file or a
changed barrel re-routes callers in files that were not re-parsed. The cache is
replaced in the same transaction as the graph it describes.

A run reports `mode` (`incremental` | `full` | `unchanged`), `reason`, changed /
added / deleted / parsed / reused / resolved file counts and per-phase
milliseconds. It falls back to a full parse, and says why, when there is no
previous generation or parse cache, source ownership changed, the extractor
build changed, or more than 30% of files differ. `--full` forces a rebuild;
`--incremental` is accepted as a deprecated no-op. A commit that changes no
bytes no longer forces a rebuild: the graph is kept and the newly verified
revision is recorded.

Making the two paths comparable exposed three sources of nondeterminism that
made two FULL rebuilds of identical bytes publish different graphs, all fixed:
Leiden community detection used `Math.random` (now seeded); process ids kept
the first character of an anonymous scope's generation token; and
node-tree-sitter 0.21 misreports a doc comment inside an interface body as
`interface_body` and does not guarantee one wrapper object per node, so doc
summaries (46 on this repository) and Rust write-access detection flipped
between processes. Doc comments are now recognised by their text and syntax
nodes are compared by span.

Measured on this repository (5,644 files, 4,507 parsed, /home NVMe): full
rebuild 40–50 s; incremental after a one-file change 28.6–29.6 s, publishing a
graph identical to the full rebuild by node, relation, file-report, reference
and parse-cache sets.
