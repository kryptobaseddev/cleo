---
id: t13290-devices-human
tasks: [T13290]
kind: feat
summary: cleo cloud status and cloud projects show list, in human output, the devices holding the project with their presence
---

The human lines of `cleo cloud status` and `cleo cloud projects show` now end with a
`Devices:` clause. For each device holding the project it shows the device's name and
short id, whether it is this machine (status only), and its last presence: fresh, stale
since a date, or no presence yet. Replicas this device retired are not counted as
holders.

`cleo cloud status` reads the project's replica list for this, and its JSON gains an
optional `holders` array. If the list can't be read, `holders` is left out and a
`W_NEXUS_STATUS_HOLDERS` warning is added. The command doesn't fail. The JSON of
`cleo cloud projects show` is unchanged.
