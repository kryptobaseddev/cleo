---
id: stage-gate-opt-in
tasks: [T13970]
kind: fix
summary: "the parent-epic stage gate is opt-in (lifecycle.stageGate, default off), so strict projects no longer strand an epic's children"
---
With `lifecycle.mode` strict (the default when unset), three checks combined
into a deadlock: a child could not complete while its parent epic sat in a
planning stage, the epic could not advance while children sat at its stage,
and children could not pass the epic's stage (T13969). An epic with no parent
starts at research, so its children could never complete.

These three checks now read a separate key, `lifecycle.stageGate`
(`off` | `advisory` | `strict`), which defaults to `off`. `lifecycle.mode`
keeps everything else, including evidence re-validation and the epic
creation rules. To keep the old behaviour, run
`cleo config set lifecycle.stageGate strict`.

ct-orchestrator 4.1.1 and ct-cleo 2.24.19 (planning-loop.md, CLEO-INJECTION.md
exit 80 row) describe the opt-in stage gate.
