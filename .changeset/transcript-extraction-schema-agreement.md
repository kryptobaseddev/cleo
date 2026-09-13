---
id: transcript-extraction-schema-agreement
tasks: [T12133]
kind: fix
summary: transcript extraction prompt agrees with its schema, sends a schema on the wire, and honours --projects-dir (gh#1219)
---

`cleo transcript extract` failed with "No object generated: response did not
match schema" for every OpenAI-compatible model tested. Two independent
defects combined.

**The prompt contradicted the schema.** The system prompt ended "Return empty
array if nothing of durable value exists" and the user prompt repeated it,
while the zod schema requires the object `{memories: [...]}`. Literal-minded
models followed the prose: a bare `[]` from deepseek-chat, `{"extractions":
[]}` from gpt-4o-mini, `{"memories": ["string", ...]}` from glm-4.6, and one
correct response in 1 of 4 attempts from glm-5.3-flash. Nothing was stored in
any failing case. The prompt now states the object envelope, names the bare
array as wrong, and is exported so a test can hold it to the schema.

**No schema reached the wire.** `generateObject` was called without
`structuredOutputs`, so the AI SDK dropped `response_format` and warned that
it had — leaving correctness entirely to the prompt discipline the first
defect undermined. Structured outputs are now requested; providers that do not
consume the `openai` provider-options namespace ignore it.

The rewritten prompt also contains the word "json", which
`response_format: json_object` requires in messages. Its absence made short
transcripts fail with HTTP 400 while longer ones that happened to mention json
failed later at validation — so the command looked transcript-dependent and
flaky rather than broken.

**`--projects-dir` was a dead flag** on `transcript extract`: declared in the
CLI, never read, while the scanner hardcoded `~/.claude/projects`. The override
now reaches both scanner entry points.
