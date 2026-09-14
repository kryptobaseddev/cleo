---
id: no-cache-without-rotatable-key
tasks: [T12185]
kind: fix
summary: An evidence-cache entry whose key can never rotate is neither written nor read, closing a permanent fabricated PASS
---

`computeCacheKey` hashes `{canonical, cmd, args, head, dirtyFingerprint}`. When
the tool runs outside a git checkout both git fields are `null`, and the key
becomes a function of **the command alone**. Editing source does not change it.
Committing does not change it. Only editing the tool command changes it — a
config change, not a code change.

gh#1380 fixed the case where a killed run persisted `exitCode: null` — a
permanent unclearable **red**. This is its mirror and it is worse: a **real**
exit code, of either sign, stored against that unrotatable key. A cached red
fails closed and is investigated within minutes. **A cached PASS is not
self-announcing — nobody debugs a passing gate** — and it satisfies
`testsPassed` through the evidence gate without spawning anything.

It is structural for a whole class of project, not a kill artefact. Measured in
the field on a project whose CLEO root sits **above** its git root — a supported
layout, with the repo in a subdirectory — so both fields were null for every run,
always. Four entries, all `exitCode: 0`; the `test` one recorded
`122 files / 2557 tests` from 2026-08-07 against a suite that is now
`856 files / 13,621 tests`. It had stayed inert only because that project's tool
command was later rewritten, changing `args` and therefore the key.

Measured against the published `2026.9.2` and this build, same probe:

```
                                          2026.9.2      fixed
planted PASS (exitCode 0, head null)      SERVED        REFUSED
two identical runs, non-git root          hit on 2nd    no hit
git root, exit 0                          caches        caches
git root, exit 7                          caches        caches (exitCode 7)
```

The last two rows are the guard staying narrow: refusing more broadly would
trade a fabricated pass for a permanent cache miss on healthy projects — the
same overcorrection pointed the other way.

Refused on **read** as well as declining to **write**, because entries already
sitting in a consumer's `.cleo/cache/evidence/` cannot rotate themselves out.
That inability is the defect itself.

Projects whose CLEO root is not a git checkout lose tool-result caching
entirely. That is the right trade and is stated rather than hidden: they were
not getting valid caching, they were getting one answer forever. A better
long-term key — a content fingerprint that works without git — would restore it,
and should not gate this refusal.

Closes gh#1404.
