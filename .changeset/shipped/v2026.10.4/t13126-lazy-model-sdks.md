---
id: t13126-lazy-model-sdks
tasks: [T13126]
kind: fix
summary: Loading @cleocode/core no longer evaluates js-tiktoken, the AWS Bedrock SDK or the ai SDK
---

Every `cleo` command loads `@cleocode/core/internal`, and so does any SDK consumer of the core
barrel. Four modules reachable from it imported heavy model SDKs at load time:

- `llm/conversation` imported js-tiktoken, which is 5.4 MB of source plus its rank tables.
- `llm/transports/bedrock` imported the Bedrock client and the AWS credential-provider chain.
- `memory/dialectic-evaluator` and `memory/transcript-extractor` imported `ai`.

Few commands ever use these SDKs, yet together they added about 45 MB of peak RSS to every process.
Each one now loads the SDK on first use. `countMessageTokens` stays synchronous; the Bedrock and
`generateObject` paths were already asynchronous.

Loading `@cleocode/core/internal` peaks about 463 -> 415 MB, with 163 -> 149 MB of heap after GC.
`cleo show`/`find`/`list`/`current` peak about 400 -> 373 MB. Output is unchanged.

A dist test fails if loading either core barrel evaluates any of these SDKs again. Gate 22 (AI SDK
surface inventory) now counts `import('ai')` as a runtime reach, so the inventory still lists the
two memory modules.
