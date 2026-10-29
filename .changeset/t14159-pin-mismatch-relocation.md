---
id: t14159-pin-mismatch-relocation
tasks: [T14159]
kind: fix
summary: "cleo project move, rename and reroot refuse with E_STORE_PIN_MISMATCH, before any write, when CLEO_DIR pins a different store than the project's own .cleo"
---

An absolute `CLEO_DIR` pin wins over the project root for the whole process.
When it named a different store than `<projectRoot>/.cleo`, a relocation's
checkpoint backed up the pinned store while the move renamed `projectRoot`,
so the moved project went without a backup.

`moveProject`, `renameProject` and `rerootProject` now compare the store this
process resolves for the project with the project's own `.cleo/`. On a
mismatch they refuse with `E_STORE_PIN_MISMATCH` before anything is written,
naming both paths. Without a pin, or with a pin on the project itself,
nothing changes.
