# Living Brain E2E Proof

End-to-end sandbox proof that all 5 Living Brain substrates work together.

## What it proves

| Substrate | Mechanism | Evidence |
|-----------|-----------|----------|
| NEXUS | `cleo nexus analyze` indexes 3 TypeScript files (auth, server, config) → 15 nodes, 18 relations including `validateUser → hashPassword`, `validateUser → loadConfig`, `handleRequest → validateUser` call edges | `nexus_nodes`, `nexus_relations` rows |
| BRAIN | `cleo memory observe` creates an observation; a `code_reference` edge links it to `src/auth.ts::validateUser` in `brain_page_edges` | `brain_page_edges.code_reference` count |
| TASKS | Post-analyze git-log sweeper reads commit messages tagged `T001`/`T002`/`T003` and writes `task_touches_symbol` edges to `brain_page_edges` | 6 edges created |
| SENTIENT | `sentientProposals` field present in `full-context` response (empty by default, field structure verified) | `full-context` JSON field presence |
| CONDUIT | `conduitThreads` field present in `full-context` response (empty if conduit.db absent — graceful no-op) | `full-context` JSON field presence |

## Architecture

The scenario runs with an **isolated CLEO_HOME** (`$SANDBOX/.nexus-home`) so the test has its own `nexus.db` independent of the main project. The sandbox's CLEO project lives in `$SANDBOX/.cleo/brain.db` and `tasks.db`.

Key discovery: the `runGitLogTaskLinker` post-analyze sweeper uses a `last_task_linker_commit` stored in the shared `nexus_schema_meta` table. Using an isolated `CLEO_HOME` gives a clean `nexus.db` without a stale `last_task_linker_commit`, which is what allows the git-log sweep to process all commits in the sandbox repo.

## Running

```bash
# From the cleocode project root:
bash scenarios/living-brain-e2e/run.sh

# The script prints the SANDBOX_DIR at the end:
bash scenarios/living-brain-e2e/assertions.sh <SANDBOX_DIR>
```

Or combined:

```bash
bash scenarios/living-brain-e2e/run.sh && \
  bash scenarios/living-brain-e2e/assertions.sh \
    "$(ls -dt /tmp/living-brain-e2e-* | head -1)"
```

## Files

| File | Purpose |
|------|---------|
| `run.sh` | Creates sandbox, commits fixtures, runs `cleo init` + `cleo nexus analyze`, seeds brain observation |
| `assertions.sh` | Queries all 5 substrates and reports pass/fail per assertion |
| `fixtures/auth.ts` | TypeScript file with `validateUser` + `hashPassword` (primary proof symbol) |
| `fixtures/server.ts` | TypeScript file with `startServer` + `handleRequest` (callers of auth) |
| `fixtures/config.ts` | TypeScript file with `AppConfig` + `loadConfig` (config layer) |

## Expected output

```
Results: 18 passed, 0 failed

Substrate verification table:
  NEXUS (nexus_nodes):          15 nodes, 7 relations
  BRAIN (brain_page_edges):     1 code_reference, 2 nodes
  TASKS (task_touches_symbol):  6 edges
  SENTIENT:                     sentientProposals field verified in full-context
  CONDUIT:                      conduitThreads field verified in full-context
```

## Task

T1111 (parent: T1056 Nexus P2 — Living Brain Completion)
