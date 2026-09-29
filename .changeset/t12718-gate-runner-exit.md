---
id: t12718-gate-runner-exit
tasks: [T12718]
kind: fix
summary: Test-gate command strings honour shell quoting, so a quoted `node -e "..."` gate runs the target and cannot false-PASS
---

A typed `test` gate declared as
`node -e "setTimeout(()=>process.exit(1),6000)"` recorded PASS in 46 ms. The
runner split `command` on whitespace and spawned it without a shell, so node
received the double quotes as part of its `-e` source, evaluated a string
literal and exited 0 at once. The process supervisor was correct: it observed
the real exit of the program it was handed. It was handed the wrong program.

`command` is now split with POSIX `sh` quoting (single quotes, double quotes,
backslash escapes). Shell syntax that no shell will interpret — `| & ; < > ( )`,
`$` and backticks — is refused with an error result instead of reaching the
target as literal words, because `echo ok && exit 1` would otherwise run
`echo` and pass. Unterminated quotes are refused too. Unquoted commands split
exactly as before.

Gate cache entries and verification bindings are keyed on the resolved argv,
so a false pass recorded for a quoted command no longer matches the corrected
invocation and is re-run rather than reused.
