---
id: nexus-devices
tasks: [T12510]
kind: feat
summary: "New global nexus_devices table (hostname, OS, arch, CLEO version, heartbeat) upserted on CLI start at most once a minute and listed by `cleo nexus projects list`; a registry lookup by a name that matches several projects now fails with E_NEXUS_PROJECT_AMBIGUOUS listing the candidate ids instead of picking one"
---

`nexus_project_locations.device_id` (T12469) now resolves to a machine: the
cleo-global migration `20260928020000_t12510-nexus-devices` creates
`nexus_devices(device_id PK, hostname, os, arch, cleo_version, first_seen,
last_heartbeat_at)`. The CLI records this device on start, keyed by the existing
`<cleoHome>/device-id`; a start inside the one-minute interval costs one `stat`
of `<cleoHome>/device-heartbeat.stamp`, never fails the command, and never
creates the global store. Set `CLEO_DISABLE_DEVICE_HEARTBEAT=1` to turn it off.

`nexusGetProject` by name no longer returns an arbitrary row when the name is
shared: it throws `NexusProjectAmbiguityError` (`E_NEXUS_PROJECT_AMBIGUOUS`,
`details.candidates` = every matching project id). Lookups by id and by hash
are unchanged.
