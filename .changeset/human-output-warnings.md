---
id: human-output-warnings
tasks: [T13987]
kind: fix
summary: "human (terminal) output now shows warnings such as deprecation notices on stderr"
---
Warnings pushed by a command (for example the `W_DEPRECATED_COMMAND` notice on
`cleo conduit *`, `cleo docs supersede` or `cleo docs list-types`) reached only
JSON consumers through `meta.warnings`. In human mode they were never drained,
so a person in a terminal never saw them. They are now printed to stderr as
`warning: <message>` (suppressed by `--quiet`); stdout and JSON output are
unchanged.
