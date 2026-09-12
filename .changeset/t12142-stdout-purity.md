---
id: t12142-stdout-purity
tasks: [T12142]
kind: fix
summary: stdout carries only the LAFS envelope — the AI SDK's warning banner was breaking ADR-086 on every mutating command
---

Closes GH #1223 (the reproducible half).

ADR-086 states stdout is ONE LAFS envelope per call and all logs go to stderr. On `cleo update` it was not:

```
stdout line 0: {"success":true,"data":{"count":1,"updated":["T12142"],…
stdout line 1: AI SDK Warning System: To turn off warning logging, set the
               AI_SDK_LOG_WARNINGS global to false.

  -> json.loads(stdout): Extra data: line 2 column 1 (char 744)
```

The banner lands **after** the envelope, so parsing the whole of stdout as JSON fails outright. Any consumer parsing stdout — which the `--field` contract actively encourages — has to skip lines first, which is the exact "pipe through `tail`/`jq`" anti-pattern ADR-086 forbids.

## Mechanism

`ai@6`'s `logWarnings` splits its output across both streams, and puts the wrong half on stdout:

```js
// node_modules/ai/dist/index.mjs
console.info(FIRST_WARNING_INFO_MESSAGE);   // stdout  <- breaks the contract
for (const warning of options.warnings) {
  console.warn(formatWarning({ … }));       // stderr  <- correct
}
```

`console.info` is stdout in Node. So the SDK's *banner* polluted the envelope while its *warnings* were already going to the right place.

## Scope: mutating commands only

All 13 read commands swept (`show`, `list`, `find`, `current`, `version`, `session status`, `saga list`, `labels`, `blockers`, `docs list-types`, `memory llm-status`, `backup list`, `next`) emit exactly one envelope and parse clean. The pollution appears on the write path, where the LLM enrichment runs.

## Fixed with a handler, not by silencing

`globalThis.AI_SDK_LOG_WARNINGS` accepts `false` **or a function**. Setting `false` would satisfy the contract by destroying the information, and these warnings are real: the one that surfaced this said `responseFormat is not supported` for `ollama.chat/qwen2.5-coder:3b` — exactly what you want to know when a local model silently ignores a JSON-schema request.

So the warnings are kept and routed to `getLogger('llm:ai-sdk').warn`. Installed at module load of `llm/model-runner.ts`, which AGENTS.md gate 13 makes the SSoT for LLM client construction — the one place every consumer (CLI, studio, daemon) passes through. Idempotent, and it never overwrites a handler an embedder already set or an explicit `false`.

## Why no existing gate caught it

`lint-stdout-discipline` and `lint-stdout-write-allowlist` scan **our** source. This was a dependency's runtime `console.info`, which no static analysis of this repo can see. That is a real gap in the gate family: **stdout purity needs a runtime assertion, not only a static one.** The tests here assert it at runtime by spying on `console.info`, `console.log` and `process.stdout.write`.

## Not in this change

#1223 reports two other stdout lines, neither of which I could attribute:

- **`[LocalBackend] @vlcn.io/crsqlite not installed …`** — not reproducible here, and `grep -rn LocalBackend` over `packages/` finds only a TSDoc mention in `contracts/src/attachment.ts`. It is llmtxt's `LocalBackend`, reached only on a doc/attachment path, and almost certainly the same `console.info`/`console.log` class.
- **`mergeError: task branch 'task/T1655' does not exist`** — this one is **not** stdout pollution. It goes through `getLogger` (`core/src/tasks/complete.ts:1145`), which routes to a log *file* when initialised and to stderr otherwise. The reporter's substantive point still stands though: it is logged at WARN for tasks that never had a task branch, where nothing actually failed, so it reads as a failure and is not one. That is a one-line condition in `complete.ts` and is tracked separately.
