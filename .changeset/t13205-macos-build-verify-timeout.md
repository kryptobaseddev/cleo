---
id: t13205-macos-build-verify-timeout
tasks: [T13205]
kind: chore
summary: macOS Build & Verify gets a 20-minute timeout, so a slow cold build no longer cancels the whole PR run
---

`Build & Verify (macos-latest)` builds every package from a cold state, and on macOS runners that build
varies from about 4.5 to more than 8 minutes. Its 10-minute timeout killed 6 of the last 20 macOS runs
(2026-10-04) and cancelled those pull requests' entire CI runs. The same cold build in
`Build (macos-latest)`, which has a 25-minute timeout, had a p95 of 12.5 minutes and a max of 12.6
over its last 20 runs. macOS now gets 20 minutes. Linux, whose run takes about 3.4 minutes, keeps
10. The build stays uncached, because catching dependency-order bugs in a cold build is what the
job is for.
