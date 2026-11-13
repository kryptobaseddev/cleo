---
id: t14539-sibling-limit-active-guidance
tasks: [T14539]
kind: fix
summary: "Exit 12 E_SIBLING_LIMIT guidance in task-creation now covers the active-sibling cap and the effective unlimited default"
---

The on-demand task-creation section explains both causes of exit 12: over hierarchy.maxSiblings (group tasks under another parent) and over hierarchy.maxActiveSiblings (complete or cancel an active sibling). It states that 0 means unlimited, the effective default for both caps. A regression pins the active-sibling guidance; ct-cleo, template headers and the generated manifest move to 2.28.0.
