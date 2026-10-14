---
id: t13424-ct-lean-privacy
tasks: [T13424]
kind: fix
summary: ct-lean 1.0.1 names privacy in its never-cut list and fixes small in-scope risks instead of only reporting them
---

The T13424 benchmark (ct-lean vs the Ponytail plugin vs no skill; research doc
`t13424-ct-lean-vs-ponytail-benchmark`) found ct-lean on par with Ponytail on
size and cost, but in one cell it put every digest subscriber in `To:`. It
flagged the privacy risk without fixing it, so a hidden check failed.

ct-lean 1.0.1 adds privacy (with the BCC example) to the never-cut list, and a
rule that a risk the change creates is part of the change: fix it when the fix
is small and in scope, and report only what cannot be fixed. The spawn-prompt
lean line gains "privacy". In a re-run, the failing task passed 3/3 with
smaller code.
