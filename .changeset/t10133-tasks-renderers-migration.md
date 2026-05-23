---
"@cleocode/cleo": patch
"@cleocode/core": minor
---

refactor(T10133): decompose tasks.ts (371 LOC) into packages/core/src/render/tasks/ (B8)

Migrates renderShow / renderList / renderFind / renderAdd / renderUpdate /
renderComplete / renderDelete / renderArchive / renderRestore from
packages/cleo/src/cli/renderers/tasks.ts to packages/core/src/render/tasks/.
Each renderer self-registers into the B5 registry on module load under
`(command, 'generic')`. Zero behavior change — the existing
`(data: Record<string, unknown>, quiet: boolean)` signature is preserved
and the dispatcher continues to invoke renderers directly until the
typed-envelope migration completes.

Adds `RenderOptions.quiet` to `@cleocode/core/render` so registry adapters
can forward the legacy quiet flag through `renderEnvelopeForHuman`.

Closes T10133. Epic: T10114. ADR: adr-077-human-render-contract.
