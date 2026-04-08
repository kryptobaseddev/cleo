# Wave 0.5 — Full CANT Grammar Blueprint

**Status**: READY FOR PICKUP
**Source**: feature-dev:code-architect agent (session 2026-04-08)
**Supersedes**: none (prior Wave 0 minimum shipped in commit `e52559d7` covered only the `DocumentKind` enum + frontmatter parse arms)
**Canonical plan**: `docs/plans/CLEO-ULTRAPLAN.md` §8, §9, §10, §12

This blueprint captures the detailed implementation plan produced by the code-architect during the 2026-04-08 orchestrator session. It covers everything the Wave 0 minimum **did not** ship: the `team` and `tool` block parsers, the `AgentDef` extensions for `role`/`tier`/`context_sources`/`mental_model`, the permission glob syntax, and all 8 lint rules (TEAM-001..003, TIER-001..002, JIT-001, MM-001..002).

**Next session's engineering-lead**: read this in full, decompose into worker tasks per the "Worker Execution Order" section, dispatch workers.

---

## 1. Patterns & Conventions Found

All references are to `/mnt/projects/cleocode/crates/cant-core/src/`.

- `dsl/ast.rs:28-43` — `DocumentKind` enum, `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]` (extended in commit `e52559d7` to 13 variants)
- `dsl/ast.rs:112-124` — `Spanned<T>` generic, exact field names `value` + `span`
- `dsl/ast.rs:95-108` — `AgentDef` struct: `name: Spanned<String>`, `properties: Vec<Property>`, `permissions: Vec<Permission>`, `context_refs: Vec<ContextRef>`, `hooks: Vec<HookDef>`, `span: Span`
- `dsl/skill.rs:20-103` — canonical minimal block parser pattern (prefix strip, `collect_block`, property loop, span calculation)
- `dsl/agent.rs:80-116` — multi-sub-block parser pattern (permissions, context, hooks as named sub-blocks)
- `dsl/permission.rs:19-73` — permission line parser: domain split on `:`, comma-split access values, validates against closed set
- `dsl/frontmatter.rs:131-143` — `parse_document_kind` match arm pattern
- `dsl/mod.rs:144-245` — `parse_document` dispatcher: prefix-match on `content_str`, calls typed parser, wraps in `Section::` variant
- `validate/hooks.rs:16-23` — `check_all` fan-out pattern, individual rule functions returning `Vec<Diagnostic>`
- `validate/diagnostic.rs:56-93` — `Diagnostic::error/warning/info` constructors
- `validate/scope/names.rs:1-228` — walking `Section` match arms, consulting/populating `ValidationContext`
- `validate/mod.rs:30-58` — orchestrator calls each domain's `check_all(doc, &ctx)` in order
- No test fixture files exist yet — all existing tests are inline `#[cfg(test)]` blocks within each `.rs` file

The prototype at `~/.agents/agents/cleo-subagent/cleo-subagent.cant` uses: `role:`, `tier:`, `tools:` (sub-block), `domains:`, `gateways:`, `tokens:`, `constraints [tag]:`, `anti_patterns:`, and multi-line `tools:` with nested array properties. It does NOT yet use `context_sources:` or `mental_model:` in the ULTRAPLAN §9.2 form — those are new. It does NOT use `team` or `tool` top-level blocks.

---

## 2. Files to Create

| File | Purpose |
|------|---------|
| `crates/cant-core/src/dsl/team.rs` | Parser for `team Name:` blocks → `TeamDef` |
| `crates/cant-core/src/dsl/tool.rs` | Parser for `tool Name:` blocks → `ToolDef` |
| `crates/cant-core/src/validate/hierarchy.rs` | Lint rules TEAM-001..003, TIER-001..002, JIT-001, MM-001..002 |
| `crates/cant-core/tests/fixtures/team-platform.cant` | Team fixture |
| `crates/cant-core/tests/fixtures/tool-dispatch.cant` | Tool fixture |
| `crates/cant-core/tests/fixtures/jit-backend-dev.cant` | JIT agent fixture |

---

## 3. Files to Modify

| File | Change Summary |
|------|---------------|
| `src/dsl/ast.rs` | Add `TeamDef`, `ToolDef`, `GlobPermission` structs; add `Section::Team` and `Section::Tool` variants; add `context_sources` and `mental_model` fields to `AgentDef`; add `globs` field to `Permission` |
| `src/dsl/permission.rs` | Extend parser to recognize `files: write[glob, glob]` syntax; add `globs_patterns` to `Permission` |
| `src/dsl/agent.rs` | Add sub-block dispatch branches for `context_sources:` and `mental_model:` headers; store as `Vec<Property>` in the new `AgentDef` fields |
| `src/dsl/mod.rs` | Declare `pub mod team` and `pub mod tool`; add `team` and `tool` dispatcher branches in `parse_document`; update unknown-construct error message |
| `src/validate/mod.rs` | Declare `pub mod hierarchy`; add `diags.extend(hierarchy::check_all(doc, &ctx))` call |
| `src/validate/scope/names.rs` | Extend `check_unique_names` to track `Section::Team` and `Section::Tool` names in `ValidationContext` |
| `src/validate/context.rs` | Add `defined_teams: HashMap<String, Span>` and `defined_tools: HashMap<String, Span>`; initialize in `new()`; include in `is_name_defined` |

---

## 4. New Type Definitions

### 4.1 `TeamDef` struct (ast.rs, after `SkillDef`)

```rust
/// A team definition block (`team Name:`).
///
/// ```cant
/// team platform:
///   orchestrator: cleo-prime
///   leads:
///     engineering: engineering-lead
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamDef {
    /// The team name identifier.
    pub name: Spanned<String>,
    /// Key-value properties (description, enforcement, routing, etc.).
    pub properties: Vec<Property>,
    /// Span covering the entire team definition.
    pub span: Span,
}
```

**Design rationale**: leads/workers/routing sub-blocks are heterogeneous key→value or key→array maps. Represent them uniformly as `Vec<Property>` to stay DRY with the existing `Property`/`Value::Array` machinery. The lint rules inspect `properties` by key to enforce TEAM-* rules — no extra struct is required at parse time.

### 4.2 `ToolDef` struct (ast.rs, after `TeamDef`)

```rust
/// A tool definition block (`tool Name:`).
///
/// ```cant
/// tool dispatch_worker:
///   description: "Spawn a worker subagent"
///   schema: { ... }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    /// The tool name identifier.
    pub name: Spanned<String>,
    /// Key-value properties (description, schema, permissions, etc.).
    pub properties: Vec<Property>,
    /// Span covering the entire tool definition.
    pub span: Span,
}
```

### 4.3 `AgentDef` additions

Add two new fields to the existing `AgentDef` struct:

```rust
/// Properties from a `context_sources:` sub-block (JIT context pull config).
/// Stored as raw properties; the bridge interprets them at spawn time.
pub context_sources: Vec<Property>,
/// Properties from a `mental_model:` sub-block (per-agent persistent model).
pub mental_model: Vec<Property>,
```

### 4.4 `Permission` struct extension

Add one new field:

```rust
/// Glob patterns if this is a glob-bounded permission, e.g. `files: write[backend/**]`.
/// Empty vec means no glob bounds (plain access level).
pub globs: Vec<String>,
```

### 4.5 `ValidationContext` additions

```rust
/// Team names defined in the document.
pub defined_teams: HashMap<String, Span>,
/// Tool names defined in the document.
pub defined_tools: HashMap<String, Span>,
```

Both initialized to `HashMap::new()` in `ValidationContext::new()`. Extend `is_name_defined` to also check these two maps.

---

## 5. Parser Implementations

### 5.1 `dsl/team.rs` — `parse_team_block`

Model exactly on `skill.rs`:
1. Strip prefix `"team "` instead of `"skill "`
2. Error messages reference `"team Name:"`
3. Return type is `(TeamDef, usize)`
4. Body parsing: identical property loop using `parse_property_or_prose`. Sub-blocks like `leads:`, `workers:`, `routing:` are parsed as flat properties via the existing `collect_block` path used for `permissions:`. No new machinery needed.

**Required tests** (in inline `#[cfg(test)]`):
- `parse_simple_team` — name extracted, properties counted
- `missing_team_keyword` — error message contains "team Name:"
- `missing_colon_after_name` — error message contains "colon"
- `empty_team_name` — error message contains "empty team name"
- `team_with_orchestrator_property` — `properties[0].key.value == "orchestrator"`

### 5.2 `dsl/tool.rs` — `parse_tool_block`

Identical structure to `team.rs`, substituting `"tool "` and `ToolDef`. Sub-blocks inside a tool (schema, input, output) are also handled as plain properties.

Test cases: `parse_simple_tool`, `missing_tool_keyword`, `missing_colon`, `empty_tool_name`, `tool_with_description`.

### 5.3 `agent.rs` extensions — new sub-block branches

In the body-line dispatch loop (`agent.rs:80-116`), add two new branches before the fallthrough `parse_property_or_prose` call:

```rust
// Branch: context_sources: sub-block
if line.content == "context_sources:" {
    let cs_lines = collect_block(body_lines, i + 1, line.indent);
    let mut inner_i = 0;
    while inner_i < cs_lines.len() {
        let cs_line = &cs_lines[inner_i];
        if cs_line.is_blank() || cs_line.is_comment() {
            inner_i += 1;
            continue;
        }
        let (prop, extra) = parse_property_or_prose(&cs_lines, inner_i)?;
        context_sources.push(prop);
        inner_i += 1 + extra;
    }
    i += 1 + cs_lines.len();
    continue;
}

// Branch: mental_model: sub-block (same pattern)
if line.content == "mental_model:" {
    let mm_lines = collect_block(body_lines, i + 1, line.indent);
    let mut inner_i = 0;
    while inner_i < mm_lines.len() {
        let mm_line = &mm_lines[inner_i];
        if mm_line.is_blank() || mm_line.is_comment() {
            inner_i += 1;
            continue;
        }
        let (prop, extra) = parse_property_or_prose(&mm_lines, inner_i)?;
        mental_model.push(prop);
        inner_i += 1 + extra;
    }
    i += 1 + mm_lines.len();
    continue;
}
```

**Important**: the inner loop must iterate with an index (not a for-each) because `parse_property_or_prose` can consume multiple lines (prose blocks).

Declare `let mut context_sources = Vec::new();` and `let mut mental_model = Vec::new();` alongside the other `let mut` declarations at `agent.rs:74`. Propagate both into the `AgentDef` struct construction at function end.

### 5.4 `permission.rs` extensions — glob-bounded syntax

Current parser splits on `:` then comma-splits access values. New syntax: `files: write[backend/**, tests/backend/**]`

Extended parse logic:

```
After splitting domain and access_str:
  if access_str contains '[':
    split on '[' to get base_access and globs_part
    globs_part = strip trailing ']', split on ','
    access = [base_access.trim()]
    globs = globs_part.iter().map(trim).collect()
  else:
    access = comma-split as before
    globs = vec![]
```

New tests:
- `parse_files_write_with_glob` — domain=="files", access==["write"], globs==["backend/**", "tests/backend/**"]
- `parse_files_read_no_glob` — domain=="files", globs is empty
- `parse_glob_single_pattern` — single glob, no comma

### 5.5 `mod.rs` — dispatcher additions

Add after the `pub mod skill;` line:
```rust
pub mod team;
pub mod tool;
```

Add dispatch blocks before the unknown-construct error:

```rust
// Team block
if content_str.starts_with("team ") && content_str.ends_with(':') {
    match team::parse_team_block(&lines, idx) {
        Ok((team_def, consumed)) => {
            sections.push(Section::Team(team_def));
            idx += consumed;
        }
        Err(e) => {
            errors.push(e);
            idx += 1;
        }
    }
    continue;
}

// Tool block
if content_str.starts_with("tool ") && content_str.ends_with(':') {
    match tool::parse_tool_block(&lines, idx) {
        Ok((tool_def, consumed)) => {
            sections.push(Section::Tool(tool_def));
            idx += consumed;
        }
        Err(e) => {
            errors.push(e);
            idx += 1;
        }
    }
    continue;
}
```

Update the unknown-construct error message string to include `team` and `tool` in the list.

---

## 6. Lint Rule Implementations (`validate/hierarchy.rs`)

### Entry point

```rust
pub fn check_all(doc: &CantDocument, _ctx: &ValidationContext) -> Vec<Diagnostic>
```

Fan out to 8 private check functions, collect and return.

### TEAM-001: Team must declare an orchestrator

Walk `Section::Team(team)`. Search `team.properties` for a property with `key.value == "orchestrator"`. If not found, emit `Diagnostic::error("TEAM-001", "Team '{name}' at line {line} does not declare an orchestrator. Add `orchestrator: <agent-name>` to the team block.", team.span)`.

### TEAM-002: Lead-role agents MUST NOT declare Edit/Write/Bash in tools.core

Walk `Section::Agent(agent)`. If `agent.properties` contains a property with `key.value == "role"` and value matches `"lead"`:
- Search for a property with `key.value == "core"` within the agent's property list (because `tools:` sub-blocks are parsed as flat properties by the current property parser, the `core:` key will appear as a top-level property in `agent.properties` alongside `role:`, `tier:`, etc.)
- If the `core` property's value is `Value::Array(elements)`, check if any element matches `Value::Identifier("Edit"|"Write"|"Bash")`. If found, emit `Diagnostic::error("TEAM-002", ...)`

**Note**: the sub-block flattening behavior needs verification during implementation. If `collect_block` produces nested structure, adjust the lint rule accordingly.

### TEAM-003: Worker agents MUST declare a `parent:`

Walk `Section::Agent(agent)`. If `agent.properties` contains a property with `key.value == "role"` and value is `"worker"`: check that a property with `key.value == "parent"` also exists. If not, emit `Diagnostic::error("TEAM-003", "Worker agent '{name}' at line {line} must declare `parent:`. Worker agents must be explicitly parented to a lead or orchestrator.", agent.name.span)`.

### TIER-001: Agent `tier:` must be one of `low`, `mid`, `high`

Walk `Section::Agent(agent)`. If any property has `key.value == "tier"`, extract the string value. If it is not one of `"low"`, `"mid"`, `"high"`, emit `Diagnostic::error("TIER-001", "Agent '{name}' has invalid tier '{value}' at line {line}. Tier must be one of: low, mid, high (per L3).", prop.span)`.

**Note**: the prototype uses `tier: 0` (numeric) and `tier: subagent` — these are legacy T197 values. `TIER-001` will fire on those documents. The validation gate must treat the prototype as parse-only (no full validation requirement).

### TIER-002: `mental_model.max_tokens` must be ≤ tier token cap

Walk `Section::Agent(agent)`. If `agent.mental_model` is non-empty:
- Find property with `key.value == "max_tokens"` in `agent.mental_model`
- Find property with `key.value == "tier"` in `agent.properties`
- Look up the cap from the tier: `low` → 0, `mid` → 1000, `high` → 2000
- If `max_tokens` value is `Value::Number(n)` and `n as u64 > cap`, emit `Diagnostic::error("TIER-002", ...)`

### JIT-001: `context_sources:` MUST declare `on_overflow:` policy

Walk `Section::Agent(agent)`. If `agent.context_sources` is non-empty, check that at least one property has `key.value == "on_overflow"`. If not found, emit `Diagnostic::error("JIT-001", "Agent '{name}' declares context_sources but is missing required `on_overflow:` policy (per L4). Add `on_overflow: escalate_tier`.", agent.name.span)`.

### MM-001: `mental_model` MUST declare `scope:`

Walk `Section::Agent(agent)`. If `agent.mental_model` is non-empty, check for a property with `key.value == "scope"`. If absent, emit `Diagnostic::error("MM-001", "Agent '{name}' mental_model must declare `scope: project|global` (per L5).", agent.name.span)`.

### MM-002: `mental_model.on_load.validate:` MUST be `true`

Walk `Section::Agent(agent)`. If `agent.mental_model` is non-empty:
- Search `agent.mental_model` for a property with `key.value == "validate"`
- If found and value is `Value::Boolean(false)` or `Value::Identifier("false")`, emit `Diagnostic::error("MM-002", ...)`
- If not found at all, emit the same error (absent = not explicitly true = violation per L5)

### Tests (22 required)

Inside `#[cfg(test)]` module:
- `team001_missing_orchestrator_fires`, `team001_with_orchestrator_passes`
- `team002_lead_with_write_tool_fires`, `team002_lead_without_write_tool_passes`, `team002_worker_role_not_checked`
- `team003_worker_without_parent_fires`, `team003_worker_with_parent_passes`, `team003_lead_without_parent_ok`
- `tier001_invalid_tier_fires`, `tier001_valid_low_passes`, `tier001_valid_mid_passes`, `tier001_valid_high_passes`, `tier001_no_tier_passes`
- `jit001_context_sources_without_overflow_fires`, `jit001_context_sources_with_overflow_passes`, `jit001_no_context_sources_passes`
- `mm001_mental_model_without_scope_fires`, `mm001_mental_model_with_scope_passes`
- `mm002_validate_false_fires`, `mm002_validate_absent_fires`, `mm002_validate_true_passes`

---

## 7. Test Fixture Contents

### `tests/fixtures/team-platform.cant`

```cant
---
kind: team
version: 1
---

team platform:
  description: "End-to-end product team"
  orchestrator: cleo-prime

  leads:
    planning: planning-lead
    engineering: engineering-lead
    validation: validation-lead

  workers:
    planning: [product-manager, ux-researcher]
    engineering: [frontend-dev, backend-dev]
    validation: [qa-engineer, security-reviewer]

  routing:
    hitl_target: orchestrator
    orchestrator_can_call: leads
    lead_can_call: own_group_workers
    worker_can_call: []

  enforcement: strict
```

Expected: parses to `Section::Team(TeamDef { name: "platform", ... })`, zero diagnostics.

### `tests/fixtures/tool-dispatch.cant`

```cant
---
kind: tool
version: 1
---

tool dispatch_worker:
  description: "Spawn a worker subagent with a task assignment"
  tier: lead
  input:
    agent: "Name of the worker agent to spawn"
    task_id: "Task ID to assign (e.g. T1234)"
    context: "Optional extra context string"
  output:
    session_id: "Spawned session identifier"
    result: "Worker output summary"
  permissions:
    workers: execute
```

Expected: parses to `Section::Tool(ToolDef { name: "dispatch_worker", ... })`, zero diagnostics.

### `tests/fixtures/jit-backend-dev.cant`

```cant
---
kind: agent
version: 2
---

agent backend-dev:
  parent: engineering-lead
  role: worker
  tier: mid

  prompt: |
    You are a backend developer on the platform team. Implement the
    assigned task per the spec. Run tests after every change. Never
    edit files outside your domain.

  skills: ["ct-task-executor", "ct-dev-workflow"]

  context_sources:
    on_overflow: escalate_tier
    patterns:
      query: "backend AND (auth OR session)"
      max: 5
    conventions:
      file: "${PROJECT_ROOT}/docs/conventions/backend.md"

  mental_model:
    storage: "brain.db:agents/backend-dev/model"
    scope: project
    update_mode: async
    on_load:
      validate: true
      freshness_check: true
      decay_after: "30d"
    max_tokens: 1000

  permissions:
    tasks: read, write
    code: read, write
    files: write[backend/**, tests/backend/**]

  tools:
    core: [Read, Edit, Bash, Glob, Grep]

  constraints [behavior]:
    DOM-001: MUST NOT edit files outside file_ownership glob
    DOM-002: MUST run tests after every Write or Edit
```

Expected: parses with all new fields populated; validation green (role=worker with parent; tier=mid; context_sources has on_overflow; mental_model has scope + validate:true).

---

## 8. Worker Execution Order

Workers must follow this exact sequence. Do not skip steps or reorder.

- [ ] **Step 1 — Extend `ast.rs`**
  - Add `TeamDef`, `ToolDef` structs after `SkillDef`
  - Add `context_sources`, `mental_model` fields to `AgentDef`
  - Add `globs: Vec<String>` field to `Permission`
  - Add `Section::Team(TeamDef)` and `Section::Tool(ToolDef)` variants after `Section::Pipeline`
- [ ] **Step 2 — Extend `permission.rs`**
  - Add glob parsing branch; initialize `globs: Vec::new()` in existing non-glob path
  - Add 3 new tests
- [ ] **Step 3 — Extend `agent.rs`**
  - Declare `let mut context_sources = Vec::new();` and `let mut mental_model = Vec::new();`
  - Add `context_sources:` branch, add `mental_model:` branch
  - Propagate into `AgentDef` struct construction
- [ ] **Step 4 — Create `dsl/team.rs`** — implement `parse_team_block` + 5 tests
- [ ] **Step 5 — Create `dsl/tool.rs`** — implement `parse_tool_block` + 5 tests
- [ ] **Step 6 — Extend `dsl/mod.rs`** — module declarations, dispatcher branches, error message update
- [ ] **Step 7 — Extend `validate/context.rs`** — add `defined_teams`/`defined_tools`, extend `is_name_defined`
- [ ] **Step 8 — Extend `validate/scope/names.rs`** — add `Section::Team`/`Section::Tool` arms to `check_unique_names`
- [ ] **Step 9 — Create `validate/hierarchy.rs`** — all 8 rule checks + 22 tests
- [ ] **Step 10 — Extend `validate/mod.rs`** — `pub mod hierarchy;` + `diags.extend(hierarchy::check_all(doc, &ctx));`
- [ ] **Step 11 — Create fixture files** under `tests/fixtures/`
- [ ] **Step 12 — Full test run**
  - `$REAL_CARGO test -p cant-core` — zero failures, test count 509+new

---

## 9. Validation Gate

**Gate 1 — Build clean**:
```
$REAL_CARGO build -p cant-core 2>&1
```
Zero `error[...]` lines.

**Gate 2 — Full test run**:
```
$REAL_CARGO test -p cant-core 2>&1
```
`test result: ok. 509+ passed; 0 failed`

**Gate 3 — Prototype parse**:
`~/.agents/agents/cleo-subagent/cleo-subagent.cant` must still `parse_document` successfully (return `Ok`). TIER-001 WILL fire on its `tier: 0` legacy syntax — that's expected. Parse-level green is the requirement, not validation-level.

**Gate 4 — No regression**:
```
$REAL_CARGO test -p cant-core 2>&1 | grep -E "^test .* FAILED"
```
Empty output.

**Gate 5 — New rules exercised**:
```
$REAL_CARGO test -p cant-core hierarchy 2>&1
```
All `hierarchy::tests::*` tests pass.

---

## 10. Critical Details

### Backward compatibility of `AgentDef` construction in tests

All inline test constructions of `AgentDef` use struct literal syntax. Adding `context_sources` and `mental_model` will cause compile errors in those literals. The worker must add `context_sources: vec![]` and `mental_model: vec![]` to every `AgentDef { ... }` literal.

```bash
grep -rn "AgentDef {" crates/cant-core/src/
```

### Backward compatibility of `Permission` construction

Adding `globs: Vec<String>` will break every literal. Add `globs: vec![]` to all constructors:

```bash
grep -rn "Permission {" crates/cant-core/src/
```

### `Section` match exhaustiveness

The new `Section::Team` and `Section::Tool` variants will cause "non-exhaustive patterns" compile errors in every `match section` arm without a wildcard. Affected files: `validate/scope/names.rs`, `validate/hooks.rs`, `validate/types/property_rules.rs`, `validate/workflows/rules.rs`, `validate/pipeline_purity/rules.rs`. Most use `_ => {}` wildcards already — verify and add `Section::Team(_) | Section::Tool(_) => {}` arms where needed.

### `tool` keyword collision check

The string `"tool "` prefix check in `mod.rs` must come before the unknown-construct fallthrough. `content_str.starts_with("tool ") && content_str.ends_with(':')` is safe because `"toolkit foo:"` starts with `"tool"` but not `"tool "` (note the space).

### Fixture directory does not exist

Create `crates/cant-core/tests/fixtures/` before writing the `.cant` files. The files serve as reference inputs and can optionally be wired into integration tests via `tests/parse_new_sections.rs`.

---

## Environment Reminder

All workers MUST use the real cargo path:
```
export REAL_CARGO=/home/keatonhoskins/.rustup/toolchains/1.88.0-x86_64-unknown-linux-gnu/bin/cargo
```

The `cargo` in PATH is a Ferrous Forge wrapper that breaks on `version.workspace = true`.
