---
id: docs-add-name-rule
tasks: [T14129]
kind: feat
summary: "cleo docs add refuses a new slug that carries a task id, session id or date (E_DOC_NAME_RULE)"
---

`cleo docs add` now applies the doc naming rule (D11210) to new slugs: a
slug with a task id, session id or date, or one longer than 64 characters,
is refused with `E_DOC_NAME_RULE`. The refusal names the subject-only slug
to use instead. Existing docs keep their names and still read, update,
fetch and version as before.

CLEO's own slug minters follow the rule: an ADR allocated from a title
drops task ids and dates from its tail and fits the length cap, and the
spawn `{{TOPIC_SLUG}}` token (spawn prompt, injection tokens, orchestrator
spawn) carries the task's subject, not its id. The task stays a link on
the doc.
