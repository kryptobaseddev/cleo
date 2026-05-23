---
id: t10105-release-plan-fail-loud-yaml
tasks: [T10105, T9780]
kind: feat
summary: cleo release plan now aborts on changeset YAML parse with E_CHANGESET_YAML_INVALID + always writes the CHANGELOG section (placeholder if zero entries) + aligns gh workflow run input schema with release open field set
prs: [539]
---

Hit on v5.100 ship: changeset with unquoted colon caused parseChangesetDir to log WARN and silently skip, leaving CHANGELOG without the version section and forcing manual #482 hotfix. Adds ChangesetYamlInvalidError contract type with file:line:snippet payload. Also corrects cleo release open --field set to match release-prepare.yml workflow_dispatch.inputs (drops unknown plan-blob-sha256 field that caused HTTP 422). New vitest fixtures cover v5.100 reproduction. Closes T9780 (skip+warn approach was superseded by user-mandated fail-loud).
