---
id: doctor-coherence-integrity
tasks: [T12883]
kind: fix
summary: "cleo doctor --coherence reports existing integrity violations (T12883)"
---

`cleo doctor --coherence` (`check.coherence`) now reports the existing rows that
break the rules the T12883 writers enforce: a cancelled or done parent over a
live child now includes `blocked` children (`status_inconsistency`); a done
task whose acceptance criteria have no evidence (`done_without_ac_evidence`,
a warning, since tasks completed before the coverage gate predate it); and a
child whose parent's type cannot contain it under the type matrix
(`type_matrix_violation`). A pipeline stage that moved backwards leaves no trace
in the current rows, so it is refused at write time instead.
