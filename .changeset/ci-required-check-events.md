---
id: ci-required-check-events
tasks: [T14602]
kind: fix
summary: "ci: judge PR-only and main-only required checks on their declared events"
---

Required-check entries accept an optional `event: pull_request` or `event: push`.
CI evidence requires the final PR head's PR checks and the merge or qualifying
descendant's push checks to succeed, including merges after main advanced.
Unscoped entries keep their existing behavior; workflow edits remain main-only.
PR provenance and merge-train checks use the PR entries, while release selection
uses the push entries. Cancelled merge CI still needs a qualifying descendant.
