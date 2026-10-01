---
id: t12904-device-default-on
tasks: [T12904]
kind: feat
summary: cleo login nexus enrols this machine as a device by default; CLEO_NEXUS_DEVICE=0 keeps the 9.24 session login. cleo status, cleo auth list and the setup wizard report device logins.
---

**Device credentials by default.** `cleo login nexus` now proves who you are
and enrols this machine as one of your devices in the same browser approval.
The machine gets its own credential, its own keys and its own row on
cleocode.dev/devices. You no longer need `CLEO_NEXUS_DEVICE=1`. A stored 9.24
session is upgraded to a device on first use, with no second approval.
`CLEO_NEXUS_DEVICE=0` is the temporary escape hatch back to the 9.24 session
login.

**Status shows devices.** `cleo status`, `cleo auth list` and the setup wizard
always read `nexus-device.json`, whatever `CLEO_NEXUS_DEVICE` says: the switch
picks only the login flow and never hides a live credential.
- A device credential is checked live through `GET /v1/whoami`, with the
  current credential only; a 401 reads as expired.
- A device signed out locally reads as not signed in.
- A device row replaces a leftover session row of the same user; a session of
  another user still shows.
- A device file that cannot be read becomes one row naming the error, and the
  session rows stay.

**Logout always ends the device.** `cleo logout nexus` signs out every stored
device credential and a leftover 9.24 session, even with `CLEO_NEXUS_DEVICE=0`.
**Envelope change:** `cleo logout nexus --json` now always returns
`{apiUrl, action, devices, session, warnings}`. On the session-only path the
old `{removedLocally, revocation}` fields move under `session`. A `--revoke`
with only a 9.24 session warns that nothing was revoked.
`CLEO_NEXUS_DEVICE` accepts `0`, `false`, `off` or `no` (case-insensitive) to
switch the device login off.

The wizard logs in with device enrolment, and treats a stored device credential
as already configured.
