---
id: goal-handoff-status
tasks: [T13821]
kind: feat
summary: "cleo go hands the ready wave to CLEO Goal; cleo goal status reads the live run through cleo-goal status --json; the Stop tick resolves cleo-goal, then ocg"
---

CLEO Goal (`@cleocode/goal`, bin `cleo-goal`, alias `ocg` for "open cleo
goal") is the goal runtime (ADR-097).

- **`cleo go`** is repurposed. For implementation-stage work it drafts a
  goal/v1 contract for the active saga's ready wave, reusing an existing draft
  and never overwriting it, and returns `goalHandoff`:
  - when the CLEO Goal bin resolves (`cleo-goal`, then `ocg`), the next step is
    `/goal start <slug>`;
  - otherwise it returns the install commands (`npm i -g @cleocode/goal@latest`,
    `cleo goal install --harness opencode`), which write only the project's
    harness config. It installs nothing itself.

  Its IVTR cantbook fan-out (`ivtrFanOut`, the injected runner,
  `CLEO_GO_VIA_PLAYBOOK`) is removed.
- **`cleo goal status [--task T123]`** lists the drafted goals and the CLEO
  tasks each serves (from `goal.yaml`). It reads the live run only through
  `cleo-goal status --json` and refuses a schema version it does not recognise.
  With no bin it reports `not-installed` with the install commands. It never
  reads runtime-internal files such as `run.json`.
- **The Stop dispatcher's tick** is `<cleo-goal|ocg> tick`, resolved by the
  shared CLEO Goal bin resolver. With no bin there is no tick.
  `CLEO_GOAL_TICK_COMMAND` still overrides it.
