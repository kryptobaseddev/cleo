---
id: t13600-triage-graph-writer
tasks: [T13600]
kind: fix
summary: "docs triage --record's doc link always has both graph nodes"
---

The decision-to-doc link that `cleo docs triage --record` writes now goes
through the shared graph writer with an explicit option that bypasses the
automatic-capture setting, and both ends of the link (the decision node and
the doc's `llmtxt:<sha256>` node) are created when absent, so the link never
points at a node that does not exist. An existing node is left unchanged.
