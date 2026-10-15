---
id: evidence-raw-git-bytes
tasks: [T13738]
kind: fix
summary: File evidence read from git hashes the raw blob bytes, so non-ASCII files get correct sha256
---

When a `files:` atom was resolved from git (a sibling `commit:` or `pr:`
anchor, or the task-branch fallback), the git output was decoded as UTF-8 and
re-encoded with `Buffer.from(s, 'binary')`, which keeps only the low byte of
each character. Every file with a non-ASCII or invalid-UTF-8 byte got a wrong
sha256; ASCII files were unaffected. The git readers now keep stdout as raw
bytes.

Existing receipts: a `files:` hash recorded by an affected build no longer
matches at `cleo complete`, because file hashes are re-read and compared on
every completion and are never cached. The failure names T13738 and says the
file is unchanged; re-running `cleo verify` with the same evidence records the
correct hash. The old hash is never accepted.
