# @cleocode/brain

> Part of [CLEO](https://github.com/kryptobaseddev/cleo#readme). Start with the root README; run `cleo <command> --help` for any command.

The unified-graph **Brain** substrate for CLEO: a substrate-agnostic projection
across five substrates: **brain** (memory), **nexus** (code graph), **tasks**,
**conduit** (messages) and **agent-registry** (agents).

> **Known defect (T14583).** The adapters still open the legacy per-domain
> files (`brain.db`, `tasks.db`, `conduit.db` under the project `.cleo/`,
> `signaldock.db` and `nexus.db` under CLEO home). The live store is one
> `cleo.db` per scope with prefixed tables (`tasks_tasks`,
> `agent_registry_agents`, …); `tasks.db` and `brain.db` are decoys and
> `signaldock.db` is retired. Until T14583 lands, `getAllSubstrates()` reads
> stale or empty files.

## Purpose

`@cleocode/brain` promotes the unified-graph substrate from a studio-internal
module to a first-class workspace package, mirroring `@cleocode/nexus`. Operator
mandate per T962 reconciliation: BRAIN is the super-domain (wraps memory +
nexus + tasks + conduit + the agent registry), deserves CLI access, and needs a
package standalone publish lane.

## Substrates

Every node carries a substrate-prefixed ID so cross-substrate edges can
reference nodes unambiguously, e.g. `brain:O-abc` vs `nexus:sym-123`.

| Substrate        | File the adapter opens today (see T14583) | Node kinds                               |
|------------------|-------------------------------------------|------------------------------------------|
| `brain`          | `brain.db` (project)                      | observation, decision, pattern, learning |
| `nexus`          | `nexus.db` (global)                       | symbol, file                             |
| `tasks`          | `tasks.db` (project)                      | task, session                            |
| `conduit`        | `conduit.db` (project)                    | message                                  |
| `agent-registry` | `signaldock.db` (global)                  | agent                                    |

## Usage

```ts
import { getAllSubstrates, type BrainGraph } from '@cleocode/brain';

const graph: BrainGraph = getAllSubstrates({ limit: 500, minWeight: 0 });
console.log(`${graph.nodes.length} nodes across ${Object.keys(graph.counts.nodes).length} substrates`);
```

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

## Wire Format

The wire format (types `BrainNode`, `BrainEdge`, `BrainGraph`,
`BrainQueryOptions`, `BrainStreamEvent`) is re-exported from the top-level
entry point. See `src/types.ts` for the canonical definitions.

A parallel **contracts mirror** lives at
`@cleocode/contracts/operations/brain` (T968) for programmatic-API
consumers. It describes the HTTP wire format for the brain.* operations
and is intentionally structurally distinct from these runtime types (e.g.
contract `BrainNode` uses `type: string` + `data`, runtime uses `kind:
BrainNodeKind` + `meta` + an optional adapter-produced `weight`).

## Naming

All exported types carry the `Brain*` prefix (`BrainNode`, `BrainEdge`,
`BrainGraph`, `BrainSubstrate`, `BrainQueryOptions`, `BrainStreamEvent`,
`BrainConnectionStatus`, `BrainNodeKind`). T973 completed the LB* → Brain*
rename started by the T969 package extraction. The `LB*` prefix is no
longer exported by this package.

## License

MIT — see LICENSE.
