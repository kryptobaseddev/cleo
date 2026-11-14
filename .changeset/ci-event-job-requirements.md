---
id: ci-event-job-requirements
tasks: [T14577]
kind: fix
summary: "CI evidence: support separate PR-head and main push job requirements"
---

Projects with different PR and main job names can configure
`evidence.ciChecks.jobs.tests` and `qa` as `{pullRequest: [...], push: [...]}`.
Both event-specific lists must pass, even when main advanced before the PR
merged; a permitted descendant uses the push list. Existing arrays retain
their meaning, workflow edits remain main-only, and job refusals name the
configuration key to correct. The evidence planner and project-context
schema accept the new form.
