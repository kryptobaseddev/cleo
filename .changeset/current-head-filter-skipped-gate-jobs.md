---
id: current-head-filter-skipped-gate-jobs
tasks: [T14177]
kind: fix
summary: "The current-HEAD ci: stand-in steps past commits whose gate jobs CI's change filter skipped, and names why a run decided nothing"
---

When main's HEAD changes only files CI's change filter ignores (a release workflow, a
changeset), its push run is green with the gate jobs (Unit Tests, Type Check, Scripts
Tests) skipped. The workspace-wide stand-in (T14032) treated that run as undecided.
It then refused the nearest parent because HEAD's change is not documentation, with
"has no completed push run … wait for HEAD's push CI to finish". Waiting could never
help.

- A commit whose required checks are green and whose gate jobs were skipped is CI's own
  verdict that its change is not a test input: a push run's filter diffs against the
  previous head. The walk now steps past such commits to the nearest parent whose run
  executed the gate jobs, even across non-documentation changes.
- A commit that decided nothing for any other reason (a cancelled check or job, or no
  run) still blocks a non-documentation step. The refusal names that commit, why it
  decided nothing, and the route: `tool:test-affected` or a targeted test-run on HEAD.
  "Wait for HEAD's push CI" is kept only when HEAD has no run yet.
- The descendant walk (T12742) names the first later run it passed over for the same
  reason when it finds no stand-in.
