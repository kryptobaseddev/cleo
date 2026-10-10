---
id: ci-blobless-checkouts
tasks: [T13310]
kind: fix
summary: CI full-history checkouts are blobless with 5-minute timeouts; gate 36 fails loudly without a merge-base
---

Several 2-minute lint jobs cloned the whole history (`fetch-depth: 0`, about
160 MB). Under runner contention the checkout alone took about 2.5 minutes,
and the jobs were cancelled. The `ci` aggregate counts a cancelled job as a
failure, so approved PRs went red. This hit #1939 twice, plus #1942, #1947
and #1948.

**What changed:**

- Every PR-gating job that clones the full history now checks out with
  `filter: blob:none` (about 60 MB). That covers:
  - the ADR index frozen lint;
  - the worktree, orphan `.cleo/`, agent-outputs and SSoT-exempt lints;
  - docs similarity;
  - the manual-write sweep;
  - the canon check;
  - the skills metadata gates;
  - gate 36's job;
  - the identity-pollution check.
- Those jobs read names, logs, trees and a handful of blobs. Git fetches any
  blob a script needs on demand. Each history-reading script was run in a
  blobless clone and passed, and the pack grew by under 0.1 MB.
- The 2- and 3-minute lint jobs among them now have a 5-minute limit.
- Gate 36's job no longer runs `fetch --depth=1` for gate 37. That fetch made
  the clone shallow again.
- Gate 36 rule 7 now fails, naming the fetch that fixes it, when no merge-base
  of HEAD and the base can be found. It used to fall back to the base tip.
