---
id: t13163-changeset-summary-quoting
tasks: [T13163]
kind: fix
summary: cleo changeset add now quotes a summary that is not a plain YAML scalar (colon-space, quotes, backticks, newlines) and parses the rendered file back before writing, so it can no longer write a changeset the changeset lint rejects.
---
