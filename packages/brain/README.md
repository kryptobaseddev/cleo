# @cleocode/brain

> Part of [CLEO](https://github.com/kryptobaseddev/cleo#readme). Start with the root README; run `cleo <command> --help` for any command.

The unified-graph **Brain** projection for CLEO: one node-and-edge graph read
from five substrates: **brain** (memory), **nexus** (code graph), **tasks**,
**conduit** (legacy messages) and **agent-registry** (agents). CLEO Studio
(`packages/studio`) is its consumer.

## Store

The adapters read the consolidated store, one `cleo.db` per scope, with
prefixed table names:

- **Project** `<project>/.cleo/cleo.db`: `tasks_*`, `brain_*`, `conduit_*` and
  the `nexus_*` code graph (project-resident per ADR-090).
- **Global** `<cleoHome>/cleo.db`: `agent_registry_*`.

Each read opens a read-only snapshot through the core store chokepoint
(`openCleoDbSnapshot` in `@cleocode/core/store/open-cleo-db`): no migrations,
no cached handle, closed after the read. The legacy per-domain files
(`brain.db`, `tasks.db`, `conduit.db`, `nexus.db`, `signaldock.db`) are never
read (T12095, T14583). A missing or unreadable store makes its substrates
return no nodes.

## Substrates

Every node carries a substrate-prefixed ID so cross-substrate edges can
reference nodes unambiguously, e.g. `brain:O-abc` vs `nexus:sym-123`.

| Substrate        | Store    | Tables                                                          | Node kinds                               |
|------------------|----------|-----------------------------------------------------------------|------------------------------------------|
| `brain`          | project  | `brain_observations`, `_decisions`, `_patterns`, `_learnings`, `_page_edges`, `_memory_links` | observation, decision, pattern, learning |
| `nexus`          | project  | `nexus_nodes`, `nexus_relations`                                | symbol, file                             |
| `tasks`          | project  | `tasks_tasks`, `tasks_sessions`, `tasks_task_relations`, `tasks_task_dependencies` | task, session                            |
| `conduit`        | project  | `conduit_messages`                                              | message                                  |
| `agent-registry` | global   | `agent_registry_agents`                                         | agent                                    |

The agent registry has no agent-to-agent connection table, so agent→agent
edges come only from conduit message pairs.

Conduit is legacy (T13933); agent messaging now runs on AgentMBX.

## Usage

```ts
import { getAllSubstrates, type BrainGraph } from '@cleocode/brain';

const graph: BrainGraph = getAllSubstrates({ limit: 500, minWeight: 0 });
console.log(`${graph.nodes.length} nodes across ${Object.keys(graph.counts.nodes).length} substrates`);
```

`BrainQueryOptions` also takes `substrates` (query a subset) and `projectCtx`
(the project to read; its `tasksDbPath` names the project `cleo.db`, and
`brainDbPath` is the same file). After loading, `getAllSubstrates` fetches a stub
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

The root entry point also exports the path helpers (`getProjectStorePath`,
`getGlobalStorePath`, `getCleoProjectDir`, `getCleoHome`), the snapshot
readers (`readProjectStore`, `readGlobalStore`) and
`resolveDefaultProjectContext`.

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
