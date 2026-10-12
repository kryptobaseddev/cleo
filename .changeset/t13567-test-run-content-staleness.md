---
id: t13567-test-run-content-staleness
tasks: [T13567]
kind: fix
summary: "A test-run or qa-run receipt is no longer stale when an input's mtime is newer but its content is unchanged"
---

Receipt freshness compared mtimes alone. When an integration merge, a checkout or a `touch` rewrote a changed file with identical bytes after the run, the receipt was refused with `E_EVIDENCE_STALE`. A path modified after the run now counts only when its content also differs from what HEAD held when the tests ran (its `git hash-object` against the blob at HEAD as of the run, found in the reflog). An untracked or new path has no blob there and still counts. Any real content change still stales the receipt and names the file. When the reflog does not reach the run, every mtime after it counts, as before.
