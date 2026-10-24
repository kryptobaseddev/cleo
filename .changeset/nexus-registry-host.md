---
id: nexus-registry-host
tasks: [T14013]
kind: fix
summary: "`projects clean` never removes a registry row whose project lives on another machine"
---

Registry rows record no host, so `cleo nexus projects clean --orphans` or
`--unhealthy` could remove the row of a project that lives only on another
machine sharing the global store (a Linux `/mnt/...` or `/home/...` checkout
seen from a Mac). A row's host is now read from `nexus_project_locations`:
a project recorded only on other devices, or a legacy row with no record whose
path root does not exist here, is kept and reported under `otherHost` (with
its devices). `cleo nexus status` counts those rows as `registry.otherHost`;
`registry.unreachable` counts only this machine's rows.
