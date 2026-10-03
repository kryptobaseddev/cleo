---
id: t13102-guided-first-run
tasks: [T13102]
kind: feat
summary: cleo login nexus links and backs up the current project, lists your projects on a new machine, and cleo cloud restore takes a project name
---

`cleo login nexus` now finishes the setup in one step (onboarding D, owner decision 2026-10-02):

- Inside a CLEO project this machine has not linked, login offers to link it and take its first
  encrypted backup, then reports "Signed in, linked, backed up". It links through `cleo project link`'s
  own path and backs up with `cleo cloud push`. `--yes` does both without asking, and a terminal is
  asked (default yes). A non-interactive run, such as an agent's, never asks: it prints the exact next
  command (`cleo project link && cleo cloud push`) on stderr and in `data.firstRun.nextCommand`.
- Outside a CLEO project, login lists the account's projects by name, each with the exact
  `cleo cloud restore <name>` command when it has a backup this machine does not hold yet. A project
  name stored encrypted (`encryptedName`) is opened with the account key. The key is unlocked read-only,
  so nothing is minted or written. A name that cannot be opened falls back to the label, with a warning.
- A read-only device, or `CLEO_NEXUS_DEVICE=0`, skips both. A first-run problem never fails the sign-in;
  it becomes a warning with its remedy.

`cleo cloud restore <name>` (also `--project <name>`) accepts a project name or label as well as its id.
A name matches exactly first, then without regard to case. A name several projects share is refused
with `E_NEXUS_PROJECT_AMBIGUOUS` (exit 6), and every candidate, with its by-id restore command, is
listed in `error.details`. A name no project has is `E_NEXUS_PROJECT_NOT_FOUND` (exit 4). A UUID is
used as the id directly. Names from the server are printed with control and bidi-override characters
removed.
