# @cleocode/brain

The unified-graph **Brain** substrate for CLEO — a substrate-agnostic projection
across all five CLEO databases: **BRAIN**, **NEXUS**, **TASKS**, **CONDUIT**,
and **SIGNALDOCK**.

## Purpose

`@cleocode/brain` promotes the unified-graph substrate from a studio-internal
module to a first-class workspace package, mirroring `@cleocode/nexus`. Operator
mandate per T962 reconciliation: BRAIN is the super-domain (wraps memory +
nexus + tasks + conduit + signaldock), deserves CLI access, and needs a package
standalone publish lane.

## Substrates

Every node carries a substrate-prefixed ID so cross-substrate edges can
reference nodes unambiguously, e.g. `brain:O-abc` vs `nexus:sym-123`.

| Substrate    | Database             | Node kinds                                   |
|--------------|----------------------|----------------------------------------------|
| `brain`      | brain.db (project)   | observation, decision, pattern, learning     |
| `nexus`      | nexus.db (global)    | symbol, file                                 |
| `tasks`      | tasks.db (project)   | task, session                                |
| `conduit`    | conduit.db (project) | message                                      |
| `signaldock` | signaldock.db (global) | agent                                      |

## Usage

```ts
import { getAllSubstrates, type LBGraph } from '@cleocode/brain';

const graph: LBGraph = getAllSubstrates({ limit: 500, minWeight: 0 });
console.log(`${graph.nodes.length} nodes across ${Object.keys(graph.counts.nodes).length} substrates`);
```

Individual substrate adapters are exported from `@cleocode/brain/adapters`:

```ts
import {
  getBrainSubstrate,
  getConduitSubstrate,
  getNexusSubstrate,
  getSignaldockSubstrate,
  getTasksSubstrate,
} from '@cleocode/brain/adapters';
```

## Wire Format

The wire format (types `LBNode`, `LBEdge`, `LBGraph`, `LBQueryOptions`,
`LBStreamEvent`) is re-exported from the top-level entry point. See
`src/types.ts` for the canonical definitions.

Future parallel work (T968) will add a contract mirror under
`@cleocode/contracts/operations/brain` for programmatic-API consumers.

## Naming

Current exports preserve the `LB*` prefix (`LBNode`, `LBEdge`, `LBGraph`,
`LBSubstrate`, `LBQueryOptions`, `LBStreamEvent`, `LBConnectionStatus`,
`LBNodeKind`) for a stable extraction diff. T973 will rename these to
`Brain*` across contracts and studio in a separate, focused change.

## License

MIT — see LICENSE.
