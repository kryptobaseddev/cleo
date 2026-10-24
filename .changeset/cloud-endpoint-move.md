---
id: cloud-endpoint-move
tasks: [T13983]
kind: refactor
summary: "the cloud endpoint gate moves to @cleocode/core/cloud/cloud-endpoint; cleo agent start, work and watch are deprecated with the other conduit verbs"
---
Conduit retirement 3c (epic T13933).

- `cloud-endpoint.ts`, the gate every agent-registry cloud call and the CLI's
  retired-host `fetch` backstop go through, moves from `core/src/conduit/` to
  `core/src/cloud/`, so it survives the conduit removal. Every caller now
  imports the new path; `@cleocode/core/conduit/cloud-endpoint` re-exports it
  for one release (deprecated, listed in STABILITY.md).
- `cleo agent start`, `cleo agent work` and `cleo agent watch` run the conduit
  message poller, so they carry the same `W_DEPRECATED_COMMAND` warning as the
  other conduit verbs. They keep working; the poller goes with the conduit
  removal (T13955).
