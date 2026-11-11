---
id: orca-report-history
tasks: [T14501]
kind: fix
summary: "Orca reports: find older worker results and preserve source diagnostics"
---

Find exact worker_done message ids by widening read-only Run inbox windows beyond
200 messages, up to 12,800 rows. Reaching the bound reports incomplete history
instead of claiming the message is absent. Unrelated malformed rows no longer
deny a valid report, while the selected row and payload remain strictly checked.
Source refusals retain subprocess exit status, stderr and parse issues. Completed
report manifests may link the assigned task anywhere in linked_tasks.
