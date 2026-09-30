---
id: t12870-device-logout-revoke
tasks: [T12870, T12844]
kind: feat
summary: behind CLEO_NEXUS_DEVICE=1, cleo logout nexus signs the device out (E9) and --revoke revokes it (E10); neither reports success until the server confirms, and unsettled requests are retried by the next logout, login or cloud command
---

**Logout with device credentials.** Before this change, `cleo logout nexus` with
`CLEO_NEXUS_DEVICE=1` only looked for a 9.24 session. It printed "nothing to do"
and left the device credential live. It now moves the live credentials into
`pendingSignOut` (`--revoke`: `pendingRevoke`), newest first (`pending` before
`current`), and sends E9 `POST /v1/devices/self/sign-out` (or E10
`DELETE /v1/devices/self`) with each credential in turn.

**Done means confirmed (contract §3.5, M3).** Only 200, or 401 `device-signed-out`
or `device-revoked`, counts as done. A revoke accepts only `device-revoked`. Any
other 401 means that credential is stale, so the next credential is tried. A
network error, 429, 5xx or a missing route keeps the slot. A confirmed sign-out
keeps the device keys for the next login. A confirmed revoke removes the
(origin, user) entry, and other accounts in the file stay. Each row of the
envelope is `confirmed`, `pending` or `unconfirmed`, and every row that is not
confirmed is also named in `warnings`.

**Retry.** Unsettled slots, and the `retired` requests left by a device change,
are retried by every later `cleo logout nexus`. `cleo login nexus` and every
command that needs a device credential also retry them, best effort. `--revoke`
without `CLEO_NEXUS_DEVICE=1` fails with `E_NEXUS_DEVICE_REQUIRED`.
