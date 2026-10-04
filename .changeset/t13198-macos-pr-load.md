---
id: t13198-macos-pr-load
tasks: [T13198]
kind: chore
summary: A darwin pull request runs 2 macOS shards instead of 8, and fewer changes count as darwin-specific
---

The free plan runs at most 5 macOS jobs at once, across every pull request and main push, so one
darwin pull request (8 macOS shards plus 2 macOS builds) held the whole pool and the macOS legs of
every other PR queued behind it for hours. A darwin pull request now runs 2 macOS shards, which with
its two builds fits the pool in one wave. Each leg runs half the suite, so its timeout is 90 minutes.
The nightly, merge-group and `macos-main.yml` runs keep all 8 shards.

Darwin detection is also narrower. These no longer count as darwin-specific:
- a platform check whose only named platform is `'win32'` (it splits Windows from POSIX, and Linux
  already runs the POSIX side);
- a `runner.os` cache key;
- a comment line;
- an edit to `macos-main.yml`, which pull-request CI does not run.

A darwin or macOS path, a `'darwin'`/`'macos'` literal, `Darwin`, `target_os`, `uname`, `macos-latest`,
and a platform check naming `'linux'` or no platform at all still count. Over the last 100 merged pull
requests this takes macOS jobs from 1.70 to 0.40 per PR.
