---
id: t10168-ct-documentor-skill-update
tasks: [T10168]
kind: feat
summary: ct-documentor update vs supersede vs create decision tree
---

Adds canonical decision tree for choosing the right docs verb:
- Same idea, fixing content -> `cleo docs update <slug>` (T10161)
- Replacing whole canonical model -> `cleo docs supersede` (T10162)
- Genuinely new idea -> `cleo docs find --similar` FIRST (T10163)
- Tracing lineage -> `cleo docs graph` (T10164)

Includes 4 worked examples + 3 anti-patterns. Bumps skill version 3.13.0 -> 3.14.0.

Closes T10168
Closes Epic T10157
Saga: T9855
ADR: 078
