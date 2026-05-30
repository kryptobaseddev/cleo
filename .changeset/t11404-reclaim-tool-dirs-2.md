---
id: t11404-reclaim-tool-dirs-2
tasks: [T11404, T11390]
kind: refactor
summary: Reclaim core/src/tools — relocate brain-tools and task-tools dirs to honest core siblings
---

E3 T11404 dir portion (2 of 3). Moves brain-tools + task-tools out of core/src/tools to core/src siblings (decremented escaping imports; fixed sdk cross-refs; barrel repointed). Public API unchanged. sdk/ remains (final T11404 piece). Verified core+cleo build, arch 5/5.
