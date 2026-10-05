---
id: t13126-domains-lazy
tasks: [T13126]
kind: fix
summary: verify, deps, tree, orchestrate, memory find, docs, nexus and doctor no longer load all of CORE; ~115-225 MB instead of ~255-280 MB
---

The commands agents run after every task still loaded the whole CORE barrel. They imported
`@cleocode/core`, `@cleocode/core/internal` or `@cleocode/runtime/gateway`, each of which loads
~3,000 modules.

- The check, docs, memory, nexus, orchestrate, pipeline, playbook and ivtr dispatch domains now
  load each operation's handler only when that operation runs. They import their CORE helpers
  from the modules that define them.
- Commands now import from the modules that define each helper: docs (graph, set-alias, view,
  viewer), deps, memory, brain, nexus, orchestrate, check, the doctor subcommands, the colour
  renderers and the migrate commands.
- `cleo memory find` imported the `@cleocode/core/memory` barrel, which pulls in the
  observer-reflector. That loaded the model runner and the OpenAI and Anthropic SDKs, about 180
  modules, for a read.
- The runtime's `engine-error`, `rpc/server` and daemon logger, and the playbooks runtime, no
  longer import the CORE barrel. `@cleocode/runtime/gateway/dispatch` now also exports the
  nexus decorator helpers and `engineSuccess`.
- `@cleocode/core/core-paths` exposes CORE's own `paths.ts` helpers (`getCleoHome` and the
  others). The `@cleocode/core/paths` subpath is the `@cleocode/paths` surface.

Peak RSS on the built CLI, before → after:

| Command | Before | After |
|---|---|---|
| `verify` | 265 MB | 207 MB |
| `deps show` | 260 MB | 146 MB |
| `deps tree` | 253 MB | 113 MB |
| `orchestrate status` | 271 MB | 201 MB |
| `orchestrate ready` | 276 MB | 201 MB |
| `memory find` | 275 MB | 159 MB |
| `docs list` | 269 MB | 206 MB |
| `nexus status` | 273 MB | 185 MB |
| `doctor` | 280 MB | 198 MB |
| `check arch` | 254 MB | 119 MB |

Gate 39 adds probes for verify, deps show, orchestrate status, memory find, docs list, nexus
status and doctor. Each probe forbids the CORE barrel and the model SDKs. The `config get` probe
now reads a real key and must exit 0, so it measures the success path. The gate 19 baseline
falls from 95 to 72.
