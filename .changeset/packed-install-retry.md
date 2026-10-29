---
id: packed-install-retry
tasks: [T14145]
kind: fix
summary: "Packed-install smoke retries npm registry and network faults instead of failing CI"
---

The packed-install smoke failed CI four times on 2026-10-28 on registry
faults (ETARGET, E404, ETIMEDOUT), not on code. Its `npm install` now retries
up to 3 times with backoff on network-class faults (ETIMEDOUT, ECONNRESET,
EAI_AGAIN, ENETUNREACH, an npm E5xx) and on an ETARGET or E404 that names one
of the just-built local tarballs, logging each retry. A fault that persists
fails with its existing classification. A real missing dependency
(ERR_MODULE_NOT_FOUND, or ETARGET/E404 naming any other package) is never
retried.
