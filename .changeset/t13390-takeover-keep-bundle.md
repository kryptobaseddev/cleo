---
id: t13390-takeover-keep-bundle
tasks: [T13390]
kind: fix
summary: a genesis run that loses its marker to a takeover no longer deletes the new holder's saved bundle
---

When another genesis run takes over the genesis marker during `cleo sync enable push`, the losing
run aborts with `E_SYNC_GENESIS_MARKER_LOST` as before, but it no longer removes the bundle and
record saved at the stream's shared `sync-genesis` paths. Those now belong to the new holder, which
owns the pending cut. A run whose own marker expired with nobody taking it over still removes what
it saved, because its cut is undone.

A snapshot that fails after a takeover now throws the typed `GenesisTakenOverError` (a
`GenesisRacedError` subclass, code `E_SYNC_GENESIS_MARKER_LOST`); its message keeps the original
failure, and the pending cut is still left to the new holder.
