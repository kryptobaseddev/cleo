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
read `nexus-device.json`. A device credential is checked live through
`GET /v1/whoami`; a 401 reads as expired. A device signed out locally reads as
not signed in. A device row replaces any leftover session row for its origin.
The wizard logs in with device enrolment too, and treats a stored device
credential as already configured.
