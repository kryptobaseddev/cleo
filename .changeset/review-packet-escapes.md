---
id: review-packet-escapes
tasks: [T14328]
kind: fix
summary: "cleo review packet reads a diff carrying terminal escapes, never prints a raw escape byte, and reports gh's own error"
---

`gh pr diff` refuses to print terminal escape sequences unless asked, so a PR
whose diff carries them (CI log fixtures with ANSI colour) gave an empty
diff and `cleo review packet` reported only "could not be read with gh". The
packet now reads the diff verbatim (`--color never --allow-escape-sequences`)
and writes each raw ESC byte as the visible text `\x1b`, so nothing it prints
can drive a terminal and one head still yields one packet sha. A `gh` failure
now carries gh's own stderr in the error.
