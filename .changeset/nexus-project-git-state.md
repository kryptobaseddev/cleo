---
id: nexus-project-git-state
tasks: [T12511]
kind: feat
summary: "New `cleo nexus projects status` probes every project location on this device in parallel (bounded concurrency, per-location timeout, no network unless --fetch) and records branch, HEAD, dirty/untracked counts, upstream, ahead/behind, remote head and last-fetch time in the new global nexus_project_git_state table; failures are recorded per row"
---

The cleo-global migration `20260928030000_t12511-project-git-state` creates
`nexus_project_git_state`. Its key is `(project_id, device_id, path)`, the same
key as `nexus_project_locations`. Other devices that share the store can
therefore see where each project lives and its last known git state.

`cleo nexus projects status [--fetch] [--concurrency N] [--timeout-ms N]
[--stale-after-ms N]`:

- Probes `live` and `missing` locations, 8 at a time by default (maximum 64).
- Each location gets one deadline for all of its git calls: 10s by default,
  30s with `--fetch`. When the deadline passes, git's whole process group is
  killed, including ssh and credential helpers. `GIT_TERMINAL_PROMPT=0` and
  `GIT_OPTIONAL_LOCKS=0` are set.
- Runs `git fetch` only when `--fetch` is passed. Otherwise ahead/behind and the
  remote head come from the last fetch. `remoteFetchedAt` is the newest
  `FETCH_HEAD` mtime, and `remoteStale` is set when that time is unknown or
  older than `--stale-after-ms` (default 24h).
- Records a failure as a row with `probeErrorCode`. The codes are
  `E_PATH_MISSING`, `E_PATH_ACCESS`, `E_NOT_GIT_REPO`, `E_GIT_TIMEOUT`,
  `E_GIT_FAILED` and `E_FETCH_FAILED`.
- Handles a detached HEAD, a missing upstream and a shallow clone.
- For a CLEO root that is not a checkout, it uses the declared
  `.cleo/project-context.json` `evidence.gitRoot`.
- Returns the fresh rows for this device, plus the last recorded rows of other
  devices in `otherDevices`.
