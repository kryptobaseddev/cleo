---
id: t13555-hooks-v1-gate-source-guard
tasks: [T13555]
kind: fix
summary: "release plan refuses a stable release that opens the hooks-v1 gate by source without the promotion"
---

Project hooks stay inert on a stable build until the hooks-v1 promotion
stamps its release metadata, and only a `--hooks-v1-promotion` plan passes the
pilot evidence gate. A source edit could still open the gate unseen: dropping
`hooks-v1` from `UNRELEASED_HOOK_FEATURES`, changing `hooksV1Released`, or
deleting the gate. `cleo release plan` now compares the gate against the
previous release tag and refuses such a stable plan
(`E_HOOKS_V1_PROMOTION_REQUIRED`) unless it is the promotion or carries
`--hooks-v1-waiver "<reason>"`, which is recorded in the plan and in
`.cleo/audit/hooks-v1-waiver.jsonl`.
