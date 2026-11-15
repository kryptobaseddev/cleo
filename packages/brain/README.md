# @cleocode/brain

> Part of [CLEO](https://github.com/kryptobaseddev/cleo#readme). Start with the root README; run `cleo <command> --help` for any command.

The unified-graph **Brain** projection for CLEO: one node-and-edge graph read
from five substrates: **brain** (memory), **nexus** (code graph), **tasks**,
**conduit** (legacy messages) and **agent-registry** (agents). CLEO Studio
(`packages/studio`) is its consumer.

> **Known defect (T14583).** The adapters do not read the live store yet.
> `src/db-connections.ts` and `src/cleo-home.ts` open the legacy per-domain
> files (`brain.db`, `tasks.db`, `conduit.db` under the project `.cleo/`;
> `nexus.db` and `signaldock.db` under CLEO home) and query bare table names
> (`tasks`, `sessions`, `messages`, `agents`, `nexus_nodes`, …). The live store
> is one `cleo.db` per scope with prefixed tables (`tasks_tasks`,
> `agent_registry_agents`, …), and those legacy files are gone or stale. A
> missing file makes its substrate return no nodes, so `getAllSubstrates()`
> returns an empty or stale graph until T14583 moves the adapters to `cleo.db`.

## Substrates

Every node carries a substrate-prefixed ID so cross-substrate edges can
reference nodes unambiguously, e.g. `brain:O-abc` vs `nexus:sym-123`.

| Substrate        | File the adapter opens today (T14583) | Node kinds                               |
|------------------|---------------------------------------|------------------------------------------|
| `brain`          | `brain.db` (project)                  | observation, decision, pattern, learning |
| `nexus`          | `nexus.db` (global)                   | symbol, file                             |
| `tasks`          | `tasks.db` (project)                  | task, session                            |
| `conduit`        | `conduit.db` (project)                | message                                  |
| `agent-registry` | `signaldock.db` (global)              | agent                                    |

Conduit is legacy (T13933); agent messaging now runs on AgentMBX.

## Usage

```ts
import { getAllSubstrates, type BrainGraph } from '@cleocode/brain';

const graph: BrainGraph = getAllSubstrates({ limit: 500, minWeight: 0 });
console.log(`${graph.nodes.length} nodes across ${Object.keys(graph.counts.nodes).length} substrates`);
```

`BrainQueryOptions` also takes `substrates` (query a subset) and `projectCtx`
(the project paths to read). After loading, `getAllSubstrates` fetches a stub
node (`meta.isStub: true`) for any edge target not already loaded, so
cross-substrate edges are kept.

Individual substrate adapters are exported from `@cleocode/brain/adapters`:

```ts
import {
  getBrainSubstrate,
  getConduitSubstrate,
  getAgentRegistrySubstrate,
  getNexusSubstrate,
  getTasksSubstrate,
} from '@cleocode/brain/adapters';
```

The root entry point also exports the path helpers (`getBrainDbPath`,
`getTasksDbPath`, …), the raw connection getters (`getBrainDb`, `getTasksDb`,
…) and `resolveDefaultProjectContext`. They resolve the legacy files described
above.

## Wire Format

The graph types (`BrainNode`, `BrainEdge`, `BrainGraph`, `BrainSubstrate`,
`BrainQueryOptions`, `BrainStreamEvent`, `BrainNodeKind`,
`BrainConnectionStatus`, `BrainProjectContext`) are defined in
`packages/contracts/src/brain-graph.ts` and re-exported here through
`src/types.ts`.

A separate wire contract lives at `@cleocode/contracts/operations/brain`
(T968) for the brain.* operations. It is structurally distinct from the
runtime graph types: `BrainNodeWire` uses `type: string` + `data`, while the
runtime `BrainNode` uses `kind: BrainNodeKind` + `meta` + an optional
`weight`, and its substrate names use `memory` where the runtime uses `brain`.

## Naming

All exported types carry the `Brain*` prefix. T973 completed the `LB*` →
`Brain*` rename started by the T969 package extraction; no `LB*` name is
exported.

## License

MIT. See LICENSE.
