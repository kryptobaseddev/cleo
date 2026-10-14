---
id: t13595-t13596-crdt-merge-safety
tasks: [T13595, T13596]
kind: fix
summary: Non-append concurrent section edits are recorded as head conflicts instead of fabricated merges; the blob tombstone sweep no longer deletes conduit doc-history blobs
---

Two merge-safety fixes on the CleoDocs CRDT write path (#2144):

T13595 — the concurrent branch of `applySectionTextEdit` composed ANY
incoming edit as the tail beyond the longest common prefix, so a non-append
concurrent edit (a replace or delete relative to the common base) fabricated
a concatenation no writer authored once stored state genuinely diverges from
the head (reachable the moment Stage C sync applies remote heads). The
primitives are append-only, so a true text merge is not expressible; the
write path now does what `docs.head.max-hlc` does for heads: a concurrent
edit that is a pure append composes (both tails survive, nothing invented),
and a non-append concurrent edit is landed as its OWN version row — the
append-only history preserves both — while the head keeps the stored
projection and records the conflict (`conflict_count++`,
`last_conflict_json` naming loser and winner version refs).

T13596 — version/merged-text blobs live in the shared content-addressed
attachment directory, but the blob sweep (`attachment-repair.ts`) only
consulted the legacy attachments tables, the publications ledger and the
blobs manifest. A version blob a legacy doc shared bytes with could be
deleted as "unreferenced" once the legacy row went, destroying history
content. The sweep now also consults
`listConduitHistorySha256Set` (`conduit_attachment_versions` +
`conduit_attachments` content hashes) in both the files-without-rows phase
and the keep-link garbage phase.
