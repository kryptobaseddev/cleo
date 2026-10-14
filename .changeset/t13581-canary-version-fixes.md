---
id: t13581-canary-version-fixes
tasks: [T13581]
kind: fix
summary: "A canary install writes a schema-valid project-info.json and gets update notices"
---

Two defects any prerelease build hit, found when main moved to
`2026.10.10-canary.1`:

- `project-info.json`'s `cleoVersion` only accepted `x.y.z`, so every canary
  (or beta) install wrote a file that failed its own schema. It now accepts a
  semver prerelease and build suffix.
- A canary install got no update notice at all. It runs as `cleo`, so
  `cleo self-update` moves it to `latest`; the notice now follows `latest` for
  a `-canary.N` version too (silent while the canary is ahead, noticed when
  the stable that promotes it or a newer hotfix ships).
