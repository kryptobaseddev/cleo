---
id: ci-event-job-requirements
tasks: [T14577, T14579]
kind: fix
summary: "CI evidence: support separate PR/main jobs and GitHub matrix job names"
---

Projects with different PR and main job names can configure
`evidence.ciChecks.jobs.tests` and `qa` as `{pullRequest: [...], push: [...]}`.
Both event-specific lists must pass, even when main advanced before the PR
merged; a permitted descendant uses the push list. Existing arrays retain
their meaning, workflow edits remain main-only, and job refusals name the
configuration key to correct. The evidence planner and project-context
schema accept the new form.

An exact reported job name keeps its meaning; when it is absent, a bare
configured name matches GitHub's appended matrix values and requires every
reported leg to pass. Wildcards retain direct matching, names imply no
numeric cardinality, and an explicitly required missing leg still refuses.
Unmatched globs list the closest check names observed in the pinned workflows.
Tree-equal PR heads cannot mask an unmet push side: a cancelled merge run
uses the descendant search, and a pending run retains wait guidance.
