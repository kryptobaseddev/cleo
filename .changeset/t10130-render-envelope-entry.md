---
"@cleocode/core": minor
---

feat(T10130): renderEnvelopeForHuman() public API + registry (B5)

Adds the single public entry point for human rendering: routes a typed `RenderableEnvelope<T>` by `(command, kind)` to a registered renderer, with a generic fallback that handles every envelope kind via inline string concatenation + B4 helpers (kvBlock, dataTable). Pure function — no I/O, no DB. Foundation for B6/B7/B8 per-command renderers.

Closes T10130. Epic: T10114. ADR: adr-077-human-render-contract.
