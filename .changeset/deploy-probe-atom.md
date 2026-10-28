---
id: deploy-probe-atom
tasks: [T14083]
kind: feat
summary: "New deploy: evidence atom, proven by a CLEO-run probe of the deployment and git containment of the task's commits"
---

Ops-verified work had no evidence atom: a production deploy of the change,
checked live, could only be recorded with an owner override.

`deploy:<provider>/<deploymentId>@<sha>|<probe-url>` records one (decision
D11207). At verify CLEO runs one bounded GET of the probe URL (10 s, first
64 KiB of the body). It must return 2xx and name the deployed SHA in an
`X-Commit` or `X-Version` header or in the body. A probe that names no SHA is
refused with that fix, and a bare 2xx never stands in; a 5xx, a timeout, an
unreachable host or a probe naming another commit is refused too. The atom
records the status, the probe time and a sha256 of the body read.

The deployed SHA must contain the task's implemented commits, as an ancestor
or a patch-equivalent copy (the T13003 rule). `cleo complete` re-checks that
containment and never re-probes.

The atom satisfies only the gates the project lists in the new
`evidence.deploySatisfies` key. There is no default mapping: unset or empty,
`deploy:` is refused and satisfies nothing, and it never stands for
`testsPassed` unless the project lists that gate. Verifying the deployment
with the provider's API is a follow-up (T14091).
