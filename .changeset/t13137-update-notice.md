---
id: t13137-update-notice
tasks: [T13137]
kind: feat
summary: An installed CLEO announces a newer release on stderr, and a release flagged with the hotfix dist-tag gets a stronger notice on every command
---

Before this, nothing told an installed CLI that a fix existed: only an explicit `cleo self-update`
updated, so agents on other machines kept running a release with a known defect indefinitely.

Commands now read a small cache (`<state>/update-check.json`). When it is a day old (an hour after a
failed check), one command claims a lock and starts a detached child that fetches the package's
dist-tags and rewrites the cache; no command waits on the network. When the install's channel tag
(`latest`, or `beta` for a beta/rc install) names a newer version, the CLI prints one stderr line
naming it and `cleo self-update`, at most once a day.

A maintainer flags a release as a hotfix with `npm dist-tag add @cleocode/cleo@<version> hotfix`.
Every install below it, for which `cleo self-update` delivers it, then prints a stronger `HOTFIX`
line on every command until it updates. The tag arrives in the same dist-tags response, so the flag
costs no extra request and can be set or withdrawn after publishing.

The notice never touches stdout (the LAFS envelope is unchanged), and it is silent with
`CLEO_NO_UPDATE_NOTICE=1` (or `NO_UPDATE_NOTIFIER`) in every environment, TTY or not, in CI, from a
source checkout, under `--quiet`, and for `cleo self-update` and `cleo hook`. `CLEO_NO_UPDATE_NOTICE=1`
and CI also skip the registry check. The release artifact check now requires
`dist/cli/update-check-entry.js`.
