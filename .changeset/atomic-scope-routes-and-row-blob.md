---
id: atomic-scope-routes-and-row-blob
tasks: [T14633]
kind: fix
summary: "orchestrate spawn names routes out of an over-large worker scope that work, does not count test files paired with a source, and docs status shows each ledger row's own blob"
---

- An `E_ATOMICITY_VIOLATION` refusal no longer tells you to add subtasks with a
  plain `cleo add --parent <task>`, which `add` refuses under a task with text
  acceptance criteria. Its fix names three routes that work: narrow `--files`,
  file sibling tasks under the parent epic, or add children with
  `--auto-decompose`. A subtask's refusal leaves the third route out.
- The 3-file worker limit no longer counts a test file (`*.test.*`, `*.spec.*`,
  under `__tests__/`) that pairs with a declared source file by name stem
  (`foo.ts` with `foo.test.ts` or `__tests__/foo.test.ts`), so a one-file fix
  with its tests spawns. Every source file and every unpaired test still counts.
  The refusal states the rule, and `validateSpawnReadiness` applies the same count.
- `cleo docs status` reports `blobSha` as the blob each ledger row published.
  The doc head is now a separate `headBlobSha`, and drift is still judged against it.
  `cleo docs doctor` still holds a prune or archive until a survivor holds both
  the row's blob and the doc head.
