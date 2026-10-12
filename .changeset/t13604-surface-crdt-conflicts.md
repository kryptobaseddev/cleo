---
id: t13604-surface-crdt-conflicts
tasks: [T13604]
kind: fix
summary: Recorded CRDT section conflicts reach the caller — docs.update envelope carries sectionConflicts with a stderr warning, docs.fetch surfaces headConflict
---

The CRDT write path records a non-append concurrent section edit as a head
conflict (T13595), but its only caller discarded the projection result: a
`cleo docs update` reported `changed: true` with no warning even though the
authored edit was NOT in the conduit head, and no command showed the
conflict. Now:

- `docs.update` threads the projection's conflicts into the result
  envelope as `sectionConflicts: [{sectionId, incomingVersionUid,
  projectionVersionUid}]` (contracts type `DocsSectionConflict`) and emits a
  `W_DOC_SECTION_CONFLICT` warning naming the sections and both version
  refs; the stdout envelope stays clean per ADR-086.
- `docs.fetch` (and `docs view --json`, same shared builder) surfaces a
  `headConflict` field — `conflictCount` plus the parsed last conflict
  (loser uid, HLC, recorded-at, winner uid) — whenever the doc's conduit
  head carries recorded conflicts. The fetched content is the winning
  projection; losing edits survive in the append-only version history. The
  no-conflict envelope is unchanged (the lookup short-circuits when the
  project store or the conduit doc does not exist).
