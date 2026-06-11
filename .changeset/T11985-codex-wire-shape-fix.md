---
"@cleocode/core": patch
---

fix(T11985): codex_responses transport wire shape + error-body surfacing (DHQ-086)

Replace the OpenAI SDK call in CodexResponsesTransport with raw fetch to correctly
set `store: false`, `OpenAI-Beta: responses=experimental`, and `accept: text/event-stream`
— all of which the Codex ChatGPT backend requires and the SDK silently omits.
Also surfaces HTTP error response body in thrown errors instead of "(no body)".
