---
id: t13207-row-meta-keep-newer
tasks: [T13207]
kind: fix
summary: Sync row meta keeps the newer HLC per field, so an older incoming field HLC can never move a field or the row back
---

review-hotfix note on #1870 (T13204). `upsertRowMetaFromFields` overlaid the caller's field HLCs as given. A losing remote field's older HLC would have moved that field backwards, and could have dropped the row `hlc`. Each named field now keeps the newer of its stored and incoming HLC.
