---
id: t14630-rc-gate-propagation-backoff
tasks: [T14630]
kind: fix
summary: "the release candidate gate waits out a ~20 min tarball propagation lag with the same 30 min backoff budget as the stable gate, and execute-payload refuses a poll setting that would spin"
---

- `release.yml` defines the blocking registry-gate budget once
  (`BLOCKING_GATE_BUDGET`: 30 min, backing off 15s to 60s) and both the stable
  dependency gate and the release candidate gate use it. The candidate gate
  previously had a fixed 15 minute budget at a fixed interval, so the ~20
  minute lag seen in v2026.11.12 failed the release job. The publish job
  timeout rises from 195 to 210 minutes to keep its headroom.
- `scripts/execute-payload.mjs` exits 2 with a clear error when
  `POSTDEPLOY_BACKOFF` is below 1 or not a number, or when
  `POSTDEPLOY_MAX_INTERVAL_MS`, `POSTDEPLOY_INTERVAL_MS` or
  `POSTDEPLOY_TIMEOUT_MS` is empty, not positive or not a number. Those values
  used to reach the poll loop as a zero or NaN wait and make it spin.
