---
id: t10128-animations-render-primitives
tasks: [T10128, T10142, T10143, T10144, T10145, T10146]
kind: feat
summary: "B3 static UI primitives — Tree, Table, Section, Badge, Legend in @cleocode/animations/render"
prs: [549]
---

Extends `@cleocode/animations` with a `./render` sub-export shipping 5
pure-string primitives that consume the typed contracts from B1
(T10126) and icon enums from B2 (T10127). All are gated through
`AnimateContext` for JSON / quiet / no-TTY / NO_COLOR silence parity
with existing spinners.

Subtasks: T10142 (tree), T10143 (table), T10144 (section),
T10145 (badge), T10146 (legend).
