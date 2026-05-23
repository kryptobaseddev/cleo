---
id: t9549-worktree-lifecycle-spec
tasks: [T9549]
kind: feat
summary: "worktree-lifecycle spec — closes E1 chain (SAGA T10176)"
---

docs(T9549): worktree-lifecycle spec — closes E1 chain (SAGA T10176)

Canonical spec for the CLEO worktree lifecycle: provisioning, classification,
prune, force-unlock, auto-complete. RFC 2119 normative requirements (28 MUST,
4 SHOULD, 2 MAY). Cross-links to ADR-055 (worktree location), ADR-062
(merge --no-ff), ADR-076 (canonical docs SSoT), and implementing PRs (#505,
#512, #523, #527). Adds Definitions section, Adoption Flow section (Claude
Code Agent `isolation:worktree` adoption), and updates epic/saga references
from T9515 → T10192 / T10176. Closes T9549; closes the T10192 E1 5-task
chain.
