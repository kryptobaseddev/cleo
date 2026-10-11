---
id: t13552-open-joiner-deadline
tasks: [T13552]
kind: fix
summary: "A store open no longer fails with another operation's expired deadline"
---

When two callers opened the same store at once, the second joined the first's
in-flight open. If the first ran inside an operation with a short deadline
(the 2 s project-encounter registration, for one) and that deadline expired
during the cold open, the second caller failed too, with "Shared operation
deadline reached", although it had no deadline of its own. The runtime now
gives such a caller its own attempt, as the lower-level opener already did.
