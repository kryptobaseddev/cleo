---
id: t10130-render-envelope-entry
tasks: [T10130]
kind: feat
summary: "B5 renderEnvelopeForHuman() public API + (command, kind) → renderer registry + generic fallback"
prs: [544]
---

Single public entry point for human rendering: routes a typed
`RenderableEnvelope<T>` by `(command, kind)` to a registered renderer,
with a generic fallback that handles every envelope kind via inline
string concatenation + B4 helpers (`kvBlock`, `dataTable`). Pure
function — no I/O, no DB. Foundation for the B6/B7/B8 per-command
renderer registrations.
