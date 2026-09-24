---
id: agent-key-storage
tasks: [T12352]
kind: fix
summary: "Agent API keys are stored encrypted and recoverable. Before this fix, `api_key_encrypted` held a derived HMAC and the real key, including a freshly rotated one, was thrown away"
---

**Root cause.** ADR-037 §5 wrote the global KDF as `apiKey = HMAC-SHA256(machine-key ‖
global-salt, agentId)`. That output is an encryption key. The same section
requires the migration to "decrypt each existing key … and re-encrypt using the
new KDF", and the `AgentCredential` contract says the key is "stored encrypted at
rest". But T355 took the variable name literally:

- `agent-registry-accessor.ts` wrote `deriveApiKey(...)` hex into
  `agent_registry_agents.api_key_encrypted` in `createProjectAgent`,
  `update({ apiKey })` and `rotateKey`, and discarded the key it was given.
- `rotateKey` even threw away the NEW key the cloud had just issued, so the
  only copy was lost.
- The reader then returned hex of that hex as `apiKey`.

Every consumer sends `apiKey` as `Authorization: Bearer` to SignalDock: the
`cleo agent` commands, the conduit dispatch domain, and the HTTP/SSE
transports. None of them could have authenticated with a stored key.

**Decision: store a real ciphertext (option a).** The consumers need the
plaintext key, so the key must be recoverable, and a one-way hash would not do.
`api_key_encrypted` now holds `gk1:` followed by `encryptGlobal` ciphertext of
the real key, under the ADR-037 KDF with credential id `agent:<agentId>`
(`store/agent-api-key.ts`).

- The key survives a restart.
- It moves to another device through the passphrase-sealed credential transfer
  (new store kind `agent-registry`), never by copying the machine-key.
- Re-registering without a key keeps the stored one.
- `update({ apiKey })` and `rotateKey()` store the key they are given, and clear
  `requires_reauth`.

**Existing rows cannot be migrated.** The real key was never stored, so there is
nothing to decrypt. To avoid changing behaviour for anything that depends on
today's value, those rows read back exactly as before. They now carry
`requiresReauth: true`, a new optional field on `AgentCredential`.

- `cleo doctor credentials` and `cleo upgrade` (action `agent_key_storage`) list
  them with the command that re-registers the key:
  `cleo agent register --id <id> --name <name> --api-key <API_KEY>`.
- `doctor credentials --fix` flags them `requires_reauth = 1` in the database.
  It never modifies the stored value, and it is idempotent.
- Re-registering stores the real key and clears the flag.

Credential readers now treat a table that lacks the expected columns as holding
no credentials, so a partial or older schema cannot abort a backup.
