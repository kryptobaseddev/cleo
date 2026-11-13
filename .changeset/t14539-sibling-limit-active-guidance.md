---
id: t14539-sibling-limit-active-guidance
tasks: [T14539]
kind: fix
summary: "Exit 12 E_SIBLING_LIMIT guidance in task-creation now covers the active-sibling cap and per-profile defaults"
---

The on-demand task-creation section explains both causes of exit 12: over hierarchy.maxSiblings (group tasks under another parent) and over hierarchy.maxActiveSiblings (complete or cancel an active sibling). It states the defaults per enforcement profile (llm-agent-first 0/0, human-cognitive 7/3) instead of a single default. A regression pins the active-sibling guidance; ct-cleo, template headers and the generated manifest move to 2.28.0.
