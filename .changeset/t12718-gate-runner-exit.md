---
id: t12718-gate-runner-exit
tasks: [T12718]
kind: fix
summary: Test-gate commands and the tool:test / tool:test-affected commands honour shell quoting and refuse shell syntax, so neither can false-PASS
---

A typed `test` gate declared as
`node -e "setTimeout(()=>process.exit(1),6000)"` recorded PASS in 46 ms. The
runner split `command` on whitespace and spawned it without a shell, so node
received the double quotes as part of its `-e` source, evaluated a string
literal and exited 0 at once. The process supervisor was correct: it observed
the real exit of the program it was handed. It was handed the wrong program.

`command` is now split with POSIX `sh` quoting (single quotes, double quotes,
backslash escapes, backslash-newline continuations). Shell syntax that no shell
will interpret — `| & ; < > ( )`, `$`, backticks, a `#` comment or `~` at the
start of a word, and a leading `NAME=value` assignment — is refused instead of
reaching the target as literal words, because `echo ok && exit 1` would
otherwise run `echo` and pass. Unterminated quotes are refused too. Unquoted
commands split exactly as before. A refused gate records its own `error`
result; the other gates in the same `cleo verify` run still execute and record.

The same false-PASS existed on the evidence path. `tool:test` split
`testing.command` from `.cleo/project-context.json` on whitespace, so
`pnpm build && pnpm test` ran `pnpm build` and could record `tool:test`;
`tool:test-affected` did the same with `testing.affectedCommand`. Both now use
the same splitter, and a command with shell syntax is refused as
`E_EVIDENCE_TOOL_UNAVAILABLE` with a message naming the field and the fix
(`sh -c '<script>'` or a script file). `{projects}`, `{filters}` and
`{packages}` placeholders still expand. Generated workflow `run:` steps, which
are a shell, render such a declared command verbatim and re-quote quoted words.

Gate cache entries and verification bindings are keyed on the resolved argv,
so a false pass recorded for a quoted command no longer matches the corrected
invocation and is re-run rather than reused.
