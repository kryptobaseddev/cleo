---
id: t10128-animations-render-primitives
tasks: [T10128]
kind: feat
summary: "static UI primitives — Tree, Table, Section, Badge, Legend (B3)"
---

feat(T10128): static UI primitives — Tree, Table, Section, Badge, Legend (B3)

Extends @cleocode/animations with `./render` sub-export shipping 5 pure-string primitives consuming the typed contracts from B1 (T10126) and icon enums from B2 (T10127). All AnimateContext-gated for JSON/quiet/no-TTY/no-color silence parity with existing spinners.

Subtasks: T10142 tree, T10143 table, T10144 section, T10145 badge, T10146 legend.
Closes T10128. Epic: T10114. ADR: adr-077-human-render-contract.
