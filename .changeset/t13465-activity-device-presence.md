---
id: t13465-activity-device-presence
tasks: [T13465]
kind: fix
summary: cloud activity --journal names every device, including signed-out and revoked ones, and shows each device's last presence
---

The `--journal` device lookup read only the first page of active devices, so transactions from a signed-out or revoked
device showed no name. It now follows every page of the account's device list with `state=all`. Each device in the
per-device summary also carries `lastSeenAt`: its last presence report (`lastPresenceAt`, else `lastSeenAt`), or `null`
offline or when unknown. The human summary appends `seen <time>`.
