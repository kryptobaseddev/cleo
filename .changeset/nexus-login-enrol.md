---
id: nexus-login-enrol
tasks: [T12868]
kind: feat
summary: behind CLEO_NEXUS_DEVICE=1, `cleo login nexus` enrols this machine as a Nexus device and stores only a scoped device credential, and a 9.24 session is upgraded once, automatically
---

Adds `@cleocode/core/cloud/nexus-enrol.js`, the client side of the cleo-nexus
device contract v2.9 §3.3 (login steps 4 to 10), §3.4 (the 9.24 auto-upgrade)
and §4.0.4 (error mapping). The device behaviour is behind `CLEO_NEXUS_DEVICE=1`.
With the switch unset, `cleo login nexus` runs the same 9.24 session login, with
two differences: `--read-only` is refused (`E_NEXUS_DEVICE_REQUIRED`, exit 6)
instead of signing in with full privileges, and `--name` is ignored with a
warning. `cleo project link` also retries once on 409 `project-id-taken`
whether or not the switch is set.

- **Login.** The device-code session (requested with scope `cleo:device` or
  `cleo:read-only`) is held in memory only. `/v1/whoami` names the user; under
  the `nexus-device.json` lock the device identity (a UUIDv7 and fresh X25519
  and Ed25519 keys from `node:crypto`) is persisted with an E1 intent; the lock
  is released; E1 (`POST /v1/devices/enroll`) is sent with an Ed25519 proof over
  `cleo-nexus/device-enroll/v1\nuserId\ndeviceId\nencHex\nsigHex\nprofile`; the
  lock is re-taken and the credential stored with a compare-and-swap. The
  session is then signed out, and `/v1/whoami` confirms the credential. New
  flags: `--read-only` and `--name` (the default name never contains the
  hostname; a name equal to it warns).
- **No lock across the network.** The lock covers only local
  read-modify-writes; every E1 and E2 call uses a plain timeout. The device
  store's docs now say so (v2.9), replacing the old "hold the lock across E1/E8"
  guidance.
- **Racing logins.** When the file already holds a different credential for the
  same identity at step 7, ours is first parked, sealed, as `raceCandidate`;
  then `/v1/whoami` is asked about both and the one that answers 200 is kept;
  the other is dropped with no E9 and no `pendingSignOut`. Both live: the later
  `createdAt` wins, with `W_NEXUS_LOGIN_RACE_BOTH_LIVE`. Both refused: neither
  is kept and a login is required. No answer: both stay and the next cloud
  command settles them, so the only live credential is never lost. Step 7 also
  refuses when another process replaced the device identity meanwhile, and
  never retires that device's credential for ours.
- **Intents.** An E1 intent is refreshed (owner CAS) right before E1, and it is
  stale only after E2's timeout + E1's timeout + a margin, so a working owner
  is never taken over. An upgrade waits on any live intent (upgrade or login).
- **Conflicts.** 409 `device-revoked` and `device-other-account` mint a new
  identity and retry once; `device-id-taken` first re-reads the file under the
  lock and uses another process's enrolment of the same id, else mints a new
  identity; `device-keys-changed` mints a new identity only when the local keys
  were lost, and is reported otherwise. `cleo project link` retries once on 409
  `project-id-taken`.
- **Revoke pending.** Login refuses with `E_NEXUS_REVOKE_PENDING` while a revoke
  of the same device is unconfirmed, and never clears `pendingRevoke`.
- **Lost machine key.** An entry that cannot be opened is discarded, a new
  device is enrolled, and the warning names the old device id to revoke.
- **9.24 upgrade.** `upgradeNexusSession` / `ensureNexusDeviceCredential` (used
  by `cleo project link` with the switch on) re-check both files under both
  locks (device file first): an existing credential stops without E1, and the
  leftover 9.24 session is signed out server-side (best effort, after the lock
  is released) and then removed from the v1 file; a consumed session stops too; a live upgrade intent from another process is waited for;
  a stale one (older than E1's timeout) is taken over only when a second locked
  re-read finds no credential and the same intent. A lost E1 answer on this
  one-shot path reports `E_NEXUS_SESSION_EXPIRED` ("needs a browser login") and
  the session is never retried; the v1 file keeps format version 1.
- **Accounts.** `ensureNexusDeviceCredential` uses the named user, the upgraded
  one, or the only account on the origin; with several it refuses with
  `E_NEXUS_ACCOUNT_AMBIGUOUS` and lists them.
- **Switching the flag back and forth.** With the switch on, a cloud command
  signs out and removes a 9.24 session left in `nexus-credentials.json`. If the
  switch is then turned off, the CLI finds no session and asks for a 9.24
  login, which writes a new session; turning the switch on again signs that
  one out and removes it. Nothing is lost (the device credential stays in
  `nexus-device.json`), but each flip costs a login. Pick one setting per home.
- **Error codes.** `E_NEXUS_UNREACHABLE`, `E_NEXUS_REVOKE_PENDING`,
  `E_NEXUS_DEVICE_SIGNED_OUT`, `E_NEXUS_DEVICE_REVOKED`,
  `E_NEXUS_CREDENTIAL_COMPROMISED`, `E_NEXUS_INSUFFICIENT_SCOPE`,
  `E_NEXUS_REPLICA_COPIED`, `E_NEXUS_BUSY`, `E_NEXUS_ACCOUNT_AMBIGUOUS` and
  `E_NEXUS_DEVICE_REQUIRED` join `NEXUS_ACCOUNT_ERROR_CODES`,
  and `nexusApiErrorToAccountError` maps every §4.0.4 reason to them. A 401
  `credential-revoked` whose `details.revokedReason` is `reenrolled` maps to a
  login-required error, never to `E_NEXUS_CREDENTIAL_COMPROMISED`.
  `NexusLoginResult` gains optional `device` and `scopes`.
