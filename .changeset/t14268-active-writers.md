---
id: t14268-active-writers
tasks: [T14268]
kind: feat
summary: "update --status active takes the claim lease as cleo start does; Studio no longer writes active"
---

The write side of retiring stored `active` (D11230).

- `cleo update <id> --status active` writes the other fields, then takes the
  bound session's claim lease (`cleo start`). An unbound caller is refused
  with `E_SESSION_UNBOUND`.
- Studio: the Running lane is computed from the lease. Dropping a card on it
  is refused with a `cleo start` hint, and the task PATCH endpoint no longer
  accepts `active`.
