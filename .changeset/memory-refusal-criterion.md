---
id: memory-refusal-criterion
tasks: [T14530]
kind: fix
summary: "memory admission names the crossed threshold and admits old swap at normal kernel pressure"
---

The critical-memory veto now requires a kernel warning before treating swap
use of at least 90% of allocated swapfiles as critical. Allocated swap is not
the system's swap limit, and old swapped pages can remain after pressure has
cleared. A normal kernel reading with ample headroom therefore admits new
agent sessions even when those swapfiles are nearly full. Full memory stalls
above 10 and the macOS critical kernel level still refuse admission.

Refusals carry the actual measurement and threshold through the pressure
reading, admission reason, wait notices, timeout and external-pressure remedy.
They identify full stalls, the kernel critical level, warning plus swap use,
or the pressure gate's refuse/resume threshold instead of claiming pressure
zero stayed above 25. Older cached readings without a recorded criterion are
identified explicitly in the external-pressure remedy.
