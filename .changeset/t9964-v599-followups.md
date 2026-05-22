---
id: t9964-v599-followups
tasks: [T9964]
kind: chore
prs: [459]
summary: "v5.99 ships T9964 E-ORIENT-V2 follow-ups — real briefing diet ≤1000 tokens, ferrous-forge fixture compliance, release-prepare.yml workflow"
---

Follow-ups from honest validation of T9964 E-ORIENT-V2 v5.97 ship:

- **Briefing diet (real)**: T9974 AC1 was missed in v5.97 (2367 tokens vs ≤1000 target). v5.99 default `cleo briefing` now ≤1000 tokens via progressive disclosure — peerLearnings/decisions emit `{id, title, createdAt}` with `_next.fetch` hints (full body via `--memory-detail`); memoryContext titles truncated to 80 chars; relatedDocs surfaces `slug`+`type` instead of useless `attachmentId`; blockedTasks/activeEpics capped at 3 with 60-char titles.
- **Ferrous-forge fixture compliance**: `packages/cleo/test/fixtures/release-test-rust-crate/Cargo.toml` now uses edition=2024 + lints sections. Pre-commit hook passes without `--no-verify` on release commits.
- **release-prepare.yml**: GitHub Actions workflow added (closes T9781). `cleo release open <version>` now actually works end-to-end via `gh workflow run release-prepare.yml`.
- **release-prepare.yml jq bug fix**: workflow's `Bump workspace @cleocode/* dep refs` step had a jq error when a package.json lacked `dependencies`/`devDependencies`/`peerDependencies` fields. Replaced `(.dependencies // {}) |= ...` with `if has("dependencies") then ... else . end` per jq path-expression semantics.
