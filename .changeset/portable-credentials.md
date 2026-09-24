---
id: portable-credentials
tasks: [T12326]
kind: fix
summary: "Credentials survive a moved project and a new device: the project KDF is keyed by project identity, and backups seal credentials under a passphrase instead of carrying the machine-key"
---

Stored credentials were bound to the device and, for project credentials, to
the project's absolute path. The project key was `HMAC-SHA256(machine-key,
projectPath)`, so renaming or moving a checkout made its credentials
undecryptable. A restore on a new device had only two choices: copy the
`machine-key` (which merges two devices into one trust domain) or lose every
credential.

**Project KDF keyed by identity.** New project ciphertexts (version `0x02`) use
`HMAC-SHA256(machine-key, "cleo:project-credential:v2\0" ‖ projectId)`.
`decryptProjectSecret` still reads legacy path-bound (`0x01`) ciphertexts. It
tries each supplied candidate path and returns the secret re-wrapped under the
new KDF so the caller can persist it. `migrateProjectCredentials` does this in
place for `tasks_agent_credentials`, using a compare-and-swap so a concurrent
write wins. It is idempotent, and it never deletes: a ciphertext that no
candidate opens is left untouched and reported, together with the command that
re-enters it. The path-bound `encrypt`/`decrypt` exports are removed; nothing
outside tests called them.

**Portable transfer without the machine-key** (`store/credential-transfer.ts`):

- `sealCredentials(sources, passphrase)` decrypts every local credential and
  seals the plaintexts with the encrypted-bundle envelope (scrypt +
  AES-256-GCM). The stores covered are project agent keys, global service
  connections, and the LLM pool. The payload holds credentials, never key
  material; a test asserts the machine key's raw, hex, and base64 forms are
  absent.
- `unsealCredentials(sealed, passphrase, targets)` re-encrypts each credential
  under the target device's machine-key. A wrong passphrase fails with
  `E_CREDENTIAL_PASSPHRASE` before any write.
- `redactCredentialCiphertexts` and `listCredentialsForReentry` handle
  unencrypted bundles. They blank the device-bound ciphertexts in the staged
  snapshots (and refuse live stores), then list each credential with its
  re-entry command (`cleo agent register …`, `cleo service connect …`,
  `cleo llm add … --api-key-stdin`).

**Machine-key path follows `CLEO_HOME`.** `crypto/credentials.ts` used to derive
the XDG path itself and ignore `CLEO_HOME`. With `CLEO_HOME` set, the machine
key and the global salt were read from different directories. The default path
is unchanged on every platform.

The LLM pool (`llm-credentials.json`) remains a plaintext 0600 file on purpose.
Its key would sit beside it with the same mode, and encryption would put a key
read on the synchronous resolver path. The protection that matters is that the
pool never enters an unencrypted bundle.
