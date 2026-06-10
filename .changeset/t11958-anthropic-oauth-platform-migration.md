---
id: t11958-anthropic-oauth-platform-migration
tasks: [T11958]
kind: fix
summary: Fix anthropic OAuth login HTTP 400 (DHQ-075) — platform.claude.com endpoint migration + JSON/state exchange wire shape + un-mask nested-object token-endpoint errors
---

`cleo llm login anthropic` failed the PKCE token exchange with `HTTP 400 — [object Object]` (T11958 / DHQ-075, recurrence of T11774). Two root causes, both fixed and proven with a real end-to-end login + a live Pi-loop inference round-trip on the resulting `sk-ant-oat` token:

1. **Stale endpoints + wrong wire shape** — Anthropic retired the `console.anthropic.com` OAuth endpoints in the claude.com domain migration. The builtin profile now uses `https://platform.claude.com/v1/oauth/token` + `https://platform.claude.com/oauth/code/callback`, sends `code=true` on authorize (hosted page displays the paste-back code), and exchanges/refreshes with the non-RFC `application/json` body **including the authorize-time `state`** — the exact wire shape of the embedded pi-ai reference (`@earendil-works/pi-ai` `utils/oauth/anthropic`). New `ProviderOAuthConfig.tokenBodyFormat: 'form' | 'json'` contract field keeps RFC form-encoding the default for OpenAI/Codex and every other provider.

2. **Error masking** — `extractErrorDetail` did `String(body.error)` on Anthropic's nested `{"error":{"type","message"}}` body → `[object Object]`, hiding the cause. The extractor now unwraps `message`/`type`, JSON-stringifies unknown objects, and is exported as the single shared `extractOAuthErrorDetail` — replacing two drifted local copies (`google-pkce.ts`, `device-code.ts`) that still carried the same masking bug.

Also: paste-back input now accepts all three forms the hosted callback can hand the user (full redirect URL, `code#state`, bare query string) with CSRF state validation in the headless flow; the duplicated token-POST blocks in `pkce.ts` collapsed into one `postTokenRequest` helper; `cleo llm list` `hasRefreshToken` now reports the stored value instead of the obsolete Phase-2 hardcoded `false`; stale S-07 doc block corrected.
