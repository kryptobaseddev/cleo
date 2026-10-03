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
  asked (default yes) only when both stdin and stderr are terminals and `CI` is unset. Any other run,
  such as an agent's, never asks: it prints the exact next command (`cleo project link && cleo cloud
  push`) on stderr and in `data.firstRun.nextCommand`.
- Inside an unlinked project that Cleo Nexus already backs up from another device, and that this copy
  never synced (a fresh git clone on a new machine, since the project id is tracked), a backup would
  be refused. So the offer becomes restoring that backup here and then linking it ("Signed in,
  restored, linked"). The same consent rules apply, except that the prompt defaults to no, and the
  next command is `cleo cloud restore <id> --into <root>`. A restore never overwrites local rows
  without `--force`. If the copy has rows it never synced, the restore is refused, and the user picks
  one of two commands listed in `data.firstRun.choices`: restore with `--force` behind a safety backup,
  or push this copy as a labelled fork.
- Outside a CLEO project, login lists the account's projects by name, each with the exact
  `cleo cloud restore <name>` command when it has a backup this machine does not hold yet. In JSON,
  `restoreCommand` uses the project id, which never changes, and `restoreByNameCommand` the name.
  Names come from the plaintext label, or the id when there is no label. `encryptedName` is neither
  written nor opened, because its format is not specified yet (cleo-nexus T098); a reader for that
  format can plug into the `openName` option once the spec exists. A project whose id is not a CLEO
  project id is left out of the list, with a warning. Listing is a read: nothing is minted or written.
- Every printed command carries `--api-url` when the server is not the default one, and a push
  refused as behind names `cleo cloud pull`.
- A read-only device, or `CLEO_NEXUS_DEVICE=0`, skips the whole first run. A first-run problem never fails the sign-in;
  it becomes a warning with its remedy.

`cleo cloud restore <name>` (also `--project <name>`) accepts a project name or label as well as its id.
A name matches exactly first, then without regard to case. A name several projects share is refused
with `E_NEXUS_PROJECT_AMBIGUOUS` (exit 6), and every candidate, with its by-id restore command, is
listed in `error.details`. A name no project has is `E_NEXUS_PROJECT_NOT_FOUND` (exit 4). A UUID is
used as the id directly. Without `--into`, a restore run from inside another CLEO project's
subdirectory is refused (`E_NEXUS_VAULT_TARGET_OCCUPIED`), instead of nesting a second project there.
Names and organization names from the server are printed with control, zero-width, separator and
bidi characters removed.
