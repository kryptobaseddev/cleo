---
id: t14282-external-pressure-verdict
tasks: [T14282]
kind: fix
summary: "A queued run held by memory pressure from programs outside CLEO now ends with E_RESOURCE_EXTERNAL_PRESSURE naming those programs, and no admission message advertises turning admission off"
---

`cleo run --wait` and queued `cleo verify` evidence runs no longer wait out
their whole timeout while another program holds the memory. Once the memory
gate has refused above its refuse line for two notice intervals while CLEO
itself holds nothing, the wait ends with `E_RESOURCE_EXTERNAL_PRESSURE` (exit
75, nothing started). Its details list the largest memory users outside CLEO
with their memory in bytes (`topProcesses`), `expectedAdmitAt: null`, and a fix
that says to report or quit those programs.

Waiting lines, deferrals and admission timeouts no longer tell agents to set
`CLEO_RESOURCES_MODE=off`, and `CLEO_ADMISSION_PRESSURE=off` is removed. The
test suite now feeds admission a fixed sample through
`CLEO_RESOURCE_SAMPLE_FILE`, which is honoured only below the test sandbox
marker and ignored, with one stderr line, anywhere else.
