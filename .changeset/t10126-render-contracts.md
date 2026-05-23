---
"@cleocode/contracts": minor
---

feat(T10126): typed render contracts — TreeResponse, TableResponse, ListResponse, RenderableEnvelope (B1)

Adds `packages/contracts/src/render/` with typed shapes for the unified human-render contract (Epic T10114, ADR-077). Includes 4 subtasks: B1.1 tree (T10138), B1.2 table (T10139), B1.3 list (T10140), B1.4 envelope discriminated union (T10141). Pure types + type guards — no implementation logic.

Closes T10126. Subtasks: T10138, T10139, T10140, T10141. Epic: T10114. ADR: adr-077-human-render-contract.
