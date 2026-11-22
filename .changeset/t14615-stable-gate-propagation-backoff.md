---
id: t14615-stable-gate-propagation-backoff
tasks: [T14615]
kind: fix
summary: "the stable release no longer halts the CLI wave on a transient tarball 404: the dependency gate waits up to 30 min with backoff and logs each attempt"
---

v2026.11.12 halted wave 6 (`@cleocode/cleo`) because `@cleocode/core`'s
tarball was still 404 at the end of the 15 minute dependency wait, although
npm already listed the version; a rerun minutes later passed.

- `scripts/execute-payload.mjs` accepts `POSTDEPLOY_BACKOFF` and
  `POSTDEPLOY_MAX_INTERVAL_MS`, and every attempt it logs names each pending
  package with the rung and status it stalled at (`core (tarball HTTP 404)`).
- The stable dependency gate in `release.yml` waits up to 30 minutes, backing
  off from 15s to 60s between polls; the publish job timeout rises to 195
  minutes to keep its headroom. A tarball that never appears still fails the
  wave and leaves the CLI unpublished.
