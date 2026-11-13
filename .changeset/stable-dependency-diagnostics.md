---
id: stable-dependency-diagnostics
tasks: [T14519]
kind: fix
summary: "Stable dependency gate: preserve failed publish timelines and report missing package arguments as usage errors"
---

The stable dependency gate now writes its step-summary timeline before failing,
records the CLI as not attempted and preserves the verifier's exit status.
The job timeout rationale includes the dependency wait, and the workflow
template documents the budget and summary requirements.

Missing `--before-package` values now produce a concise usage error with exit
code 2 instead of an uncaught stack trace.
