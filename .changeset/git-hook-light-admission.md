---
id: git-hook-light-admission
tasks: [T14384]
kind: fix
summary: "cleo run admits git checkout, switch, rebase and pull as light jobs when only CLEO's detached NEXUS refresh hooks are installed"
---

Since the NEXUS refresh hooks shipped (T12349), `cleo run -- git checkout`
saw an installed `post-checkout` hook and charged the git command the full
class plan, though the hook only starts a detached refresh. An unmodified
CLEO `post-*` refresh hook with no executable `.cleo-chained` sibling now
reads as no hook for admission, so the git command is charged light. The
refresh itself is still admitted as `cleo run --class scan`. A customized
or chained hook, and CLEO's check hooks, keep the class plan.
