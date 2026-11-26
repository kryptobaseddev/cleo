---
id: brain-reads-cleo-db
tasks: [T14583]
kind: breaking
summary: "@cleocode/brain substrate adapters read the project and global cleo.db (prefixed tables) through the core snapshot opener instead of the legacy brain.db, tasks.db, conduit.db, nexus.db and signaldock.db"
breaking: "Removed from @cleocode/brain: getBrainDb, getTasksDb and getConduitDb (replacement: readProjectStore(ctx, read)); getNexusDb (replacement: readProjectStore(ctx, read), since the code graph is project-scope); getAgentRegistryDb (replacement: readGlobalStore(read)); getBrainDbPath, getTasksDbPath, getConduitDbPath and getNexusDbPath (replacement: getProjectStorePath()); getAgentRegistryDbPath (replacement: getGlobalStorePath()). The readers open a read-only snapshot for one synchronous read and close it, instead of returning a caller-owned writable handle. The agent-registry substrate no longer emits declared agent connection edges."
---

`getAllSubstrates()` returned an empty or stale graph because every adapter
opened a retired per-domain file and queried bare table names. The adapters now
read `tasks_*`, `brain_*`, `conduit_messages` and the `nexus_*` code graph from
the project `cleo.db`, and `agent_registry_agents` from the global `cleo.db`,
each through a read-only `openCleoDbSnapshot` handle closed after the read.

Breaking for direct consumers of the low-level exports: `getBrainDb`,
`getTasksDb`, `getConduitDb`, `getNexusDb`, `getAgentRegistryDb` and the five
matching `get*DbPath` helpers are removed. Use `readProjectStore`,
`readGlobalStore`, `getProjectStorePath` and `getGlobalStorePath`. The
agent-registry substrate no longer emits declared agent connection edges: the
consolidated store has no such table, and agent→agent edges come from conduit
message pairs.
