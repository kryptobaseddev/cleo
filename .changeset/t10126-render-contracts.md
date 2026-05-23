---
id: t10126-render-contracts
tasks: [T10126, T10138, T10139, T10140, T10141]
kind: feat
summary: "B1 typed render contracts — TreeResponse, TableResponse, ListResponse, RenderableEnvelope"
prs: [531]
---

Adds `packages/contracts/src/render/` with typed shapes for the unified
human-render contract (Epic T10114, ADR-077): `TreeResponse<T>`,
`TableResponse<T>`, `ListResponse<T>`, `GroupedListResponse<T>`,
`SectionResponse`, and the `RenderableEnvelope<T>` discriminated union
plus type guards. Pure types — no implementation logic.

Subtasks: T10138 (tree), T10139 (table), T10140 (list), T10141 (envelope).
