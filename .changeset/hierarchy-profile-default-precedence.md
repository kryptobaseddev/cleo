---
id: hierarchy-profile-default-precedence
tasks: [T14541]
kind: fix
summary: "Hierarchy profiles: preserve preset caps unless configuration explicitly overrides them"
---

Resolve hierarchy profile defaults after global, project and environment overrides,
so selecting human-cognitive enforces its 7 sibling / 3 active caps. Explicit caps,
including zero for unlimited, keep their precedence; no profile remains unlimited.

New project scaffolds and the config template leave sibling caps unset. Existing
projects can opt into `cleo upgrade --migrate-hierarchy-defaults` to back up config
and remove legacy zero caps, with `--dry-run` preview and a notice that intentional
unlimited overrides are removed too. Ordinary upgrades preserve explicit caps.
