---
id: no-rcasd-stubs
tasks: [T14277]
kind: fix
summary: "Lifecycle stage records write no file: no more .cleo/rcasd placeholder stubs, and new rcasd files stay ignored"
---

Every lifecycle stage transition wrote a placeholder
`.cleo/rcasd/<epic>/<stage>/<epic>-<stage>.md`, and `.cleo/.gitignore`
un-ignored `rcasd/**`, so each transition left an untracked file in
`git status`. The store already records the stage.

`recordStageProgress` now writes an artifact only when the caller passes its
real content (`artifactContent`); a transition alone records the stage row and
writes nothing. `ensureStageArtifact` takes the content and no longer
generates a placeholder. The `.cleo/.gitignore` template (and its embedded
fallback) no longer un-ignores `rcasd/`: new files there stay ignored, and the
legacy files git already tracks stay tracked.
