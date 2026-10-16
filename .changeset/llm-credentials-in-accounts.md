---
id: llm-credentials-in-accounts
tasks: [T13715, T13528]
kind: fix
summary: LLM credentials now live encrypted in the synced accounts table, so a key added with cleo llm add on one device works on your others; llm-credentials.json is migrated once and removed
---

`cleo llm add` wrote the key to a plaintext `llm-credentials.json` in the CLEO
home. The synced global `accounts` table, whose secrets the home stream
already seals, had no production writer, so a credential never left the
device it was added on.

- **Encrypting writer (T13528).** A new accessor,
  `store/llm-accounts-accessor.ts`, stores each pool credential in `accounts`
  with its API key or access token in `secret_enc` and its refresh token in
  `refresh_enc`. Both are encrypted under the machine key with the id
  `account:<provider>:<label>`, the same id the sync sealer uses. The writer
  reuses `encryptGlobal`, like the service-connection vault. An unchanged
  secret keeps its ciphertext, so request-count write-backs do not re-send it.
- **Every pool path goes through it (T13715).** The credential store keeps
  its API (`addCredential`, `listCredentials`, `removeCredential`, the
  pickers). `cleo llm add`, `list` and `remove`, onboarding, the Studio keys
  page, the pool's write-backs and the resolver now read and write
  `accounts`. Resolution stays synchronous: it reads the store read-only and
  decrypts with the new `decryptGlobalSync`.
- **Legacy file.** The first pool call migrates `llm-credentials.json` into
  `accounts`. If `accounts` already holds an entry, that entry is kept. The
  plaintext file is deleted only after every entry reads back, and a
  malformed file is left alone. Until the migration runs, the resolver also
  serves entries that are still only in the file.
- **Backups.** Encrypted bundles seal the `accounts` credentials. Unencrypted
  bundles blank them in the staged snapshot and list them for re-entry. A
  sealed restore writes them into the restored global store.

Not changed: the pool's per-credential `extraHeaders`, `baseUrl` and
`metadata` are stored as plaintext JSON in `accounts.metadata`, which syncs.
Numbered backups of the old file under `<cleoHome>/.backups/` are not removed.
