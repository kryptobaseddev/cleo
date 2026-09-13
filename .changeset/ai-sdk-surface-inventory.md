---
id: ai-sdk-surface-inventory
tasks: [T12169]
kind: feat
summary: Gate the set of modules that reach the AI SDK, because each one can put a banner on stdout
---

**gh#1223.** `ai@6`'s `logWarnings` emits its one-time banner with
`console.info` — which is **stdout** — so it lands after the LAFS envelope and
breaks ADR-086's one-envelope-per-call contract. Every module that reaches the
SDK at runtime is therefore a module that can corrupt `--field`.

**Deliberately an inventory, not a per-module rule.** The obvious gate — "every
AI-SDK module must import the stdout guard" — is wrong: the guard is installed
once at the CLI's envelope funnel by design, and requiring each module to
install it would contradict that and produce a dozen redundant installs.

What actually failed was different, and this gate matches it: **a module began
reaching the SDK and nobody asked the coverage question.**
`memory/llm-backend-resolver.ts` builds its client via
`await import('@ai-sdk/openai-compatible')`, imports `ai` only as
`import type { LanguageModel }` — erased at runtime — and never loads the LLM
chokepoint the guard was first installed at.

A measured nuance that shaped the design: with the funnel install removed, the
banner **still** did not reach stdout, because some unrelated module happens to
import the chokepoint on that path. The safety was real and accidental. A static
gate cannot assert reachability — but it can ensure the set of modules that
could ever emit is a set somebody has looked at.

Three proofs, tree clean after each:

| probe | result |
|---|---|
| `import { generateText } from 'ai'` | **FAIL** — net-new entrant |
| `await import('@ai-sdk/anthropic')` | **FAIL** — how the resolver reaches it |
| `import type { LanguageModel } from 'ai'` | **passes** — type-only is not a reach |

The third is the one that matters. Treating a type-only import as a reach is
exactly what made `llm-backend-resolver.ts` look covered, so a gate that flagged
it would encode the original mistake.

Baselined at 6 modules; registered in both `cleo check arch` and the AGENTS.md
table, and the scan boundary is printed with every result.
