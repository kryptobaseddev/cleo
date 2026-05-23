---
id: t10185-conduit-rename
tasks: [T10185]
kind: feat
summary: "T10185 (saga T10180 W4 phase 1): rename `conduit-core` → `cleo-conduit-core`. The `conduit-core` nam"
---

T10185 (saga T10180 W4 phase 1): rename `conduit-core` → `cleo-conduit-core`. The `conduit-core` name is squatted on crates.io by an unrelated crate (v2.1.1 "Binary IPC core"); the rename unblocks the publish chain for signaldock SDK crates. All cleocode consumers updated; module-import names switched from `conduit_core` → `cleo_conduit_core`.

Owner HITL follows: cargo publish cant-core, lafs-core, cleo-conduit-core to crates.io @ 2026.5.0.
