---
id: release-propagation-timeout-handoff
tasks: [T14192]
kind: fix
summary: "A canary whose packages npm accepted no longer fails publish on a registry propagation timeout, and the supervisor binaries attach whenever the release exists"
---

v2026.11.1-canary.3's release run went red because the canary post-deploy
check inside the publish job timed out after 900 s waiting for
@cleocode/core's metadata (registry lag), so `supervisor-attach` was skipped
and the failed jobs had to be re-run.

- For an independent canary, a check that only timed out on the registry
  (verdict `pending`) no longer fails the publish job: the soak is skipped and
  the Post-Deploy Execution Payload job and release-installability-watch.yml
  take over. A defect, or no verdict, still fails it. The release candidate
  gate of a stable release is unchanged and still blocking.
- `supervisor-attach` runs whenever the publish job created the GitHub
  Release (`release_created` output), not only when every publish step passed.
