---
id: nexus-fleet-status
tasks: [T12513, T12512]
kind: feat
summary: "`cleo nexus projects status` is now a fleet view: every project, where it lives on each device, and its last recorded git state (branch, HEAD, dirty, ahead/behind as of the last fetch) with probe, fetch and heartbeat staleness; paged with counts first, filters for missing/dirty/behind/ahead/stale/errored/device, and a live re-probe only with --refresh. Registry reads now fail with a typed E_NEXUS_REGISTRY_READ error instead of returning an empty list, and last_probed_at is separate from last_opened_at"
---

**Breaking — `cleo nexus projects status` output shape.** v2026.9.21–9.23
shipped this command as T12511's probe, which returned `rows`,
`otherDevices`, `count` and `summary.{ok,errored,timedOut,dirty,remoteStale}`
and ran git on every call. It now returns the fleet view below and reads
recorded rows only. Scripts that read `--field /data/rows` or
`/data/otherDevices` must switch to `/data/projects` (each project's
`locations[].git`). To keep the old probe-then-read behaviour, pass
`--refresh`; the probe's own counts are then under `/data/refresh`. The mutate
dispatch operation `nexus.projects.status` still returns the old shape.

`cleo nexus projects status` reads the probe rows that T12511 records. It does
not run git, open any project's own store, or fetch. It returns:

- Counts first: `total`, `matched`, `returned`, `offset`, `limit`, `hasMore`,
  a fleet `summary` (projects that are missing, dirty, behind, ahead, stale,
  errored or unprobed) and per-device counts with each device's last
  heartbeat.
- One page of `projects`. Each project has a location on every device that
  holds it. A location has the device id and hostname, path, state, and the
  last recorded git state:
  - local: branch, HEAD, detached, dirty and untracked counts
  - remote: upstream, ahead and behind, remote head, `fetchedAt` and a
    `stale` flag
  - `probedAt` and `probeStale`, and the probe error when there was one

`behind` is never reported as current when it is not. It comes from the last
fetch, and `remote.fetchedAt` says when that was. A never-fetched or old fetch
is flagged `stale`.

Flags: `--missing`, `--dirty`, `--behind`, `--ahead`, `--stale`,
`--errored` and `--device <id|hostname|current>`. They combine with AND on one
location. Other flags:

- `--stale-after-ms` sets the staleness window (default 24h).
- `--limit` sets the page size (default 50, max 500; 0 returns every match).
- `--offset` skips projects before the page.

Each call costs seven SQL statements whatever the number of projects: two
counts, one `LIMIT/OFFSET` page, the locations of that page only, one
aggregate pass and one per-device `GROUP BY`. Every join is on the
`(project_id, device_id, path)` primary key. Measured on 500 projects × 2
devices it takes about 2 ms, and on 5,000 × 2 about 11–15 ms.

`--refresh` re-probes this device's locations first, using T12511's probe
(8 at a time by default, with a per-repository timeout). `--fetch` does the
same and also fetches, so it touches the network. A probe cannot reach another
device's checkouts, so that device's rows are refreshed on that device.

The new query operation `nexus.projects.fleet` backs the command. The mutate
`nexus.projects.status` operation (the probe) is unchanged.

T12512: `nexusList`, `readRegistry` and `nexusGetProject` no longer turn a read
failure into `[]` or `null`. They throw `NexusRegistryReadError` with the code
`E_NEXUS_REGISTRY_READ` and exit code 75. The engine wrappers return it as a
typed error envelope, and the project health report carries a
`registryError`, so an unreadable registry never looks like an empty one.
`nexusGetProject` still returns `null` for "no such project".

The cleo-global migration `20260929010000_t12512-registry-probed-opened` adds
two columns to `nexus_project_registry`, both ISO-8601 checked and NULL by
default:

- `last_probed_at` is written by health checks, `nexus sync` and the git
  probe. They no longer bump `last_seen`.
- `last_opened_at` is written only by real CLI use inside a project, at most
  once a minute. `cleo doctor` does not count as use.

The migration also indexes `last_opened_at`.

`last_seen` keeps one meaning: the last identity or location write to the
registry row (registration, a new or moved checkout, reconcile, rename, index
stats). It is not bumped on every command. Anything that asks "recently
active" reads one accessor, `projectLastActivity` = max(`last_seen`,
`last_opened_at`, `last_probed_at`). The temp-project GC, project-name
disambiguation and the Studio project list all use it, so a non-git project
opened daily is never offered for removal as inactive.

`E_NEXUS_REGISTRY_READ` (exit 75, shared with `E_NEXUS_REGISTRY_CORRUPT`) and
`E_NEXUS_DEVICE_NOT_FOUND` (exit 4) are in the gateway error-code catalog. The
command exits with the typed error's own exit code.
