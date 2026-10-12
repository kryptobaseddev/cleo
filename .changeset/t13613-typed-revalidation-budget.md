---
id: t13613-typed-revalidation-budget
tasks: [T13613]
kind: fix
summary: "cleo complete no longer fails 'Shared operation deadline reached' on a typed task"
---

Completing a task with typed acceptance gates re-checks the gates' inputs
under a deadline. That deadline was two seconds from the start of `cleo
complete`, so slow earlier checks (merged-PR lookups through `gh`, the
write lock) used it up and the command failed with `E_INTERNAL` "Shared
operation deadline reached" although every gate had passed. The re-check now
gets its own budget, starting when it starts and sized like the verification
that produced the result. Each task is re-checked once per completion instead
of twice, and a re-check that runs out of time names the task and suggests a
fix instead of `E_INTERNAL`.
