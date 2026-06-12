---
id: t11985-codex-wire-shape-fix
tasks: [T11985]
kind: fix
summary: "DHQ-086: codex_responses wire shape fixed — store:false, OpenAI-Beta header, SSE Accept, error-body surfacing"
---

Fixes the `codex_responses` transport (T11767) which returned `400 status code (no body)`
on every call to the ChatGPT Codex backend. Auth was correct (not 401); the request shape
was rejected.

**Root causes vs pi-ai 0.78.x reference wire shape:**

- `store: false` absent from body — Codex backend requires explicit false (rejects absent or true)
- `OpenAI-Beta: responses=experimental` header missing — required by the backend
- `Accept: application/json` sent (OpenAI SDK default) — SSE streaming requires `text/event-stream`
- `max_output_tokens` sent — Codex backend rejects it (`400 {"detail":"Unsupported parameter"}`)
- HTTP error response body lost — surfaced as "(no body)" even when structured JSON was present

**Fix:** Rewrote `CodexResponsesTransport` to use raw `fetch` instead of the OpenAI SDK,
mirroring the pi-ai 0.78.x `openai-codex-responses.js` wire shape. Added `buildHttpError()`
to read and surface the response body (JSON `{error.message}` or raw text) in thrown errors.

**Live proof:** `cleo llm stream openai "Reply with exactly: pong"` → `pong`

**Tests:** 26 unit tests via `globalThis.fetch` mock asserting exact wire shape (store:false,
stream:true/false, OpenAI-Beta, accept:text/event-stream, auth headers, error surfacing,
SSE delta parsing, URL normalization).
