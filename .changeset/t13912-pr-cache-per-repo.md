---
id: t13912-pr-cache-per-repo
tasks: [T13912]
kind: fix
summary: The pr:/ci: evidence cache is per repository, and pr:<owner>/<repo>#<n> names the repository
---

PR numbers are only unique per repository, but the `pr:`/`ci:` result cache
was keyed by PR number alone. In a CLEO project that spans two repositories,
one repository's PR #87 shadowed the other's. Cache entries now carry the
repository identity (the execution root's GitHub `origin` slug, or a hash of
the checkout path when there is none). An entry from another repository, or
a legacy repo-less entry, is refetched and never trusted. The
branch-protection cache is keyed the same way.

`pr:<owner>/<repo>#<n>` and `ci:<owner>/<repo>#<n>` name the repository
explicitly. They are refused when the evidence git root's origin is a
different repository.
