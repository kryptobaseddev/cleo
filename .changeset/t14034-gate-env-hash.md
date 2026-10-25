---
id: t14034-gate-env-hash
tasks: [T14034]
kind: fix
summary: "Typed-gate cache key hashes only declared and tool-input env, so a --run pass is reusable from another shell"
---

A typed gate's cached pass was keyed on a hash of the whole launch
environment, including `PWD`, `SHLVL`, `TERM_SESSION_ID` and harness ids
such as `CLAUDE_*`. A `cleo verify --run` pass could not be consumed by an
evidence write, `cleo done` or `cleo complete` from another shell: they
refused with `E_GATE_NOT_CACHED`.

The environment hash now covers only the gate's `env` keys, a new optional
`envKeys` list of inherited variable names on `test` and `command` gates
(for example `DATABASE_URL`), and a fixed tool-input set: `PATH`,
`NODE_OPTIONS`, `CI`, `LANG`, `LC_*` and the heavy-run overlay. The gate
still launches with the whole environment. Passes cached under the old key
miss once and are replaced by the next `--run`.
