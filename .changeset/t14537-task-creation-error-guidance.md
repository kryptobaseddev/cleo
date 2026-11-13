---
id: t14537-task-creation-error-guidance
tasks: [T14537]
kind: fix
summary: Restore hierarchy error fixes and dollar-escaping guidance in the on-demand task-creation protocol
---

Agents loading task-creation with cleo briefing inject receive exit 11 E_DEPTH_EXCEEDED and exit 12 E_SIBLING_LIMIT with recovery guidance, plus shell quoting for literal dollar signs. The always-loaded CLEO-INJECTION.md keeps its size within the 14,600-character cap. A regression checks delivery through readInjectionSection; the ct-cleo pointer, template headers and generated manifest are updated to version 2.27.0.
