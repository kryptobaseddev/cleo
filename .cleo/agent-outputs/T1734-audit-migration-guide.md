# T1734 Audit — OpenAI SDK 4 → 6 migration-guide research

Researched from: MIGRATION.md (raw GitHub), CHANGELOG.md, Context7 `/openai/openai-node` docs,
and OpenAI community release announcements. All findings cross-referenced against the actual
cleo surface in `packages/core/src/llm/backends/openai.ts` and `packages/core/src/llm/registry.ts`.

---

## v4 → v5 breaking changes (cleo-relevant only)

- [ ] **node-fetch → native fetch**: SDK drops `node-fetch` dependency entirely and uses the
  platform built-in `fetch`. In Node 18+ this changes streaming body semantics (`body` is now
  a Web `ReadableStream`, not Node's `Readable`). Cleo's streaming loop uses `for await`
  over `AsyncIterable<ChatCompletionChunk>` which is unaffected by the transport change —
  **no action required**; but any code that pipes `response.body` to a Node stream would
  break. **Does cleo's surface trigger this? No** — cleo never touches raw `response.body`.
  Citation: [MIGRATION.md](https://raw.githubusercontent.com/openai/openai-node/master/MIGRATION.md)

- [ ] **`httpAgent` constructor option removed → `fetchOptions`**: The constructor option
  `httpAgent: new HttpsProxyAgent(url)` is replaced by
  `fetchOptions: { dispatcher: new undici.ProxyAgent(url) }`. **Does cleo's surface trigger
  this? No** — cleo only passes `{ apiKey, baseURL }` to the `OpenAI` constructor; no proxy
  agent is configured anywhere in `registry.ts`. Citation: MIGRATION.md

- [ ] **`beta.chat.completions.*` namespace removed**: `client.beta.chat.completions.parse()`,
  `.stream()`, `.runTools()` are now at `client.chat.completions.parse()`, `.stream()`,
  `.runTools()`. **Does cleo's surface trigger this? No** — cleo uses only
  `client.chat.completions.create()` from the main namespace (never the beta namespace).
  Citation: MIGRATION.md / Context7 `/openai/openai-node`

- [ ] **`runFunctions()` helper removed**: Replaced by `runTools()`. **Does cleo's surface
  trigger this? No** — cleo does not use `runFunctions()` or `runTools()`.
  Citation: MIGRATION.md

- [ ] **Event name renames in `runTools()`**: `functionCall` → `functionToolCall`,
  `functionCallResult` → `functionToolCallResult`, etc. **Does cleo's surface trigger this?
  No** — cleo does not use the `runTools()` event-based helper.
  Citation: MIGRATION.md

- [ ] **`.del()` renamed to `.delete()`**: All resource `.del()` methods are now `.delete()`.
  **Does cleo's surface trigger this? No** — cleo does not call any delete/del resource
  methods on the OpenAI client. Citation: MIGRATION.md

- [ ] **Import path reorganisation — core sub-paths moved**: `openai/error` →
  `openai/core/error`; `openai/pagination` → `openai/core/pagination`;
  `openai/streaming` → `openai/core/streaming`; `openai/uploads` → `openai/core/uploads`.
  Old paths are deprecated (not immediately removed in v5 but should not be relied on).
  **Does cleo's surface trigger this? No** — cleo imports only `import type { OpenAI } from
  'openai'` and `import { OpenAI } from 'openai'`. No deep sub-path imports are used.
  Citation: MIGRATION.md / GitHub PR #1483 commit notes

- [ ] **`APIError.headers` type changed**: Was `Record<string, string | null | undefined>`,
  now a Web `Headers` instance. **Does cleo's surface trigger this? Unsure** — cleo has no
  direct OpenAI error class imports (grep confirms zero `APIError` / `RateLimitError`
  references in production code). Any try/catch that reads `.headers` on a caught error
  would break if it treats it as a plain object. Recommend explicit verification.
  Citation: MIGRATION.md

- [ ] **`APIClient` class removed from exports**: Internal class no longer exported; use
  `OpenAI` instead. **Does cleo's surface trigger this? No** — cleo never imports `APIClient`.
  Citation: MIGRATION.md

- [ ] **`fileFromPath()` helper removed**: Use `fs.createReadStream()` instead.
  **Does cleo's surface trigger this? No** — cleo does not upload files via the OpenAI SDK.
  Citation: MIGRATION.md

- [ ] **Named positional args for multi-path-param methods**: e.g.
  `client.parents.children.retrieve('p_123', 'c_456')` →
  `client.parents.children.retrieve('c_456', { parent_id: 'p_123' })`.
  **Does cleo's surface trigger this? No** — cleo only calls `chat.completions.create()`.
  Citation: MIGRATION.md

- [ ] **Automatic URI encoding of path parameters**: Manual `encodeURIComponent()` calls on
  path params would now double-encode. **Does cleo's surface trigger this? No** — cleo does
  not pass path params that it encodes manually. Citation: MIGRATION.md

- [ ] **Minimum Node.js version raised to 20 LTS**: (was 18 in v4).
  **Does cleo's surface trigger this? Unsure** — depends on the project's Node version
  requirement. Check `.nvmrc` or `engines` field in root `package.json`.
  Citation: MIGRATION.md

- [ ] **Minimum TypeScript version raised to 4.9**: **Does cleo's surface trigger this? No**
  — cleo uses strict TypeScript ≥5.x per project conventions. Citation: MIGRATION.md

- [ ] **`openai/shims/web` import removed**: No longer supported. **Does cleo's surface
  trigger this? No** — cleo does not import shims. Citation: MIGRATION.md

- [ ] **`ParsedChatCompletion` / `ParsedChoice` / `ParsedFunction` type import paths moved**:
  From `openai/resources/beta/chat/completions` to `openai/resources/chat/completions`.
  **Does cleo's surface trigger this? No** — cleo does not import these types by path.
  Citation: Context7 `/openai/openai-node` MIGRATION.md section

---

## v5 → v6 breaking changes (cleo-relevant only)

- [ ] **`ResponseFunctionToolCallOutputItem.output` type widened**:
  Was `string`, now `string | Array<ResponseInputText | ResponseInputImage | ResponseInputFile>`.
  This is a type-level widening that breaks callsites assuming `output` is always a string.
  **Does cleo's surface trigger this? No** — cleo does not use `ResponseFunctionToolCallOutput`
  or the Responses API at all; it exclusively uses `chat.completions.create()`.
  Citation: [CHANGELOG.md](https://github.com/openai/openai-node/blob/master/CHANGELOG.md)
  v6.0.0 entry; [GitHub releases v6.0.0](https://github.com/openai/openai-node/releases/tag/v6.0.0)

Note: v6 appears to be primarily an incremental release over v5. The sole documented breaking
change in v6.0.0 affects the Responses API surface, which cleo does not use. No breaking
changes to `chat.completions`, constructor, streaming, or error classes were found for v6.

---

## Constructor compat (apiKey, baseURL)

The `{ apiKey, baseURL }` constructor signature is **stable across v4, v5, and v6**. Cleo
uses exactly this form in two places — the default client init in `registry.ts` (L44, L50)
and the cached override factories (`getOpenAIOverrideClient`, `getMoonshotOverrideClient`).
The only constructor option that changed between v4 and v5 is `httpAgent` (removed, replaced
by `fetchOptions`), which cleo does not use. The `timeout` option used by the Anthropic client
in cleo is not a pattern applied to the OpenAI client, so there is no timeout-option regression
to worry about. No changes needed to the constructor call sites.

---

## chat.completions.create — non-streaming

The `client.chat.completions.create(params)` signature and the shape of the returned
`ChatCompletion` object are **unchanged from v4 through v6**. The response shape
`{ choices: [{ message: { content, tool_calls }, finish_reason }], usage: { prompt_tokens,
completion_tokens } }` remains identical. Cleo's `_normalizeResponse()` accesses
`response.choices[0]?.message.content`, `response.choices[0]?.message.tool_calls`,
`response.choices[0]?.finish_reason`, and `response.usage.prompt_tokens /
completion_tokens` — all stable. The `usage.prompt_tokens_details.cached_tokens` field
that cleo reads via `as unknown as Record<string, unknown>` is an additive API extension and
is unaffected. **No changes needed.**

---

## chat.completions.create — streaming

With `stream: true`, cleo casts the return value to
`AsyncIterable<OpenAI.ChatCompletionChunk>` and iterates with `for await`. The chunk
shape (`chunk.choices[0]?.delta?.content`, `chunk.choices[0]?.finish_reason`) is
**unchanged from v4 through v6**. In v5, the underlying transport changed from `node-fetch`
to native fetch, but the `AsyncIterable<ChatCompletionChunk>` interface that consumers see
is identical. Cleo also sets `stream_options: { include_usage: true }` and reads
`chunk['usage']` via a cast — this is an additive field present since v4 and continues to
work in v5/v6. The `finish_reason` field lives on `chunk.choices[0]` (not on a top-level
`chunk.finish_reason`), which is how cleo reads it. **No changes needed.**

---

## Error class hierarchy

The error class hierarchy is **unchanged from v4 through v6** (both class names and catching
behaviour). The hierarchy introduced in v4 continues unchanged in v5 and v6:

| Error class | HTTP status | Notes |
|---|---|---|
| `OpenAI.APIError` | base for all API errors | Catch-all; also exported as `APIError` from `openai/error` |
| `OpenAI.BadRequestError` | 400 | (was `InvalidRequestError` in v3 — irrelevant for this migration) |
| `OpenAI.AuthenticationError` | 401 | |
| `OpenAI.PermissionDeniedError` | 403 | |
| `OpenAI.NotFoundError` | 404 | |
| `OpenAI.UnprocessableEntityError` | 422 | |
| `OpenAI.RateLimitError` | 429 | |
| `OpenAI.InternalServerError` | 500+ | |
| `OpenAI.APIConnectionError` | N/A (network) | |
| `OpenAI.APIConnectionTimeoutError` | N/A (timeout) | Subclass of `APIConnectionError` |

**v5 type-level break on `.headers`**: `APIError.headers` is now a Web `Headers` instance
rather than a plain `Record<string, string | null | undefined>`. Code that does
`err.headers['x-request-id']` (bracket notation) works on both; code that passes it to
a function expecting a plain object would break. The recommended import pattern — using
`OpenAI.APIError` from the default export or named imports from `openai/error` — is
unchanged. The deep path `openai/core/error` is an internal-only path not publicly
documented and should not be used.

Cleo's production code has **zero direct `APIError` imports or `instanceof` checks** against
OpenAI error classes (confirmed by grep). If any LLM call error propagates upward, it is
caught generically as `Error`. This means cleo does not benefit from typed error handling
but also is not broken by the `headers` type change.

---

## Native fetch transition (no node-fetch)

Confirmed in v5.0.0. The SDK removes `node-fetch` as a runtime dependency and uses the
platform's built-in `fetch` (available natively in Node 18+; required to be Node 20+ for v5).
Consumer-facing behaviour changes are minimal for cleo: the `AsyncIterable<ChatCompletionChunk>`
streaming interface is unchanged, and cleo never accesses raw `Response` objects or
`response.body`. The one edge case is if the environment running cleo has Node < 20 — v5+
will fail. The other consumer-facing change is that `response.body` on raw `APIResponse`
objects is now a Web `ReadableStream` not a Node `Readable`; cleo does not use raw response
bodies so this is a non-issue. Any proxy/HTTPS-agent configuration would need to migrate from
`httpAgent` to `fetchOptions` — cleo has none.

---

## Open questions / things to verify in cleo's own code post-migration

- **Node.js version gate**: Verify the CI and production runtime is Node 20+. The v5+
  SDK hard-requires Node 20 LTS. Check root `package.json` `engines` field and `.nvmrc`.

- **TypeScript `^4.0.0` version range**: `packages/core/package.json` declares
  `"openai": "^4.0.0"`. After bumping to `^6.x`, run `pnpm run typecheck` (not just
  `pnpm run build`) to catch any type-level regressions — the SDK ships its own types that
  change between major versions.

- **`as AsyncIterable<OpenAI.ChatCompletionChunk>` cast in `stream()`**: The cast on line 262
  of `openai.ts` (`as AsyncIterable<OpenAI.ChatCompletionChunk>`) bypasses the type-checker.
  After bumping, confirm that `OpenAI.ChatCompletionChunk` still exists at that path and the
  shape of `chunk.choices[0].delta.content` and `chunk.choices[0].finish_reason` is
  unchanged. (All evidence says yes, but verify via `tsc`.)

- **`as unknown as Parameters<OpenAI['chat']['completions']['create']>[0]` double-cast**:
  Used in both `complete()` and `stream()` in `openai.ts`. This will silence any parameter
  shape changes. After upgrading, temporarily remove the cast and see if TypeScript surfaces
  any type errors that indicate a real incompatibility.

- **`usage` field access via `as unknown as Record<string, unknown>`**: Cleo reads
  `prompt_tokens_details.cached_tokens` this way. Verify after upgrade that
  `OpenAI.CompletionUsage` in v6 still does not type these fields natively (they are additive
  API fields), so the cast remains correct.

- **`APIError.headers` type** (low priority): If any error-handling code was added after this
  audit that reads `.headers` from a caught OpenAI error, it must be updated to use the Web
  `Headers` API (`.get('x-request-id')`) rather than bracket notation on a plain object.

- **`openai/error` deep import** (if added): The old path `openai/error` still works in v5
  but the canonical internal path is now `openai/core/error`. Prefer `OpenAI.APIError` from
  the default export to avoid import-path fragility.

- **Moonshot backend uses `OpenAI` client with `baseURL`**: Confirm that `MoonshotBackend`
  in `backends/moonshot.ts` requires no changes — it follows the same `{ apiKey, baseURL }`
  constructor pattern which is stable across all versions.

- **`stream_options: { include_usage: true }`**: Verify this parameter is still accepted
  in v6 (it is an additive request field, not an SDK-level option, so it should be stable).

---

## Sources cited

1. [MIGRATION.md (raw)](https://raw.githubusercontent.com/openai/openai-node/master/MIGRATION.md) — primary source for all v4→v5 breaking changes
2. [CHANGELOG.md](https://github.com/openai/openai-node/blob/master/CHANGELOG.md) — v5.0.0 and v6.0.0 entries
3. [GitHub releases v6.0.0](https://github.com/openai/openai-node/releases/tag/v6.0.0) — v6 breaking change: `ResponseFunctionToolCallOutputItem.output` type widening
4. [openai/openai-node — Context7 docs `/openai/openai-node`](https://context7.com/openai/openai-node) — beta namespace migration, streaming helpers
5. [helpers.md (openai-node)](https://github.com/openai/openai-node/blob/master/helpers.md) — streaming helper API surface
6. [OpenAI community: Node SDK 5.0.0 alpha feedback thread](https://community.openai.com/t/your-feedback-requested-node-js-sdk-5-0-0-alpha/1063774) — fetch migration confirmation
7. [v5 updates PR #1483](https://github.com/openai/openai-node/pull/1483) — import path reorganisation commit notes
8. Cleo source files inspected:
   - `/mnt/projects/cleocode/packages/core/src/llm/backends/openai.ts`
   - `/mnt/projects/cleocode/packages/core/src/llm/registry.ts`
   - `/mnt/projects/cleocode/packages/core/src/llm/types.ts`
   - `/mnt/projects/cleocode/packages/core/package.json`
