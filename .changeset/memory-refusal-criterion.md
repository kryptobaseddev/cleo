---
id: memory-refusal-criterion
tasks: [T14530]
kind: fix
summary: "memory admission names the crossed threshold and admits old swap at normal kernel pressure"
---

Swap use of at least 90% of allocated swapfiles remains critical unless the
kernel reports normal pressure AND measured reclaimable memory (or available
memory when reclaimable is unreadable) reaches the backend's shared headroom
floor: a quarter of RAM, at least one 6 GiB worker and never more than half of
RAM. The refusal names the measured headroom and threshold. Normal pressure
with exhausted or unknown headroom still refuses, as does an unknown kernel
level even with ample headroom. Full memory stalls above 10 and the macOS
critical kernel level still refuse admission.

Refusals carry the actual measurement and threshold through the pressure
reading, admission reason, wait notices, timeout and external-pressure remedy.
The pressure gate names its own crossed refuse/resume threshold only when it
refuses; the agent-session veto carries its independent critical criterion.
Neither claims pressure zero stayed above 25. Older cached readings without
a recorded criterion are identified explicitly in the external-pressure remedy.
