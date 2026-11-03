---
id: release-cut-in-flight-guard
tasks: [T14184]
kind: feat
summary: "cleo release cut refuses while a lower tag's release.yml run is still in progress, unless --allow-in-flight"
---

A release cut while the previous tag's `release.yml` run was still building
based its notes on an older tag (that run had not created its GitHub Release
yet), so the new notes repeated the in-flight release's entries.

- `cleo release cut` lists `release.yml` runs not yet completed for a lower
  release tag; the dry run reports them (`inFlight` and a warning).
- A real cut refuses with `E_RELEASE_IN_FLIGHT`, naming each run, unless
  `--allow-in-flight` is passed.
