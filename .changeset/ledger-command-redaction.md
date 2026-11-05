---
id: ledger-command-redaction
tasks: [T14208]
kind: fix
summary: "the admission ledger and cleo run records never store or show environment assignments or secrets; existing rows are redacted on read"
---

`cleo doctor tool-locks` showed another project's private key: the
admission ledger stored a waiting run's full command line, beginning with
`env <NAME>_KEY_HEX=<value>`. The redaction keyed on secret-looking names
(`token`, `secret`, `key`, ...) and missed names such as `*_KEY_HEX`, and
the ledger's default command (the process argv) was not redacted at all.

Every environment assignment (`NAME=value` as a prefix or an `env` argument)
is now written as `NAME=<redacted>`, whatever the name, together with the
values of secret-looking flags, URL userinfo and bearer or basic
credentials. The ledger redacts on write, and on read for entries an older
CLEO stored, so the next write persists the redacted form. `cleo run` job
records are redacted the same way when listed. Doctor output and every
deferral read only these redacted forms.
