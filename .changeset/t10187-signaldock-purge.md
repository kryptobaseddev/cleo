---
id: t10187-signaldock-purge
tasks: [T10187, T10181]
kind: feat
summary: "Saga T10180: delete 7 signaldock-* crates from cleocode workspace (-17k LOC). SignalDock cloud server now lives at signaldock repo."
prs: [514, 501]
---

Removes crates/signaldock-{core,protocol,storage,transport,sdk,payments,runtime}/ plus 15 now-dead workspace deps. Boundary registry entries updated to migrated-out. This is the proof-of-extraction: cleocode CI green without any signaldock-* crates.
