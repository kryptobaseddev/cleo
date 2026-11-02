---
id: release-changelog-utc-date
tasks: [T14172]
kind: fix
summary: "The CHANGELOG section of a release is dated by the tag's UTC day"
---

`cleo release write-changelog` and release.yml's CHANGELOG + version PR job
dated the section in the tagger's timezone (`%(creatordate:short)`), so a tag
cut in the evening west of UTC got the previous day, unlike the UTC CalVer
window. Both now use the UTC day of the tag's creation.
