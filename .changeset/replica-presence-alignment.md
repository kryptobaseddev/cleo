---
id: replica-presence-alignment
tasks: [T12721]
kind: feat
summary: "The fleet view lines up with the cleo-nexus ReplicaPresence contract: the git probe records when HEAD was committed (headCommittedAt, from the same git call that reads the upstream commit), every location carries a replicaId (null until T12675's store-instance id exists), the result carries schemaVersion, device-local fields are marked never-mirrored, and a new pure toReplicaPresence mapper in core/cloud builds the path-free presence body"
---

`nexus_project_git_state` gains `head_committed_at` (additive global
migration `20260929020000_t12721-git-state-head-committed-at`, ISO CHECK,
NULL on existing rows until they are re-probed). The column is classified
`local-only`: the cloud receives it only as `ReplicaPresence.git.lastCommitAt`
through the mapper, never through store sync.

The probe now reads HEAD's committer date and the upstream tracking-ref commit
in ONE `git log --no-walk=unsorted HEAD @{upstream}` call, replacing the
separate `rev-parse @{upstream}`. A repository without an upstream spends one
`git log` call. Dates are normalized to UTC `Z`.

`toReplicaPresence(location, device, { includeBranch })` (core `cloud`):
`dirty` = dirty + untracked > 0; `remote` is `unknown` for a real probe
failure (an offline `--fetch`, `E_FETCH_FAILED`, maps from the last fetch
instead), `no-upstream` without an upstream, `unknown` when the upstream's
tracking ref is gone or git reported no ahead/behind (a remotely deleted,
pruned branch is never `in-sync`), `unknown` when never fetched, otherwise
`diverged` / `ahead` / `behind` / `in-sync` from the last fetch; ahead/behind
default to 0; `observedAt` is the probe instant, and an unparseable instant
throws rather than being sent raw; `cliVersion` is the device's
CLEO version (40 chars max); `branch` is sent only on opt-in (200 chars max).
Path, hostname, remote name and URL, upstream, commit shas and probe error
text never appear in the output.
