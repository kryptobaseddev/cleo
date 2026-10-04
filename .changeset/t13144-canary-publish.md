---
id: t13144-canary-publish
tasks: [T13144, T13181]
kind: feat
summary: A stable release reaches npm latest only after its release candidate installs from npm and passes a sandbox soak, all through OIDC with no npm token
---

A bad release used to reach every user at once, because `release.yml`
published each stable version straight to `latest`. Now, for a tag
`v<version>`, the Publish job:

1. publishes every package as `<version>-rc.ci.<run number>` under the `canary`
   dist-tag, through npm trusted publishing (OIDC);
2. proves that candidate installable from npm: metadata, tarball and
   `dist-tags.canary` for every package (`scripts/execute-payload.mjs`);
3. installs `@cleocode/cleo@<version>-rc.ci.<n>` from npm into a throwaway prefix
   with throwaway stores and runs health checks (`scripts/release-canary-soak.mjs`):
   every installed @cleocode package at that version, then `--version`, `init`,
   `session start`, a saga and epic write, `show`, `find` and `doctor`;
4. only if both pass, publishes `<version>` under `latest` from the same commit,
   through OIDC.

Steps 2 and 3 block: a failure stops the job before `latest` is touched, and
users stay on the previous release. A re-run of the failed job reuses the same
candidate and skips every package already published; a re-run after the release
itself published skips the candidate. Prereleases (`-beta`, `-dev`) publish to
their own tags directly, as before.

There is no npm token, no approval environment and no dist-tag move anywhere: a
bad release is fixed forward with the next patch. Install a candidate yourself
with `npm i -g @cleocode/cleo@canary`, or run `node scripts/release-canary-soak.mjs`.

`scripts/release-sync-versions.sh` is now the one list of manifests a release
re-versions (Build & Verify, then twice in Publish). The isolated environment
shared by the packed-install smoke and the soak lives in
`scripts/lib/sandbox-env.mjs`, unchanged.
