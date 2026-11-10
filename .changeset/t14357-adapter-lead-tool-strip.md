---
id: t14357-adapter-lead-tool-strip
tasks: [T14357]
kind: feat
summary: "lead spawns lose write and network tools: claude-code passes --disallowedTools without --dangerously-skip-permissions, claude-sdk enforces, other providers refuse with E_LEAD_TOOLS_UNSTRIPPED"
---

A spawn whose context carries leadDeniedTools is a lead spawn under the lead/worker split. Each spawn provider declares leadToolStrip (enforced or unsupported; absent means unsupported). Worker spawns are unchanged.
