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

**Done means proved (contract §3.5, M3).** A request counts as done only on
200, or on a 401 that proves the device's state: `device-signed-out` or
`device-revoked`, or `credential-revoked` with `revokedReason` `signed-out` or
`revoked`. A revoke needs proof of a revoke. Any other 401 means that one
credential is dead, so the next is tried. A network error, 429, 5xx or a
missing route keeps the slot, and the rest of that run's requests are left
for the next run without waiting out more timeouts.

**Ending.**
- A sign-out keeps the device keys for the next login.
- A revoke that ends forgets the device locally, so the next login enrols a
  new device and can never re-activate the id you asked to burn. A revoke
  ends when it is confirmed, when it finds the device already signed out
  (`signed-out`), or when every credential is dead (`unconfirmed`).
- Requests left by replaced devices (`retired`) are sent first and are never
  dropped while one is unsettled.

Only a confirmed row is reported as `confirmed`; every other row is named in
`warnings` with the web remedy. A login that changes the entry while a request
is in flight is reported, never passed off as settled. A broken device file no
longer stops the 9.24 session sign-out.

**Retry.** Unsettled slots are retried by every later `cleo logout nexus`.
`cleo login nexus` and `cleo project link` also retry them, best effort, with a
2 s timeout. `--revoke` with `CLEO_NEXUS_DEVICE=0` fails with
`E_NEXUS_DEVICE_REQUIRED`.
