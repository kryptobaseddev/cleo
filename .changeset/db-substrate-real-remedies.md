---
id: db-substrate-real-remedies
tasks: [T14395]
kind: fix
summary: "cleo doctor db-substrate no longer suggests commands that do not exist for its cross-DB invariants I1 to I4"
---

The four suggested fixes named verbs and flags the CLI never had
(`cleo nexus reset-project-id`, `cleo memory observe --task`,
`cleo docs prune --remove-orphan-blobs`, `cleo session start --link-task`).

- I1 (memory link to a missing task) now names `cleo brain maintenance`, whose
  reconciliation step removes those links.
- I3 (registry path differs from the project root) reads the retired
  `<cleoHome>/nexus.db`, not the live registry in the global `cleo.db`. Its fix
  now says so and names `cleo doctor exodus-residue --fix`, which archives that
  file once the global migration is complete. A test runs that remedy and
  re-checks I3. Moving I3 to the live registry is T14482.
- I2 (blob attachment for a missing task) and I4 (llmtxt row for a missing
  session) have no repair verb, and the text now says so, as I5 already did.
- A test checks every command `db-substrate.ts` names against the command
  manifest, with its flags.
