---
id: t14025-multi-pr-own-hunks
tasks: [T14025]
kind: fix
summary: "a `pr:` atom whose listed files a later cited PR also edited is proven while the read version still carries its own hunks"
---

With several `pr:` atoms in one evidence write, each `files:` path is read at the
merge of the latest cited PR that changed it (T12848). An earlier PR was refused
("has no listed file read at its own merge commit") whenever every file it
changed that the write listed was also changed by a later cited PR, even when
the later PR only edited elsewhere in the file. That contradicted the documented
own-hunks rule (T12689) and blocked tasks such as a three-PR `pr:55;pr:82;pr:161`
write whose files were all touched again later.

`cleo verify` now credits an earlier PR when the version read at the later merge
still carries that PR's own first-parent hunks (identical bytes, or hunks that
reverse-apply and do not re-apply, as for components). The credit is recorded in
the `files:` entry's new `carries` field (merge SHAs), so `cleo complete`
re-validation reaches the same verdict. A PR whose listed hunks were all
rewritten or reverted is still refused; the message now names each file and the
PR whose merge it is read at, and suggests listing a file only when the PR
changed one that no later cited PR changed, else recording the PR in its own
`cleo verify` write.
