---
id: t13554-evidence-runtime-paths
tasks: [T13554]
kind: feat
summary: "evidence.runtimePaths: tracked files a harness rewrites during a run stay out of the evidence tree hash, so the run cannot stale its own receipt"
---

A goal runtime rewrites tracked files such as `.opencode/goals/*/run.json` and `ledger.jsonl` while a test runs. The evidence tree hash staged those edits, so the test-run receipt went stale with no source change. Declare such files in `.cleo/project-context.json` as `evidence.runtimePaths` (globs). The tree hash then keeps their HEAD content and skips untracked matches, while the files stay tracked for history. `test-run:` and `qa-run:` receipts record which files were left out as `runtimeExcluded`.

The declaration is read from the default branch only, so a change cannot declare its own source as runtime. A glob that matches the project context, a `goal.yaml`, an oracle or a file a typed gate captured as an input is refused with `E_EVIDENCE_RUNTIME_PATH_PROTECTED`, and the declaration is not applied. The default is empty: nothing changes for projects that declare nothing.
