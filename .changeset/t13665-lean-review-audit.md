---
id: t13665-lean-review-audit
tasks: [T13665]
kind: feat
summary: ct-lean review and audit workflows on CLEO's code graph (Ponytail parity)
---

ct-lean 1.4.0 replaces its review checklist with two full workflows adapted
from Ponytail 5.1.0's `ponytail-review` and `ponytail-audit` (MIT, notice kept):

- **`references/review.md`** reviews a change. Priorities run correct, safe,
  holds under load, tested, fast, lean. Findings are numbered, each with four
  parts, grouped as Must / Should / Nice, and the review ends with a verdict and
  a `Not checked:` line.
- **`references/audit.md`** audits a whole repo the same way, with at most
  20 ranked findings.

Both stand on CLEO's code graph instead of grep:

- `cleo nexus context` and `impact` give callers and blast radius;
- `cleo nexus diff` finds broken call chains in a PR;
- `cleo map`, `cleo nexus clusters` and `cleo nexus flows` give the survey;
- `cleo nexus status` gives index freshness.

Code counts as unused only with no callers **and** no string or dynamic
reference. Named `shortcut:` markers are decisions (`cleo lean debt`), and
serious findings are filed as tasks.
