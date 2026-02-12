---
title: "CAAMP Integration Gap Analysis"
version: "1.0.0"
status: "complete"
created: "2026-02-11"
updated: "2026-02-11"
authors: ["CLEO Development Team"]
task: "T4332"
---

# CAAMP Integration Gap Analysis

**Task**: T4332
**Date**: 2026-02-11
**Status**: Complete
**Context**: Post-v0.91.0 (MCP Native Engine shipped), CAAMP v0.3.0 live on npm

---

## 1. Executive Summary

The CLEO-CAAMP Integration spec catalogs 191 functions across CLEO's Bash codebase. Of these, 131 are tagged "pending" for CAAMP replacement, 60 are "N/A" (CLEO-only orchestration logic). This analysis evaluates how the MCP native engine (T4334, shipped v0.91.0) changes the picture, what truly needs CAAMP, and what can be deferred.

**Key findings:**

- The MCP native engine and CAAMP are **complementary, not competing**. They cover entirely different domains with zero functional overlap.
- **0 of the 131 pending functions are addressed by the native engine.** The engine covers task CRUD, sessions, config, and validation -- domains that were always CLEO-only. CAAMP covers provider registry, MCP config management, skills lifecycle, and instruction injection -- domains the engine does not touch.
- **All 131 pending CAAMP functions are now UNBLOCKED** -- T4341 resolved, CAAMP v0.3.0 published to npm (88 exports, Node >=20).
- Only **~20 functions are P0** for MCP-first agent workflow. The rest support the Bash-to-TypeScript migration (Track A/B) or are nice-to-have.

---

## 2. Complementarity Analysis: Native Engine vs CAAMP

### 2.1 Domain Mapping

| Domain | MCP Native Engine (T4334) | CAAMP v0.3.0 | Overlap |
|--------|--------------------------|--------------|---------|
| **Task CRUD** | taskShow, taskList, taskFind, taskCreate, taskUpdate, taskComplete, taskDelete, taskArchive | -- | None |
| **Sessions** | sessionStart, sessionEnd, sessionStatus, sessionList, focusGet, focusSet, focusClear | -- | None |
| **Config (CLEO)** | configGet, configSet | -- | None |
| **Validation** | validateSchema, validateTask, validation-rules | -- | None |
| **File I/O** | store.ts (atomic write, locking, backup) | readConfig, writeConfig (multi-format) | **Conceptual** |
| **Schema** | schema-validator.ts (Ajv) | -- | None |
| **ID Generation** | generateNextId, collectAllIds | -- | None |
| **Init** | initProject, ensureInitialized, getVersion | -- | None |
| **Capability Matrix** | getOperationMode, canRunNatively | -- | None |
| **Provider Registry** | -- | getAllProviders, getProvider, resolveAlias, detectProvider (46 providers) | None |
| **MCP Config Mgmt** | -- | installMcpServer, listMcpServers, removeMcpServer, buildServerConfig | None |
| **Skills Lifecycle** | -- | installSkill, removeSkill, discoverSkills, validateSkill, parseSkillFile | None |
| **Skills Versioning** | -- | recordSkillInstall, getTrackedSkills, checkSkillUpdate | None |
| **Instruction Injection** | -- | inject, checkInjection, injectAll, generateInjectionContent | None |
| **Marketplace** | -- | MarketplaceClient.search, MarketplaceClient.getSkill | None |
| **Source Parsing** | -- | parseSource, isMarketplaceScoped | None |
| **MCP Lock** | -- | readLockFile, recordMcpInstall, getTrackedMcpServers | None |

### 2.2 Summary

The native engine handles **CLEO's core business logic**: tasks, sessions, config, validation, file safety. CAAMP handles **cross-provider infrastructure**: which AI agents exist, how to configure them, how to install skills to them, how to inject instructions into them. These are **entirely separate concerns** with different data models, different consumers, and different purposes.

The one area of conceptual overlap is file I/O: the native engine's `store.ts` provides atomic JSON file operations, while CAAMP's `readConfig`/`writeConfig` provides multi-format config I/O (JSONC, YAML, TOML). These operate on different files for different purposes. `store.ts` manages `todo.json`, `todo-log.json`, `sessions.json`; CAAMP manages `claude_desktop_config.json`, `.cursor/mcp.json`, `opencode.json`, etc.

### 2.3 Architectural Relationship

```
┌────────────────────────────────────────────────────────────┐
│                     CLEO MCP Server                        │
│                                                            │
│  ┌──────────────────────┐  ┌────────────────────────────┐  │
│  │  Native Engine       │  │  CAAMP Integration Layer   │  │
│  │  (T4334 - shipped)   │  │  (T4342 - pending)         │  │
│  │                      │  │                            │  │
│  │  - Task CRUD         │  │  - Provider registry       │  │
│  │  - Session mgmt      │  │  - MCP config read/write   │  │
│  │  - CLEO config       │  │  - Skills install/discover │  │
│  │  - Schema validation │  │  - Instruction injection   │  │
│  │  - Atomic file I/O   │  │  - Marketplace client      │  │
│  │  - ID generation     │  │  - Multi-format I/O        │  │
│  └──────────────────────┘  └────────────────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  CLI Adapter (Bash fallback for advanced ops)        │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

---

## 3. Gap Assessment: 191 Functions Analyzed

### 3.1 By-the-Numbers

| Category | Count | Addressed by Native Engine? | Requires CAAMP? |
|----------|-------|-----------------------------|-----------------|
| Provider Registry (agent-registry.sh) | 27 pending | No | Yes |
| Provider Config (agent-config.sh) | 23 pending + 4 N/A | No | Yes (23 of 27) |
| MCP Configuration (mcp-config.sh) | 28 pending | No | Yes |
| Skills Install (skills-install.sh) | 7 pending | No | Yes |
| Skills Discovery (skill-discovery.sh) | 7 pending | No | Yes |
| Skills Validation (skill-validate.sh) | 10 pending | No | Yes |
| Skills Versioning (skills-version.sh) | 8 pending | No | Yes |
| Skills Marketplace (skillsmp.sh) | 5 pending | No | Yes |
| Injection Constants (injection-registry.sh) | 5 pending + 3 N/A | No | Yes |
| Injection Config (injection-config.sh) | 5 pending + 1 N/A | No | Yes |
| Injection Core (injection.sh) | 6 pending | No | Yes |
| Skill Dispatch (skill-dispatch.sh) | 24 N/A | N/A | N/A (CLEO-only) |
| Token Injection (token-inject.sh) | 19 N/A | N/A | N/A (CLEO-only) |
| Subagent Injection (subagent-inject.sh) | 8 N/A | N/A | N/A (CLEO-only) |
| Orchestrator Spawn | 1 N/A | N/A | N/A (CLEO-only) |
| **TOTALS** | **131 pending, 60 N/A** | **0 addressed** | **131 require CAAMP** |

### 3.2 Conclusion

**Zero** of the 131 pending functions are addressed by the MCP native engine. The native engine and CAAMP integration are entirely orthogonal work streams. All 131 functions require CAAMP to proceed.

---

## 4. Priority Triage

### 4.1 P0: Needed NOW for MCP-First Agent Workflow (~20 functions)

These functions are needed to enable the MCP server to serve multi-provider agent workflows -- the core value proposition of CAAMP integration.

| # | Function | Source | CAAMP Replacement | Reason |
|---|----------|--------|-------------------|--------|
| 1 | `ar_load_registry` | agent-registry.sh | `getAllProviders` | Core: know which agents exist |
| 2 | `ar_get_agent` | agent-registry.sh | `getProvider` | Core: get provider details |
| 3 | `ar_agent_exists` | agent-registry.sh | `getProvider` + check | Core: provider existence check |
| 4 | `ar_list_installed` | agent-registry.sh | `getInstalledProviders` | Core: which agents are installed |
| 5 | `ar_is_installed` | agent-registry.sh | `detectProvider` | Core: detect specific provider |
| 6 | `ar_get_instruction_file` | agent-registry.sh | `Provider.instructFile` | Injection: target file |
| 7 | `ar_get_instruction_files` | agent-registry.sh | `getInstructionFiles` | Injection: all targets |
| 8 | `injection_update` | injection.sh | `inject` | Core: update injection blocks |
| 9 | `injection_check` | injection.sh | `checkInjection` | Core: check injection status |
| 10 | `injection_check_all` | injection.sh | `checkAllInjections` | Core: check all providers |
| 11 | `injection_update_all` | injection.sh | `injectAll` | Core: update all providers |
| 12 | `mcp_detect_tool` | mcp-config.sh | `detectProvider` | MCP: detect a provider |
| 13 | `mcp_detect_all_tools` | mcp-config.sh | `detectAllProviders` | MCP: detect all providers |
| 14 | `mcp_write_config` | mcp-config.sh | `installMcpServer` | MCP: install server config |
| 15 | `mcp_generate_entry` | mcp-config.sh | `buildServerConfig` | MCP: generate config entry |
| 16 | `_mcp_get_config_path` | mcp-config.sh | `resolveConfigPath` | MCP: find config file |
| 17 | `normalize_agent_id` | agent-config.sh | `resolveAlias` | Lookup: resolve aliases |
| 18 | `injection_has_block` | injection-config.sh | `checkInjection` | Status: injection present? |
| 19 | `INJECTION_TARGETS` | injection-registry.sh | `getAllProviders().map(...)` | Config: target list |
| 20 | `INJECTION_MARKER_START` | injection-registry.sh | `"<!-- CAAMP:START -->"` | Config: marker constant |

**Rationale**: These 20 functions enable the MCP server to: (a) detect which AI agents are installed, (b) read/write MCP configs to those agents, and (c) manage instruction injection across all providers. This is the P0 integration surface.

### 4.2 P1: Needed for Track A lib/ Refactor (~50 functions)

Track A (T4344) reorganizes `lib/` into semantic subdirectories. During this refactor, having TypeScript replacements for the 50 provider-property-accessor functions (all the `ar_get_*`, `_mcp_*`, `get_agent_*` property lookups) would allow consolidating them into a single TypeScript adapter layer. However, Track A can proceed without CAAMP by simply moving the Bash files.

| Domain | Count | Functions |
|--------|-------|-----------|
| Provider Registry property accessors | 17 | ar_get_global_dir, ar_get_project_dir, ar_get_display_name, ar_get_vendor, ar_get_priority, ar_get_status, etc. |
| Agent Config property accessors | 13 | get_agent_dir, get_agent_config_file, get_agent_skills_dir, get_agent_display_name, etc. |
| MCP Config property accessors | 10 | _mcp_display_name, _mcp_format, _mcp_config_key, _mcp_binary, _mcp_config_dir, etc. |
| Agent list/enumerate | 10 | ar_list_agents, ar_list_by_tier, get_all_agents, get_agents_by_tier, ar_list_agents_json, etc. |

**Verdict**: Track A does NOT depend on CAAMP. These functions would be nice to replace during the refactor, but they can be moved as-is and replaced later.

### 4.3 P2: Needed for Track B Manifest Hierarchy (~0 functions)

Track B (T4352) focuses on MANIFEST.jsonl schema extension and tree-aware queries. This is entirely within CLEO's task/research domain and has **zero dependency on CAAMP**. None of the 131 CAAMP-replaceable functions relate to manifest hierarchy.

### 4.4 P3: Nice-to-Have, Full V2 Conversion (~61 functions)

The remaining functions are the bulk of the skills lifecycle (install, discovery, validation, versioning, marketplace) and the MCP format-specific merge functions. These are needed for a full TypeScript conversion of CLEO's agent management layer but are not needed for the current MCP-first workflow.

| Domain | Count | Why P3 |
|--------|-------|--------|
| Skills Install | 7 | Skills installation is CLI-facing, not MCP-facing |
| Skills Discovery | 7 | Discovery is CLI-facing |
| Skills Validation | 10 | Validation is CLI-facing |
| Skills Versioning | 8 | Version tracking is CLI-facing |
| Skills Marketplace | 5 | Marketplace is CLI-facing |
| MCP format merges | 14 | Covered by installMcpServer internally |
| Injection config detail | 5 | Covered by P0 injection functions |
| Misc remaining | 5 | Lock file, backup, template details |

### 4.5 N/A: Already Handled or Not Applicable (60 functions)

These 60 functions are CLEO-only orchestration logic (skill dispatch, token injection, subagent protocol injection, orchestrator spawn) that was correctly identified as staying in Bash. The native engine does not replace these and CAAMP does not touch them.

### 4.6 Triage Summary

| Priority | Count | Description | Blocked on CAAMP? |
|----------|-------|-------------|--------------------|
| **P0** | 20 | MCP-first agent workflow (provider detection, injection, MCP config) | **UNBLOCKED** (T4341 resolved, v0.3.0 on npm) |
| **P1** | 50 | Track A lib/ refactor property accessors | No (Track A proceeds without CAAMP) |
| **P2** | 0 | Track B manifest hierarchy | No |
| **P3** | 61 | Full V2 conversion (skills, marketplace, format merges) | **UNBLOCKED** (T4341 resolved, v0.3.0 on npm) |
| **N/A** | 60 | CLEO-only orchestration (stays in Bash) | No |
| **Total** | 191 | | |

---

## 5. Blocker Status

### 5.1 CAAMP npm Publish (T4341) -- RESOLVED

- **Status**: RESOLVED. CAAMP v0.3.0 published to npm (2026-02-11). 88 exports, Node >=20.
- **Impact**: All 131 CAAMP-dependent functions are now UNBLOCKED.
- **Resolution**: `npm info @cleocode/caamp versions` confirms v0.1.0 and v0.3.0 available.
- **Next step**: Proceed to T4342 (add `@cleocode/caamp ^0.3.0` to mcp-server/package.json).

### 5.2 What Can Proceed Without CAAMP

| Work Item | Depends on CAAMP? | Status |
|-----------|--------------------|--------|
| Track A: lib/ hierarchy refactor (T4344) | No | Ready for execution |
| Track B: manifest hierarchy (T4352) | No | Queued after Track A |
| MCP native engine expansion (more native ops) | No | Continuous |
| Progressive disclosure implementation | No | Queued |
| MCP-first injection doc updates | No | Queued |
| CLEO-only orchestration (dispatch, tokens, protocols) | No | Active in Bash |

### 5.3 What Is Now Unblocked

| Work Item | Previous Blocker | Status |
|-----------|------------------|--------|
| T4341 (npm publish) | Human action in CAAMP repo | **RESOLVED** -- v0.3.0 published |
| T4342 (add caamp dependency) | T4341 | **READY** -- can proceed immediately |
| T4343 (shared module extraction) | T4342 + T4334 | Unblocked once T4342 completes |
| P0 integration (20 functions) | T4342 | Unblocked once T4342 completes |
| P3 full V2 conversion (61 functions) | T4342 | Unblocked once T4342 completes |

### 5.4 Git Dependency as Interim?

**No longer applicable.** T4341 is resolved -- CAAMP v0.3.0 is published to npm. Use `@cleocode/caamp ^0.3.0` as a standard npm dependency.

---

## 6. Integration Architecture Recommendation

### 6.1 Options Evaluated

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A: CAAMP as mcp-server dependency** | `mcp-server/package.json` depends on `@cleocode/caamp` | Simple, direct import | Bumps Node >=20, couples server to CAAMP releases |
| **B: CAAMP as peer dependency of future TS CLI** | CAAMP used only by a hypothetical `cleo-ts-cli` package | Decouples server | Deferred indefinitely since TS CLI is aspirational (T2021) |
| **C: Extract native engine INTO caamp** | Move store.ts, schema-validator.ts into CAAMP | Shared foundation | Wrong direction -- CAAMP is provider-focused, not task-focused |
| **D: Shared foundation package** | New `@cleocode/core` with file ops, schema, config | Clean separation | Over-engineering at this stage |

### 6.2 Recommendation: Option A (CAAMP as mcp-server dependency)

**Add `@cleocode/caamp` as a direct dependency of `mcp-server/package.json`.**

Rationale:

1. **Immediate value**: The MCP server is the active TypeScript surface. Making CAAMP available there enables P0 integration immediately.
2. **Node >=20 is acceptable**: Node 18 reaches EOL 2025-04-30 (already EOL). Bumping to >=20 is a good practice regardless of CAAMP.
3. **Clear dependency direction**: MCP server depends on CAAMP for provider/skills/injection. CAAMP does NOT depend on the MCP server. No circular dependency.
4. **T4343 can proceed later**: Evaluating shared module extraction is independent of the dependency direction. If store.ts proves useful to CAAMP, it can be contributed upstream later.
5. **Matches existing plan**: T4342 already tracks this exact action.

### 6.3 Architecture After Integration

```
@cleocode/caamp (npm package)
    ├── Provider registry (46 providers)
    ├── MCP config management
    ├── Skills lifecycle
    ├── Instruction injection
    └── Multi-format I/O

        ▲ imported by

mcp-server (CLEO MCP server)
    ├── Native engine (task/session/config/validation)
    ├── CAAMP adapter layer (wraps CAAMP for CLEO-specific needs)
    ├── CLI adapter (Bash fallback)
    └── MCP gateway (cleo_query / cleo_mutate)
```

### 6.4 Node.js Engine Bump

Bumping `mcp-server` from `>=18` to `>=20` is recommended regardless of CAAMP:

- Node 18 is already past EOL (April 2025)
- Node 20 is the current LTS (active until April 2026)
- Node 22 is the current stable
- No known compatibility issues with the existing codebase

---

## 7. Implementation Roadmap

### 7.1 Phase 0: Unblock (T4341) -- COMPLETE

- ~~Publish CAAMP to npm~~ -- DONE: v0.3.0 published (88 exports, Node >=20)
- ~~Verify package integrity~~ -- DONE: `npm info @cleocode/caamp versions` confirms v0.3.0

### 7.2 Phase 1: P0 Integration (T4342 + new tasks)

- Add `@cleocode/caamp ^0.3.0` to `mcp-server/package.json`
- Bump engine to `>=20`
- Create thin adapter: `mcp-server/src/providers/caamp-adapter.ts`
- Implement P0 functions: provider detection, injection management, MCP config
- Wire into MCP gateway as new domain operations (e.g., `providers.list`, `providers.detect`)

### 7.3 Phase 2: Track A + P1 Consolidation (T4344)

- Execute lib/ hierarchy refactor (Bash-only, no CAAMP dependency)
- During refactor, identify Bash files that can be thinned by delegating to CAAMP adapter
- Consolidate 50 property-accessor functions into CAAMP-backed adapter

### 7.4 Phase 3: P3 Full Migration (Post Track A/B)

- Skills lifecycle TypeScript conversion
- Marketplace TypeScript conversion
- Complete elimination of provider-related Bash functions
- Evaluate T4343 shared module extraction

---

## 8. Created Tasks

The following tasks should be created to track the highest-priority gaps identified in this analysis:

1. **P0 Integration Adapter**: Create CAAMP adapter layer in mcp-server for P0 functions (depends T4342)
2. **MCP Provider Domain**: Add `providers` domain to MCP gateway with list/detect/inject operations (depends on adapter)
3. **Node.js Engine Bump**: Bump mcp-server engine requirement from >=18 to >=20

---

## 9. References

| Document | Path |
|----------|------|
| CAAMP Integration Spec | `docs/specs/CLEO-CAAMP-INTEGRATION.md` |
| Path Forward | `docs/specs/CLEO-PATH-FORWARD-2026Q1.md` |
| MCP Agent Interaction | `docs/specs/MCP-AGENT-INTERACTION-SPEC.md` |
| CAAMP Dependency Analysis | `claudedocs/agent-outputs/caamp-dependency-analysis.md` |
| Native Engine | `mcp-server/src/engine/index.ts` |
| Epic | T4332 |
| CAAMP npm publish blocker | T4341 (RESOLVED) |
| CAAMP dependency addition | T4342 |
| Shared module extraction | T4343 |
