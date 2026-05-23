---
"@cleocode/contracts": minor
---

feat(T10127): typed icon enums (B2) — StatusIcon, KindIcon, BadgeIcon, RelationIcon with ASCII fallback

Single source of truth for the visual language used across renderers. Each enum exposes `ascii()` for NO_COLOR / non-UTF8 terminals. Part of Epic T10114, ADR-077.

ADR deviation: `BadgeIcon.ORPHAN` ships as `'👻'` (not `'🚪'` as ADR-077 §2 originally specified) because TypeScript string enums share runtime values and `StatusIcon.BLOCKED` already owns `'🚪'`. ADR amendment lands in T10137 (B12).

Closes T10127. Epic: T10114. ADR: adr-077-human-render-contract.
