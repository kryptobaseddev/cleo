# CLEO MCP Server Documentation Index

**Version**: 1.1.0
**Last Updated**: 2026-02-10

---

## Quick Start

- [README](README.md) - Overview and getting started
- [Installation](guides/installation.md) - Setup instructions
- [Configuration](guides/configuration.md) - Server configuration
- [MCP CLI Parity Matrix](../../docs/specs/MCP-CLI-PARITY-MATRIX.md) - Canonical parity status and deltas

---

## API Reference

### Core Concepts

- [API Overview](api/overview.md) - Gateway design, domains, operations
- [Error Codes](api/errors.md) - Complete error reference (exit codes 1-100)
- [Protocols](api/protocols.md) - RCSD-IVTR protocol enforcement (exit 60-70)
- [Lifecycle](api/lifecycle.md) - Lifecycle gates and progression

### Gateways

| Gateway | Type | Operations | Documentation |
|---------|------|------------|---------------|
| [cleo_query](api/gateways/cleo_query.md) | Read-only | 56 | Query, analysis, validation |
| [cleo_mutate](api/gateways/cleo_mutate.md) | Write | 51 | Create, update, delete |

### Domains

| Domain | Query | Mutate | Documentation |
|--------|-------|--------|---------------|
| [tasks](api/domains/tasks.md) | 9 | 10 | Task management |
| [session](api/domains/session.md) | 5 | 7 | Session management |
| [orchestrate](api/domains/orchestrate.md) | 7 | 5 | Multi-agent orchestration |
| [research](api/domains/research.md) | 6 | 4 | Research and manifest |
| [lifecycle](api/domains/lifecycle.md) | 5 | 5 | RCSD-IVTR lifecycle |
| [validate](api/domains/validate.md) | 9 | 2 | Validation and compliance |
| [release](api/domains/release.md) | 0 | 7 | Release management |
| [system](api/domains/system.md) | 5 | 7 | System operations |

**Total**: 107 operations (56 query + 51 mutate)

> **Source of truth**: `mcp-server/src/gateways/query.ts` and `mcp-server/src/gateways/mutate.ts` expected operation counts.
>
> **Contract note**: Core MCP contract is maintained in `docs/specs/MCP-SERVER-SPECIFICATION.md`; implementation includes parity extensions introduced by task T4269.

---

## Guides

### Setup & Configuration

- [Installation](guides/installation.md) - Install MCP server
- [Configuration](guides/configuration.md) - Configure server and clients
- [Authentication](guides/authentication.md) - Permission model

### Operational

- [Troubleshooting](guides/troubleshooting.md) - Common issues and solutions

---

## Examples

### Workflows

- [Task Management](examples/task-management.md) - Complete task workflows
- [Session Management](examples/session-management.md) - Session lifecycle
- [Orchestration](examples/orchestration.md) - Multi-agent coordination
- [Research Workflow](examples/research-workflow.md) - Research and manifest

### Code Examples

```typescript
// Query example
const tasks = await cleo_query({
  domain: "tasks",
  operation: "list",
  params: { status: "pending" }
});

// Mutate example
const newTask = await cleo_mutate({
  domain: "tasks",
  operation: "create",
  params: {
    title: "Implement feature X",
    description: "Add support for feature X with tests"
  }
});
```

---

## Operations by Category

### Task Operations (19 total)

**Query (9)**:
- `tasks.get` - Get task details
- `tasks.list` - List tasks with filters
- `tasks.find` - Fuzzy search
- `tasks.exists` - Check existence
- `tasks.tree` - Hierarchical view
- `tasks.blockers` - Get blocking tasks
- `tasks.deps` - Get dependencies
- `tasks.analyze` - Triage analysis
- `tasks.next` - Next task suggestion

**Mutate (10)**:
- `tasks.create` - Create task
- `tasks.update` - Update task
- `tasks.complete` - Complete task
- `tasks.delete` - Delete task
- `tasks.archive` - Archive completed
- `tasks.unarchive` - Restore from archive
- `tasks.reparent` - Change parent
- `tasks.promote` - Promote to higher level
- `tasks.reorder` - Reorder siblings
- `tasks.reopen` - Reopen completed

### Session Operations (12 total)

**Query (5)**:
- `session.status` - Current session
- `session.list` - List all sessions
- `session.show` - Session details
- `session.focus.get` - Get focused task
- `session.history` - Session history

**Mutate (7)**:
- `session.start` - Start session
- `session.end` - End session
- `session.resume` - Resume session
- `session.suspend` - Suspend session
- `session.focus.set` - Set focus
- `session.focus.clear` - Clear focus
- `session.gc` - Garbage collect

### Orchestration Operations (12 total)

**Query (7)**:
- `orchestrate.status` - Orchestrator status
- `orchestrate.next` - Next task to spawn
- `orchestrate.ready` - Parallel-safe tasks
- `orchestrate.analyze` - Dependency analysis
- `orchestrate.context` - Context usage
- `orchestrate.waves` - Wave computation
- `orchestrate.skill.list` - Available skills

**Mutate (5)**:
- `orchestrate.startup` - Initialize orchestration
- `orchestrate.spawn` - Generate spawn prompt
- `orchestrate.validate` - Validate spawn readiness
- `orchestrate.parallel.start` - Start parallel wave
- `orchestrate.parallel.end` - End parallel wave

### Research Operations (10 total)

**Query (6)**:
- `research.show` - Entry details
- `research.list` - List entries
- `research.query` - Search research
- `research.pending` - Pending entries
- `research.stats` - Statistics
- `research.manifest.read` - Read manifest

**Mutate (4)**:
- `research.inject` - Get protocol injection
- `research.link` - Link to task
- `research.manifest.append` - Append entry
- `research.manifest.archive` - Archive entries

### Lifecycle Operations (10 total)

**Query (5)**:
- `lifecycle.check` - Check prerequisites
- `lifecycle.status` - Current state
- `lifecycle.history` - Transition history
- `lifecycle.gates` - All gate statuses
- `lifecycle.prerequisites` - Required stages

**Mutate (5)**:
- `lifecycle.progress` - Record completion
- `lifecycle.skip` - Skip stage
- `lifecycle.reset` - Reset stage
- `lifecycle.gate.pass` - Mark gate passed
- `lifecycle.gate.fail` - Mark gate failed

### Validation Operations (11 total)

**Query (9)**:
- `validate.schema` - JSON Schema validation
- `validate.protocol` - Protocol compliance
- `validate.task` - Anti-hallucination check
- `validate.manifest` - Manifest check
- `validate.output` - Output validation
- `validate.compliance.summary` - Compliance summary
- `validate.compliance.violations` - List violations
- `validate.test.status` - Test status
- `validate.test.coverage` - Coverage metrics

**Mutate (2)**:
- `validate.compliance.record` - Record check
- `validate.test.run` - Run tests

### Release Operations (7 total)

**Mutate (7)**:
- `release.prepare` - Prepare release
- `release.changelog` - Generate changelog
- `release.commit` - Create commit
- `release.tag` - Create tag
- `release.push` - Push to remote
- `release.gates.run` - Run gates
- `release.rollback` - Rollback release

### System Operations (12 total)

**Query (5)**:
- `system.version` - CLEO version
- `system.doctor` - Health check
- `system.config.get` - Get config
- `system.stats` - Project statistics
- `system.context` - Context info

**Mutate (7)**:
- `system.init` - Initialize CLEO
- `system.config.set` - Set config
- `system.backup` - Create backup
- `system.restore` - Restore backup
- `system.migrate` - Run migrations
- `system.sync` - Sync with TodoWrite
- `system.cleanup` - Cleanup data

---

## Error Code Reference

| Range | Category | Count | Details |
|-------|----------|-------|---------|
| 0 | Success | 1 | [Success](api/errors.md#success) |
| 1-9 | General | 7 | [General Errors](api/errors.md#general-errors-1-9) |
| 10-19 | Hierarchy | 4 | [Hierarchy Errors](api/errors.md#hierarchy-errors-10-19) |
| 20-29 | Dependency | - | [Dependency Errors](api/errors.md#dependency-errors-20-29) |
| 30-39 | Session | 2 | [Session Errors](api/errors.md#session-errors-30-39) |
| 40-49 | Gate | 4 | [Gate Errors](api/errors.md#gate-errors-40-49) |
| 50-59 | Context | 3 | [Context Errors](api/errors.md#context-errors-50-59) |
| 60-70 | Protocol | 11 | [Protocol Violations](api/errors.md#protocol-violations-60-70) |
| 75-79 | Lifecycle | 5 | [Lifecycle Errors](api/errors.md#lifecycle-errors-75-79) |
| 100+ | Special | 2 | [Special Codes](api/errors.md#special-codes-100) |

---

## Protocol Reference

### RCSD-IVTR Lifecycle

```
SETUP (RCSD)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Research → Consensus → Specification → Decomposition
  (60)       (61)         (62)            (63)

EXECUTION (IVTR)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Implementation → Validation → Testing → Release
     (64)           (68)       (69/70)    (66)

CROSS-CUTTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Contribution (65)
```

**Exit Codes**:
- 60: Research violations
- 61: Consensus violations
- 62: Specification violations
- 63: Decomposition violations
- 64: Implementation violations
- 65: Contribution violations
- 66: Release violations
- 68: Validation violations
- 69: Tests skipped
- 70: Coverage insufficient

**See**: [Protocols Reference](api/protocols.md)

---

## Performance Guidelines

### Token Budget

| Approach | Tools | Tokens | % of 200K |
|----------|-------|--------|-----------|
| Flat CLI (65 commands) | 65 | ~32,500 | 16.3% |
| 8 Gateways | 8 | ~4,000 | 2.0% |
| **2 Gateways (MCP)** | **2** | **~1,800** | **0.9%** |

### Response Times

| Operation Type | Typical | Maximum |
|----------------|---------|---------|
| Simple queries | <50ms | 100ms |
| Complex queries | <200ms | 500ms |
| Write operations | <100ms | 300ms |
| Validation | <100ms | 500ms |

### Rate Limits

- Query operations: 100/minute
- Mutate operations: 30/minute
- Spawn operations: 10/minute

---

## Additional Resources

### External Links

- [MCP Specification](https://modelcontextprotocol.io/specification)
- [CLEO GitHub Repository](https://github.com/keatonb/cleo)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

### Internal References

- [MCP Server Specification](../../docs/specs/MCP-SERVER-SPECIFICATION.md)
- [Project Lifecycle Spec](../../docs/specs/PROJECT-LIFECYCLE-SPEC.md)
- [RCSD Pipeline Spec](../../docs/specs/RCSD-PIPELINE-SPEC.md)
- [Protocol Enforcement Guide](../../docs/guides/protocol-enforcement.md)

---

## Version History

### v1.1.0 (2026-02-10)

- Updated operation totals to match deployed gateway registries (56 query + 51 mutate)
- Added canonical/source-of-truth note for operation matrix maintenance

### v1.0.0 (2026-02-04)

- Initial documentation release
- Complete API reference (96 operations)
- Error code reference (1-100)
- Protocol documentation (60-70)
- Examples and guides
