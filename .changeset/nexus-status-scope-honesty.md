---
id: nexus-status-scope-honesty
tasks: [T12174]
kind: fix
summary: "`cleo nexus status` refuses a foreign path instead of reporting this project's index under it"
---

**gh#1329.** Measured before the fix:

```
$ cleo nexus status /definitely/not/a/real/repo --json
success=true  indexed=true  nodes=26964
repoPath=/definitely/not/a/real/repo
projectId=L2RlZmluaXRlbHkvbm90L2EvcmVhbC9y
```

A path that does not exist reported **`indexed: true`** with the real project's
full node count, under a `projectId` derived from the bogus path.

**The core was honest; the CLI was not.** `getIndexStats` documents its parameter
as `_projectId` — deliberately unused since ADR-090/T11648, because the graph DB
is project-scoped: one store per project, and `getNexusDb()` opens *this*
project's store. The CLI derived a `projectId` from a user-supplied path, passed
it to a function documented as ignoring it, and then reported that identity
beside counts it did not scope. The underscore was the honest admission sitting
one layer below the surface that lied.

**Why it mattered more than a mislabel.** `CLEO-INJECTION.md` makes this the
mandated **first call** for the whole nexus subsystem, precisely so an agent does
not read `E_NOT_FOUND` as *"no such symbol"* when the truth is a stale or wrong
index. A confident false `yes` here defeats the surface written to prevent that
failure.

A cross-project answer is not available from here, so it now refuses:

| invocation | before | after |
|---|---|---|
| `nexus status /not/a/repo` | `indexed: true`, 26,964 nodes | `E_NEXUS_CROSS_PROJECT_STATUS` |
| `nexus status --output envelope` | queried `<cwd>/envelope` | refused |
| `nexus status` | works | **unchanged** |
| `nexus status <current root>` | works | **unchanged** |

The second row is worth noting: `--output` is not declared on this subcommand,
so citty consumes its *value* positionally. The guard catches that route too, so
the parsing quirk can no longer produce a wrong answer — which is why this change
does not also alter flag handling.

The refusal names the reason and the remedy (`cd <path> && cleo nexus status`)
rather than only rejecting.

95/95 across the nexus suites; typecheck 0.
