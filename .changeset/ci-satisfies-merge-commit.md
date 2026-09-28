---
id: ci-satisfies-merge-commit
tasks: [T12634]
kind: feat
summary: "New `ci:<pr>` evidence atom: required CI green on a merged PR's merge commit satisfies testsPassed and qaPassed when the project sets `evidence.ciSatisfies` (on for cleocode)"
---
Owner decision D11149.

- `ci:<pr>` is valid for `testsPassed` and `qaPassed`, and for no other gate.
  `resolveCiEvidenceAtom` (core `release/ci-evidence.ts`) first verifies the PR
  through the existing `pr:` provenance code. It then takes the required-check list
  from the same resolver: env, then `release.prRequiredWorkflows`, then branch
  protection. An undetermined list refuses.
- Each required name is judged on the merge commit's own check runs and workflow
  runs, by SHA. Only the latest attempt counts. A run on any other SHA, including
  the PR head, never counts.
- Pending, failed, cancelled, skipped and missing required checks are each refused,
  and the refusal names the check and its state.
- It is off by default. Only `"evidence": { "ciSatisfies": true }` in
  `.cleo/project-context.json` enables it. It is enabled for cleocode.
- `cleo done` / `--plan`: when the change set is a merged PR that is not stacked,
  and the project has opted in, testsPassed and qaPassed plan `ci:<pr>` and no
  local tool run. This removes the post-merge full-suite rerun.
- A `ci:` atom counts as an actual verification result for code tasks. At complete
  time it is trusted as captured, like `pr:`.
- Tree-equal PR runs: when the final PR head's tree is identical to the merge
  commit's tree (`git rev-parse <sha>^{tree}`), a required check that succeeded
  on the PR head counts, so a push run on `main` that was cancelled or never
  started does not block. GitHub deletes `refs/pull/<n>/merge` once a PR merges,
  so the PR head stands in for the final test-merge commit. When the trees
  differ, or either tree is unknown locally, only merge-commit checks count.
  The atom records the SHA each check was judged on (`checks[].sha`) and the
  tested tree (`testedTree`).
