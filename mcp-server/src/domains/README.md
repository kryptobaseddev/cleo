# Domain Handlers

This directory contains the 8 domain handlers that implement CLEO's business logic:

## Query Domains (cleo_query)

1. **tasks** - Task discovery, listing, tree views, dependency analysis
   - Operations: get, list, find, exists, tree, blockers, deps, analyze, next

2. **session** - Session status, history, focus management
   - Operations: status, list, show, focus.get, history

3. **orchestrate** - Multi-agent coordination, dependency waves, skill selection
   - Operations: status, next, ready, analyze, context, waves, skill.list

4. **research** - Research entry management, manifest queries
   - Operations: show, list, query, pending, stats, manifest.read

5. **lifecycle** - RCSD-IVTR stage progression, gate status
   - Operations: check, status, history, gates, prerequisites

6. **validate** - Schema, protocol, anti-hallucination, compliance validation
   - Operations: schema, protocol, task, manifest, output, compliance.summary, compliance.violations, test.status, test.coverage

7. **system** - Version, health checks, configuration, statistics
   - Operations: version, doctor, config.get, stats, context

## Mutate Domains (cleo_mutate)

All query domains above PLUS:

8. **release** - Version management, changelog, git tagging
   - Operations: prepare, changelog, commit, tag, push, gates.run, rollback

## Implementation Pattern

Each domain handler exports:

```typescript
export async function handleQuery(operation: string, params: Record<string, unknown>): Promise<unknown>;
export async function handleMutate(operation: string, params: Record<string, unknown>): Promise<unknown>;
```

Handlers delegate to CLI commands via `lib/cli-wrapper.ts` to ensure:
- Single source of truth for business logic
- CLI tests cover MCP behavior
- Backward compatibility maintained

## Files to Create

- `tasks.ts`
- `session.ts`
- `orchestrate.ts`
- `research.ts`
- `lifecycle.ts`
- `validate.ts`
- `system.ts`
- `release.ts`
