---
id: t13614-autocomplete-retry-reset
tasks: [T13614]
kind: fix
summary: "A retried cleo complete no longer auto-completes a parent from the rolled-back attempt"
---

`cleo complete` runs its write in a transaction that is retried when SQLite is
busy. The list of parents to auto-complete was kept across attempts, so a
retry could still mark a parent done that a concurrent change had made
ineligible, and list it twice. The list is now rebuilt on every attempt.
