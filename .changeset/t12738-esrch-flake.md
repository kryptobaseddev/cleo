---
id: t12738-esrch-flake
tasks: [T12738]
kind: fix
summary: "cleo-os provider-verification test treats ESRCH like ENOENT when a descendant is reaped between opening and reading /proc/<pid>/stat"
---

The "kills inherited process-group descendants" test read `/proc/<pid>/stat` after the deadline kill and tolerated only ENOENT. A descendant reaped between the open and the read raises ESRCH on Linux, so the test failed intermittently in CI (seen on #1718 and #1731). Both codes mean the process is no longer running.
