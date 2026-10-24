---
id: human-warnings-all-paths
tasks: [T13991]
kind: fix
summary: "terminal output shows pushed warnings on failing commands and --field results too"
---
Follows T13987. In human (terminal) mode, warnings pushed by a command now
also print when the command fails (`cliError`) and when `--field` returns a
single value; both paths returned before the warnings were drained. All three
human paths print through `humanWarn` (`warning: <message>` on stderr,
silent under `--quiet`); JSON output is unchanged.

Terminals now show notices from every `pushWarning` caller, not only the
conduit deprecations: for example `cleo doctor`, `cleo graph`, `cleo init`,
`cleo llm`, `cleo briefing` and `cleo docs` commands that push warnings.
