---
id: t10191-orchestrate-saga-trim
tasks: [T10191]
kind: feat
summary: "remove dead cleo-find fallback from /orchestrate-saga slash command (SAGA T10176)"
---

chore(T10191): remove dead cleo-find fallback from /orchestrate-saga slash command (SAGA T10176)

T10190 confirmed the saga-aware --parent routing already works (T9658 in
packages/core/src/tasks/list.ts:188-281). The defensive last-resort fallback is
dead code — trimmed.
