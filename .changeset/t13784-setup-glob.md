---
id: t13784-setup-glob
tasks: [T13784]
kind: fix
summary: "A moved test-run compares only the owning package's test-style setup files, not every *setup* source under packages/"
---

Follow-up to the T13784 review of #2295. The setup-file match compared
`*setup*` files under every ancestor directory. Because `packages/` is an
ancestor of every change, that took in every package's setup files and
ordinary sources such as `setup-wizard.ts`, so unrelated commits staled the
run again. It now matches only test-style setup names (`*.setup.*`,
`setup-tests.*`, `setupTests.*`, `test-setup.*`, `global-setup.*`,
`setup-global.*`), and only from each file's owning package (its nearest
directory with a `package.json`) down.
