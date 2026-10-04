---
id: t13136-t13140-review-lows
tasks: [T13136, T13140]
kind: fix
summary: test-run evidence refuses a non-zero exitCode next to exit 0; the release preflight walk counts a rename's old path
---

- `test-run:` reports: when both `exit` and `exitCode` are present, both are checked, and either one
  being non-zero (or not a number) refuses the report. `{"exit":0,"exitCode":1}` was accepted.
- `cleo release open`'s preflight walk lists a renamed file's old path as well as its new one, so a
  code file renamed into `.changeset/` no longer makes a commit look like a release-plan commit.
