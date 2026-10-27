---
id: flag-value-dashes
tasks: [T14044]
kind: fix
summary: "A value beginning with -- passed to a string or positional flag is no longer parsed as an unknown flag"
---

`cleo add --title "--field on ..."` failed `E_UNKNOWN_FLAG` naming the title
text. The unknown-flag guard now skips the value token of a string, enum or
positional flag, and a positional given in flag form (`--title X` or
`--title=X`) is bound by name before the command runs, so a title starting
with `--` is the title rather than a stray boolean flag.
