# Anti-Patterns

## Orchestrator Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Reading full files | Context bloat | Read manifest summaries only |
| Implementing code | Role violation | Delegate to cleo-subagent |
| Parallel spawns | Race conditions | Sequential per dependency wave |
| Unresolved tokens | Subagent failure | Verify `tokenResolution.fullyResolved` |

## Subagent Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Returning content | Context bloat | Return only summary message |
| Pretty-printed JSON | Invalid manifest | Single-line JSON |
| Loading skills via `@` | Cannot resolve | Skills injected by orchestrator |
| Skipping task start | Protocol violation | Always `cleo start` first |
