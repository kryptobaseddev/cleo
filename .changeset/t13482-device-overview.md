---
id: t13482-device-overview
tasks: [T13482]
kind: feat
summary: cloud activity --devices shows, per device, its presence, its newest journal change and its newest server event
---

`cleo cloud activity --devices` answers "what did my other devices change, and when, and are they online" in one
place. It prints one row per device, newest activity first: name, whether it is this machine, online (presence within
the freshness window) and last seen, its journal transactions in this store with the newest one's command, status and
tables, and its newest server event (snapshot, lease, enrolment). `--offline` reads only the local journal and warns
`W_DEVICE_OVERVIEW_LOCAL_ONLY`; a failed device list or event read becomes `W_DEVICE_OVERVIEW_PARTIAL`. The human
output of `cloud activity`, `--journal` and `--devices` now points at the other two views.
