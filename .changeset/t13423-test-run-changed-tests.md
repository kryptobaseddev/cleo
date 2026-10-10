---
id: t13423-test-run-changed-tests
tasks: [T13423]
kind: fix
summary: a test-run report binds only when it passed every test file the change adds or edits, and a source-only change to a tested package (workspace or standalone) needs tool:test-affected, tool:test or ci:<pr>
---

Policy change, applied to workspace packages and single-package projects
alike. A targeted `test-run:` report used to stand for a changed package when
it passed any one test file of that package. That says nothing about a change
to the package's source.

- The report must pass every test file the change adds or edits.
- Each directly changed package that has tests must have one of those changed
  test files. A source-only change to a tested package binds no `test-run:`;
  record `tool:test-affected`, `tool:test`, or `ci:<pr>` once the PR merges.
- Dependent packages still need one passing test file each, as before.
