---
id: t10127-render-icons
tasks: [T10127]
kind: feat
summary: "B2 typed icon enums — StatusIcon, KindIcon, BadgeIcon, RelationIcon with ASCII fallback"
prs: [543]
---

Codifies emoji symbols hard-coded across 12+ renderer files into typed
enums with NO_COLOR-safe ASCII fallbacks. `pickIcon()` helper honors
`NO_COLOR=1`. Note: `BadgeIcon.ORPHAN='👻'` (changed from ADR-077's
proposed `'🚪'` to avoid a runtime collision with
`StatusIcon.BLOCKED='🚪'` — TypeScript string enums dedupe at runtime).

Foundation for B3 animations primitives + B5 core entry point.
