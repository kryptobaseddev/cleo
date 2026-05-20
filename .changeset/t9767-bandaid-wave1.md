---
id: t9767-bandaid-wave1
tasks: [T9767]
kind: refactor
prs: [367]
summary: "Remove all 56 `as unknown as` cast chains in the 4 worst-offender files (Wave 1 zero-tolerance type cleanup)."
---

Wave 1 of the AGENTS.md zero-tolerance bandaid sweep — no more `as unknown as X` chained casts in the worst-offender files.

Removed 56 sites across:

- `packages/cleo/src/cli/commands/nexus.ts` — 28 → 0 (defined `DispatchResponseMeta` once, all consumer sites now typed)
- `packages/core/src/memory/graph-queries.ts` — 10 → 0 (typed row helper)
- `packages/nexus/src/pipeline/index.ts` — 9 → 0 (tightened `NexusTables.nexusNodes` generic from `unknown` to `DrizzleTableRef`)
- `packages/core/src/llm/transports/openai.ts` — 9 → 0 (adapter type alignment: `OpenAIRequestBag`, `OpenAIChatRequest`, `ExtendedChatMessage`, `ExtendedUsage`, `ExtendedChatCompletionChunk`, plus a `hasProp()` type-guard helper that correctly accepts function-shaped class constructors)

8 named declarations introduced (all in contracts where shared, in-file where local). One stray `@ts-ignore` in `packages/skills/scripts/validate-operations.ts:33` also resolved (now `@ts-expect-error T9767-followup:` with a one-line rationale).

125 remaining `as unknown as` sites across the monorepo are tracked as Wave 2 (separate task — not in this PR).
