---
id: upgrade-refreshes-unparseable-seeds
tasks: [T14655]
kind: fix
summary: "cleo upgrade refreshes unedited agent seeds that no longer parse and reports edited ones with a fix that yields a parseable agent"
---

- `cleo upgrade` and `cleo self-update` now pass the CANT parser to the agent
  registry sync. An unparseable seed whose bytes still equal its install-time
  seed digest is refreshed from the packaged template (the old bytes are kept
  as `<file>.bak-<instant>`). An edited one is never overwritten: upgrade
  reports it as an `agent_cant_parse` action with its fix command.
- A seed installed before `seed_sha256` existed is recognised as unedited when
  its bytes equal a shipped historical version of its packaged template.
- The D-007 fix for a file that cannot be refreshed installs the packaged
  template (`cleo agent install <template> --force`) instead of reinstalling the
  same broken bytes; with no packaged template there is no fix command until
  the file is rewritten.
- Installs keep only the newest 3 `.bak-<instant>` copies of a replaced file.
- The parser is imported inside the check, so a failed `@cleocode/cant` import
  yields the D-012 finding instead of aborting `cleo agent doctor`.
