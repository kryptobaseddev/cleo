---
id: t14284-teardown-classes
tasks: [T14284]
kind: fix
summary: "A successful command no longer prints 'teardown did not establish complete resource closure' because a presence ping or hook dispatch was slow: best-effort background work is aborted at teardown instead of holding the databases open"
---

Teardown now has two classes of tracked background work. Local writes (post-commit
graph rows, backups, projections) are drained before any database closes, and a
local write that misses the 2 s deadline still prints the warning. Best-effort
work (the Nexus presence refresh and the PromptSubmit/ResponseComplete hook
dispatch) gets up to 1 s beside that drain, then its request is aborted and
teardown closes every database without waiting for it and without a warning.
The presence refresh's 3 s request timeout used to outlive the 2 s teardown
deadline, which left every database open and printed the closure warning after
a successful command.
