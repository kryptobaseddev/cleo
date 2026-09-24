---
id: identity-doctor
tasks: [T12353]
kind: feat
summary: "`cleo doctor project-identity` reports a missing, conflicting or invalid `.cleo/project-id` with the exact remedy; `--resolve` re-keys a conflict to the tracked id through the alias table, losing no rows"
---

T12325 made CLEO keep the local id and report a conflict when
`project-info.json` and the tracked `.cleo/project-id` disagree. That happens
when two devices each ran `cleo init` before ADR-094. It left no way to see
or fix the conflict outside `cleo init`.

- `cleo doctor` (health) and `cleo doctor --comprehensive` now carry a
  `project_identity` check.
- `cleo doctor project-identity` reports one of these states, each with the
  exact command that fixes it: `ok`, `missing`, `conflict`, `invalid`,
  `info-invalid`, `untracked` (not committed), `ignored` (an old
  `.cleo/.gitignore`), `not-adopted` or `uninitialized`.
- `--resolve --dry-run` prints the plan and writes nothing. `--resolve`
  applies it:
  - **missing:** writes the tracked file from the local id (create-only).
  - **conflict:** one registry transaction renames the row's primary key to
    the tracked id, re-points every alias of the old id, and records the old
    id as an alias. `project-info.json` then takes the tracked id and keeps the
    old one under `previousProjectIds`. The registry row count is unchanged,
    and rows elsewhere that still carry the old id resolve through the alias.
    Re-running after a partial apply completes the remaining steps.
  - **Both ids already own registry rows on this device:** refused with the
    exact `cleo nexus unregister` remedy.
  - **Invalid tracked file:** never regenerated; the remedy is
    `git checkout -- .cleo/project-id`.
