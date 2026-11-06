---
id: global-config-owner-only
tasks: [T14221]
kind: fix
summary: "the global config.json is written 0600 by every writer, existing 0644 files are tightened on the next write, and cleo doctor credentials reports and fixes an exposed one"
---

The global `config.json` can hold flat provider keys, but the config-dir
migration created it 0644 and other writers kept whatever mode the file had.
Every writer of the config-dir and legacy data-dir `config.json` now writes
mode 0600 (`GLOBAL_CONFIG_FILE_MODE`), which also tightens an existing 0644
file on its next write. `cleo doctor credentials` reports a global config that
group or others can read, and `--fix` chmods it to 0600.
