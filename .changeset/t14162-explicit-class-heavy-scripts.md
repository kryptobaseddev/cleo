---
id: t14162-explicit-class-heavy-scripts
tasks: [T14162]
kind: fix
summary: "cleo run charges an explicit --class build its plan until a measurement lowers it, honours project-declared heavy scripts, and raises a command's charge after one run over it"
---

axiom-qa saw `cleo run --class build -- node scripts/audit/emit-route-guards.cjs`
charged 1.0 GiB ("runs no heavy tool") while the script spawned a
full-program typecheck.

- **Explicit class.** With an explicit `--class build`, a script the guess
  calls light is charged its class plan until three measured runs lower it to
  its peak plus 25%. A guess never lowers an explicit class. Without `--class`,
  the guess applies as before. Kodo's python check (T14079) is charged the plan
  for its first three runs, then about 1 GiB.
- **Declared heavy scripts.** `build.heavyScripts` in
  `.cleo/project-context.json` lists globs, relative to the project root, of
  scripts charged as heavy.
- **Measured peaks raise the charge.** Every script run is measured, light ones
  included. A run whose peak exceeds its charge is reported ("measured peak X
  exceeded its Y charge…") and recorded even on a non-zero exit. The next run
  of the command is charged that peak plus 25%. Raising needs one run; lowering
  still needs three.
