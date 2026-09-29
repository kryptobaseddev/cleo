---
id: skills-install-prune
tasks: [T12678]
kind: fix
summary: Skill install now prunes skills CLEO no longer installs (ct-grade, retired skills) where it can prove it owns them, with a dry-run and a receipt
---

`initCoreSkills` installed skills but never removed any. A skill later
declared `internal` (ct-grade) or retired (ct-docs-lookup, ct-docs-write,
ct-docs-review, and the others in the manifest's new `retiredSkills` list)
stayed linked into every harness on machines that had installed it.

After installing, CLEO now prunes those names, but only paths it can prove it
put there:

- a harness entry that is a symlink resolving into CLEO's canonical skills
  root;
- a harness entry that is a byte-identical copy of the canonical copy (Pi and
  other copy-mode harnesses);
- the canonical copy itself, when a CLEO link points to it or when the new
  bundled-install ledger (`<skills root>/.cleo-bundled.json`, written on every
  install) records it.

Real directories CLEO cannot prove it owns, including user skills of the same
name and links that point elsewhere, are kept and reported as skipped.
Removals are appended to `<skills root>/.prune-receipts.jsonl`, and a pruned
name leaves the ledger. `cleo install-global --dry-run` lists every path that
would be pruned or kept. Gate 29 fails if a `retiredSkills` name is still a
skill.
