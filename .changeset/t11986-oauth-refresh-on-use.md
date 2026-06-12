---
id: t11986-oauth-refresh-on-use
tasks: [T11986]
kind: feat
summary: "DHQ-087: OAuth refresh-on-use at the E9 chokepoint — expired vault OAT is auto-refreshed before provisioning probe; llm test/stream unified through vault chokepoint"
---

Closes DHQ-087. An expired `sk-ant-oat` token with a stored refresh token was silently filtered as "not-provisioned" — no refresh was attempted. `cleo llm test` and `cleo llm stream` used a legacy sync path bypassing the vault.

- **`credential-pool.ts`**: adds `refreshExpiredOAuthForProvider(provider)` — attempts PKCE refresh for every expired-but-refreshable OAuth credential with single-flight coalescing (N concurrent → 1 HTTP call) and 30s negative-cache on failure.
- **`cross-provider-selector.ts`**: `selectBestProvisioned()` and `enumerateProvisionedProviders()` now call `refreshExpiredOAuthForProvider()` for each provider with expired OAuth credentials BEFORE the `isProvisioned()` check.
- **`cli-ops.ts`**: `llmTest()` routes through `resolveCredentialsAsync()` (vault chokepoint) instead of legacy sync path; expands provider support from anthropic-only to all 9 supported providers.
- **`llm-stream.ts`**: `buildSession()` uses `resolveCredentialsAsync()` so vault-stored OAuth credentials are refreshed on-use before streaming.

Live proof: `cleo llm providers` flipped anthropic from `not-provisioned / credential-expired` → `provisioned / auth-reachable`; `cleo llm test anthropic` returned HTTP 200 with a real `msg_` response ID.

Tests: 10 new unit tests — expired+refresh→persisted; refresh fails→re-login hint; no-refresh-token→skipped; single-flight (5 concurrent→1 fetch); negative-cache; `enumerateProvisionedProviders` provisioning-flip.
