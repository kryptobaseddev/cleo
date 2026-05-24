---
id: t10496-max-n-infra-fault-rows
tasks: [T10496]
kind: docs
summary: add timeout/conduit-drop/validator-OOM rows to cleo-validator Max-N table
---

Adds three infrastructure-fault rows (timeout, conduit-drop, validator-OOM) to the Max-N retry catalogue in `.cleo/skills/cleo-validator/SKILL.md` under SAGA T10377 SG-IVTR-AC-BINDING. Each row specifies retry count, backoff strategy, and transient-vs-permanent classification per Council §3.1 action #6. Companion change to T10495 — additive only, no replacements of existing semantic-fault rows.
