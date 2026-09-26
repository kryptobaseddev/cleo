---
id: release-prepare-cant-napi
tasks: [T12427]
kind: fix
summary: release-prepare preflight tests build the cant-napi addon, so a release can be prepared after the committed .node was removed
---

T12382 removed the committed linux `.node` for the `.cant` parser and added a
build step to `ci.yml`, but the release-prepare preflight test job never got
it, so every CANT test that needs the native addon failed there and v2026.9.20
could not be prepared. The preflight test job (and its template) now builds the
host addon with `pnpm --filter @cleocode/cant run build:napi`, as `ci.yml` does.
