---
id: t13543-previous-tag-filter
tasks: [T13543]
kind: fix
summary: "release plan's previousTag counts only version-shaped tags below the planned version"
---

`cleo release plan` picks the previous release from the newest tag reachable
from HEAD (T13536). It no longer counts tags that only start with `v`
(`vv2026.5.106`, `vendor-2099.1`), and it no longer picks a reachable tag
newer than the version being planned (a back-dated or hotfix plan).
