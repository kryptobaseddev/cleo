---
id: provider-base-url-ssot
tasks: [T12132]
kind: fix
summary: OpenAI-compatible providers route to their own endpoint instead of api.openai.com (gh#1216)
---

`deriveApiWire` returned `baseUrl: null` for every OpenAI-compatible provider
except Codex, and a null base URL makes the OpenAI SDK fall back to
`api.openai.com`. An OpenRouter key was therefore sent to OpenAI, which
rejected it with its own canonical 401 pointing at platform.openai.com — an
error that blames the credential rather than the routing, which is why the
reporter needed a packet-level read to find it.

The reported provider was `openrouter`, but the same fault applied to
`deepseek`, `xai`, `groq` and `moonshot`: every documented OpenAI-compatible
provider was unusable out of the box, with no config surface that fixed it.

The base URLs were never unknown. They were recorded in THREE places — the
hand-written builtin profiles, the generated models.dev catalog, and an inline
map inside `cli-ops.ts` — and consumed by none of the one path that decides
where a request is actually sent. `DEFAULT_PROVIDER_BASE_URLS` is now that
path's source and `cli-ops` reads it too, so the copy used for probing and the
copy used for routing cannot drift.

`openai` deliberately stays `null` (the SDK's own default is correct for it),
`openai` + OAuth still routes to the Codex backend, and the
non-chat-completions providers are untouched.
