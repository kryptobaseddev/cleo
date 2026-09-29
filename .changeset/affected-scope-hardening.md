---
id: affected-scope-hardening
tasks: [T12656, T12657]
kind: fix
summary: "`cleo complete` refuses a testsPassed backed only by tool:test-affected once the change has merged; the affected-scope diff and resolver fail closed"
---
- **Complete after merge (T12656).** A scoped run counts before merge only
  (D11150). Until now only `cleo done` planning applied that rule; `cleo complete`
  trusted the stored `tool:test-affected` atom. The rule now lives in one shared
  function, `affectedScopeSupersededReason`, which both commands use. When
  testsPassed rests only on an affected run, `cleo complete` refuses unless the
  gate also holds `ci:<pr>` or `tool:test`. It treats the change as merged when
  the task has a recorded `pr:` implemented atom, or when its derived change set
  is a merged PR. If the merged-PR lookup fails, the merge state is unknown and
  completion is refused (fail closed). Ordinary completions skip the lookup.
  - What the PR lookup found decides the merge state (the new `mergeState` on
    the change set), never `source`. A merged PR whose `pr:` check was refused,
    for example because its CI failed, still falls back to the task branch,
    which outlives a squash merge. Before this fix that read as unmerged.
  - An unknown merge state plans the full `tool:test`, not a scoped run. The
    refusal says gh was unreachable, names `gh auth status`, and says to retry
    or record `tool:test`.
  - `gh` queries on this path time out after 30s. A timeout counts as a failed
    discovery.
- **Diff (T12657).** A git failure while diffing against origin's default
  branch now refuses the affected scope instead of reading as an empty diff.
  Untracked files count as changes. Paths with Windows `\` separators map to
  their packages.
- **Resolver (T12657).** Vitest project resolution runs asynchronously under the
  heavy-tool `test` semaphore and is memoized per tree state. The state is
  HEAD, the tracked diff, and each untracked file's size and mtime. `cleo done`
  planning and recording therefore resolve once. `cleo done --plan` never
  waits for the slot: while it is held, the plan reports
  `scope pending: test slot busy`. `cleo done` itself queues, because it runs
  the tests next.
- **`{filters}`/`{packages}` (T12657).** These templates now refuse the scope
  when a directly changed package has no `scripts.test`. Dependents with none
  are recorded in `untestedPackages`.
