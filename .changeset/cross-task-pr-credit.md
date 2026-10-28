---
id: cross-task-pr-credit
tasks: [T14094]
kind: fix
summary: "pr: and ci: can credit a task with another task's merged PR through the criteria the write names, when those criteria name the files the PR changed"
---

Work that shipped under another task's PR (escapeplan T622 under T680's
PR #59) could only be closed with an owner override: `pr:`/`ci:` refused any
PR that neither cited the task nor touched its declared files. A task with no
declared files can now record that PR when the same write names
`satisfies:<task>#AC<n>` for the criteria it delivers. Each named criterion
must name at least one repo path, the PR must have changed every one of them,
and none may have been written or edited after the PR merged. Only the named
criteria are linked. With no criterion named, the refusal names that one
route, and for a task another task fully covers, `cleo cancel <id> --reason
"covered by T…"` with `cleo relates add <id> T… duplicates`. Declared files
keep the existing must-intersect rule.
