---
id: nexus-registry-host
tasks: [T14013]
kind: fix
summary: "`projects clean` never removes a registry row whose project lives on another machine"
---

Registry rows record no host, so `cleo nexus projects clean --orphans` or
`--unhealthy` could remove the row of a project that lives only on another
machine sharing the global store (a Linux `/mnt/...` or `/home/...` checkout
seen from a Mac). A row's host is now read from `nexus_project_locations`: a
project with a live location on another device is kept, even when this machine
also recorded it (a clone here that is now missing), and is reported under
`otherHost` with its devices. A legacy row with no location record is judged
only by its path: it is kept when the path root does not exist here, but a path
under the same username from another machine cannot be told apart and stays
removable. `cleo nexus status` counts those rows as `registry.otherHost`;
`registry.unreachable` counts only this machine's rows.
