---
id: nexus-login
tasks: [T12712]
kind: feat
summary: "`cleo login nexus`: device-code sign-in to a Cleo Nexus account, `cleo logout`, a Nexus row in `cleo status` / `cleo auth list`, and `cleo project link`"
---

Connects the CLI to a Cleo Nexus account.

- **`cleo login nexus [--api-url] [--no-browser] [--json]`** signs in with the RFC 8628 device-code grant. It runs the existing device-code runner (`core/src/llm/oauth/device-code.ts`), now parameterised with `bodyEncoding: 'json'` (better-auth's token endpoint refuses form bodies) plus injectable `fetch`/`sleep`; the kimi-code LLM login is unchanged and shares the same stderr prompt. `nexus` is a reserved target checked before the LLM registry, so `cleo auth login nexus` and `cleo llm login nexus` work too, and the `cleo login` picker lists "Cleo Nexus account" first.
- The session token is stored in `~/.cleo/nexus-credentials.json` (0600, keyed by API origin, rotated backups purged on logout) behind a `NexusTokenStore` interface, so a keychain store can replace the file later. It is never printed: results, status rows and errors are secret-free, and a sealed handle masks it in JSON, `inspect` and strings.
- **`cleo logout [nexus | <provider> [label]]`** is a new root verb. `nexus` (the default) revokes the session server-side (`POST /api/auth/sign-out`) and deletes the local token even when revocation fails. A provider removes an LLM credential through the same logic as `cleo auth remove` (now `removeLlmCredential` in core).
- **`cleo status`** and **`cleo auth list`** show the Nexus account: signed-in email, organization and API URL, or "not signed in". A 401 reads as "session expired", never a crash, and nothing touches the network unless a token is stored.
- **`cleo project link [--label] [--api-url]`** registers the project (`POST /v1/projects`) under its tracked `.cleo/project-id` with its display name as a plaintext label (`--label` overrides), never a path. It is idempotent: re-linking after a rename updates the server label. The binding is kept in the machine-local `.cleo/nexus-link.json`. The name comes from one accessor, `getProjectDisplayName`.
- `cleo setup` gains an optional `nexus-account` section that runs the same login engine.
