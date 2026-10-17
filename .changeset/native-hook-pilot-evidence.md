---
id: native-hook-pilot-evidence
tasks: [T13818]
kind: fix
summary: Require retained native agent receipts and explicit trust, context and fault metadata for future hook promotions
---

Hook pilot proof version 2 records a native session window and a hash-bound
agent receipt separately from ordinary commands and Git pushes. The promotion
gate validates the retained receipt's source, event and timestamp, and requires
persisted native hook trust. Bypass runs remain representable as diagnostics.
Context injection and infrastructure fault reporting are explicit rather than
inferred from a successful push. Historical version 1 evidence remains valid
for stable targets through 2026.10.17; later promotions require version 2.

The runner retains a bounded, redacted snapshot per source/event alongside the
compatible overall last result. A Git push no longer overwrites the native
agent receipt. Native trust can be granted by the harness's own interactive
flow or trust command in an isolated home; hand-seeded trust and bypass flags
do not satisfy promotion. Observed context requires retained evidence, and
new Codex proofs must cover a linked worktree.
