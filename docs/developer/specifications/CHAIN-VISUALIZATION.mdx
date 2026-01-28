# Chain Visualization Specification

**Version**: 1.0.0
**Status**: ACTIVE
**Effective**: v0.42.0+
**Last Updated**: 2025-12-30

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [BCP 14](https://www.rfc-editor.org/info/bcp14) [[RFC2119](https://www.rfc-editor.org/rfc/rfc2119)] [[RFC8174](https://www.rfc-editor.org/rfc/rfc8174)] when, and only when, they appear in all capitals.

---

## Preamble

This specification defines how dependency chains are computed and visualized in cleo's `analyze --human` output. It establishes the immutable principle that chains are a **visualization concern**, not a data model concern.

> **Cross-reference**: [TASK-HIERARCHY-SPEC.md](TASK-HIERARCHY-SPEC.md) Part 8 provides the architectural context. This spec provides complete visualization requirements.

---

## Executive Summary

### Core Principle

> **IMMUTABLE**: Store EDGES (`depends[]`), Compute PATHS (chains).

Dependency chains are COMPUTED at render time from the task dependency graph. They are NEVER stored in the schema. This design provides:

- **Zero sync burden**: Chains automatically update as tasks complete
- **Zero redundancy**: All chain data is derivable from `depends[]`
- **Zero schema complexity**: No additional fields to maintain

### What LLM Agents Use Instead

| Need | Use This | NOT This |
|------|----------|----------|
| Execution order | `executionPlan.waves[]` | Named chains |
| Longest blocking path | `executionPlan.criticalPath` | Chain status |
| Ready tasks | `inventory.ready[]` | Chain progress |
| Blocked tasks | `inventory.blocked[].waitingOn` | Chain membership |
| Work distribution | Multi-session scopes | Chain claiming |

Chains add ZERO decision utility for LLM agents. They are purely a human-readable presentation of the dependency graph.

---

## Part 1: Core Principle

### 1.1 Immutable Architectural Decision

The system MUST NOT store chain data in the schema. This decision is IMMUTABLE.

**Rationale**:
- Chains are derived views, not primary abstractions
- Storing chains creates sync burden when tasks complete
- `depends[]` edges contain all information needed to derive chains
- Waves and criticalPath provide all agent-needed execution information

### 1.2 What Is Stored vs Computed

| Data | Storage | Purpose |
|------|---------|---------|
| `task.depends[]` | STORED | Edge list defining dependencies |
| `executionPlan.waves[]` | COMPUTED | Parallel execution groups |
| `executionPlan.criticalPath` | COMPUTED | Longest blocking path |
| Chains | COMPUTED at render time | Human visualization only |

### 1.3 Design Implications

Implementations MUST:
- Compute chains fresh on each `--human` output request
- NOT cache chain data between requests
- NOT add chain-related fields to the schema
- NOT include chains in JSON output

---

## Part 2: Chain Definition

### 2.1 What Is a Chain

A **dependency chain** is a connected component in the task dependency graph, scoped to a specific epic or task subtree.

| Term | Definition |
|------|------------|
| **Chain** | A connected subgraph of tasks sharing dependency relationships |
| **Root** | A task within a chain with no dependencies inside that chain |
| **Independent chains** | Disjoint connected components (no shared tasks) |
| **Chain membership** | All tasks reachable from a root via dependency edges (bidirectional) |

### 2.2 Chain Identification

Chains MUST be identified by their root task's ID, using the format:

| Context | Format | Example |
|---------|--------|---------|
| Programmatic reference | `chain-T{root_id}` | `chain-T1022` |
| Human output label | Letter (A, B, C) | `CHAIN A:` |
| Human output description | Generated from root title | `"Fix session end..." (6 tasks)` |

### 2.3 Multiple Roots

A single chain MAY have multiple roots if tasks at the same depth have no in-scope dependencies. The system MUST:
- Use the lowest task ID as the primary root for labeling
- Include all roots in the chain's metadata

---

## Part 3: Chain Detection Algorithm

### 3.1 Algorithm Overview

The system MUST use connected component detection to identify chains:

1. **Build bidirectional adjacency**: Treat directed `depends[]` edges as undirected for component detection
2. **Find connected components**: Use BFS/DFS or Union-Find algorithm
3. **Identify roots**: For each component, find tasks with no in-scope dependencies
4. **Label deterministically**: Sort by lowest root ID, assign A, B, C...

### 3.2 Scope Filtering

Chain detection MUST respect the analysis scope:

| Scope Type | Behavior |
|------------|----------|
| Epic-scoped (`--parent T001`) | Only consider tasks within epic and descendants |
| Phase-scoped | Only consider tasks in specified phase |
| Project-wide | Consider all non-done tasks |

Dependencies to tasks OUTSIDE the scope MUST be treated as satisfied (not blocking).

### 3.3 Component Detection Requirements

The algorithm MUST:
- Find ALL connected components in a single pass
- Handle graphs with any number of components (including 1)
- Handle isolated tasks (single-task chains) correctly
- Be deterministic (same input always produces same output)

### 3.4 Root Detection Requirements

For each connected component, roots MUST be identified as tasks where:
- `depends[]` is empty, OR
- All dependencies are outside the scoped task set, OR
- All dependencies have `status: "done"`

---

## Part 4: Output Formats

### 4.1 JSON Output (NO Chains)

The JSON output MUST NOT include chain data:

```bash
cleo analyze --parent T998           # JSON output, NO chains field
```

Agents MUST use:
- `executionPlan.waves[]` for parallel work groups
- `executionPlan.criticalPath` for longest blocking path
- `inventory.ready[]` and `inventory.blocked[]` for task status

### 4.2 Human Output (Chain Visualization)

The `--human` output MUST include chain visualization:

```bash
cleo analyze --parent T998 --human   # Shows chain visualization
```

Human output MUST include:
1. Phase headers with progress
2. Wave groupings within phases
3. Task listings with status indicators
4. Chain summary section at bottom

### 4.3 Chain Summary Format

The chain summary section MUST appear at the end of `--human` output and include:

| Element | Requirement |
|---------|-------------|
| Chain label | Letter ID (A, B, C) |
| Chain description | Generated from root task title (truncated) |
| Task count | Total tasks in chain |
| Linear path | Status-annotated task sequence |

---

## Part 5: Visualization Requirements

### 5.1 Phase Structure

Human output MUST organize content by phase:

| Element | Format |
|---------|--------|
| Phase header | Uppercase phase name, status icon, progress count |
| Phase separator | Visual separator between phases |
| Phase status | Derived from task completion (complete/in_progress/pending/blocked) |

### 5.2 Wave Structure

Within each phase, tasks MUST be grouped by wave:

| Element | Format |
|---------|--------|
| Wave label | Wave number (0, 1, 2...) |
| Task listing | Status icon, task ID, task title |
| Dependency indication | Reference to blocking tasks |

### 5.3 Status Indicators

The system MUST use consistent status indicators:

| Status | Indicator |
|--------|-----------|
| `done` | Checkmark or completion symbol |
| `active` | In-progress indicator |
| `blocked` | Blocked indicator |
| `pending` | Pending/waiting indicator |

### 5.4 Chain Summary Structure

The chain summary at the end MUST show:
1. Each chain with its letter label
2. Root task reference and chain description
3. Linear task sequence with status indicators
4. Task count per chain

---

## Part 6: Edge Cases

### 6.1 Circular Dependencies

If circular dependencies exist:
- The system MUST detect them
- The system SHOULD warn the user
- Cyclic tasks MAY be treated as Wave 0 or marked as errors
- Chain detection MUST still complete (cycles form single component)

### 6.2 Single-Task Chains

A chain with only one task is valid. The system MUST:
- Label it like any other chain
- Include it in the chain summary
- Indicate it has no dependencies

### 6.3 Cross-Phase Chains

Chains MAY span multiple phases. The system MUST:
- Show tasks in their respective phase sections
- Maintain chain membership in the summary
- Correctly trace the full chain path

### 6.4 Empty Scope

If the scoped task set is empty or contains only completed tasks:
- The system MUST NOT error
- The system SHOULD display an appropriate message
- Chain summary MAY be omitted

---

## Part 7: CLI Requirements

### 7.1 Required Flags

The `analyze` command MUST support:

| Flag | Description |
|------|-------------|
| `--parent <id>` | Scope analysis to epic and descendants |
| `--human` | Enable human-readable output with chains |

### 7.2 Default Behavior

| Context | Output Format |
|---------|---------------|
| TTY (interactive) | MAY default to human output |
| Piped/non-TTY | MUST default to JSON output |

### 7.3 Combination with Other Flags

The `--human` flag SHOULD work with:
- `--parent <id>` for epic-scoped analysis
- `--phase <name>` for phase-filtered analysis
- Other analysis flags as appropriate

---

## Part 8: Rendering Pipeline

### 8.1 Pipeline Stages

The rendering pipeline MUST follow these stages:

1. **Scope Filter**: Get epic and all descendants
2. **Compute Waves**: Calculate wave depth for each task
3. **Find Chains**: Detect connected components
4. **Group**: Organize by phase, then wave
5. **Layout**: Determine visual positions
6. **Render**: Generate ASCII output

### 8.2 Data Enrichment

During rendering, tasks MUST be enriched with computed fields:

| Field | Purpose |
|-------|---------|
| `_wave` | Computed dependency depth |
| `_chain` | Chain membership (A, B, C) |
| `_isRoot` | Whether task is a chain root |

These fields are NEVER stored in the schema.

### 8.3 Performance Requirements

The system MUST:
- Complete chain detection in O(V + E) time where V = tasks, E = dependencies
- Handle epics with 100+ tasks without noticeable delay
- NOT perform redundant computation for repeated requests

---

## Appendix A: Decision Rationale

| Decision | Alternatives Considered | Why Chosen |
|----------|------------------------|------------|
| Computed chains | Stored `dependencyChains[]` field | Sync burden, redundancy, zero agent utility |
| BFS/connected components | Following `depends[]` edges only | Bidirectional gives true components |
| Letters (A, B, C) | Named chains | Deterministic, no semantic loading |
| Root-based identification | Entry-point based | Deterministic, verifiable |

## Appendix B: Rejected Alternatives

| Alternative | Why Rejected |
|-------------|--------------|
| Storing chain names in schema | Creates sync burden, adds maintenance, zero agent value |
| Including chains in JSON output | Agents should use waves/criticalPath instead |
| User-defined chain names | Semantic loading, maintenance burden |
| Chain progress tracking | Derived from member task status already |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-12-30 | Initial specification. Consolidates T1028-Subgraph-Detection-Algorithm-ASCII-Render.md, T1028-DependencyChain-Core-Insights.md, and T1028-DEFINITIVE-WORK-MAP.md consensus. |

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| **[SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md)** | **AUTHORITATIVE** for specification standards |
| **[TASK-HIERARCHY-SPEC.md](TASK-HIERARCHY-SPEC.md)** | **AUTHORITATIVE** for task hierarchy; Part 8 provides architectural context |
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | LLM-first design principles |
| **[CHAIN-VISUALIZATION-IMPLEMENTATION-REPORT.md](CHAIN-VISUALIZATION-IMPLEMENTATION-REPORT.md)** | Tracks implementation status |

### Design References

| Document | Purpose |
|----------|---------|
| `claudedocs/T1028-DEFINITIVE-WORK-MAP.md` | Consensus decisions source |
| `claudedocs/T1028-Subgraph-Detection-Algorithm-ASCII-Render.md` | Algorithm implementation reference |
| `claudedocs/T1032-WAVE-COMPUTATION-ALGORITHM.md` | Wave computation algorithm |

---

*End of Specification*
