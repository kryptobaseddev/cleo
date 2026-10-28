---
id: pr-hunks-stand-in
tasks: [T14119]
kind: fix
summary: "a later main run stands in for a merged PR's ci: evidence while every hunk the PR added is still present, even after later merges edited the same files"
---

The `ci:` descendant stand-in (T12742) refused whenever any later commit
touched one of the PR's files, so a merge whose own CI was superseded could
never close once a neighbouring PR edited the same file. It now checks each
hunk the PR added (`git diff -U0 <merge>^1 <merge>`) against the file at the
later commit: while every one is still there, contiguous and in order, the
later green run stands in. A hunk that was rewritten or removed refuses, and
the refusal names it, as in `hunk a.ts @@ -4,0 +6 @@ ("added B") was
rewritten or removed`, with the route.

The hint that offers a targeted test-run after red merged CI now states the
same coverage the test-run validator enforces: every affected package that
has tests, the set `tool:test-affected` runs.
