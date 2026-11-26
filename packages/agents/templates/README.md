# Seed Agent Templates

Generic `.cant` agent templates bundled with `@cleocode/agents`. These are
**project-agnostic starting points** for building your own team — they carry
mustache-style `{{placeholder}}` variables that get substituted at install
time with values appropriate to your project.

Operators are encouraged to fork, edit, or delete any of these files. They
are the *starting* personas, not a fixed contract. Re-running `cleo init`
never overwrites a seed that already exists in the project.

## Bundled templates

### `project-orchestrator.cant`

Top-level team orchestrator. Classifies tasks, dispatches to the dev-lead,
synthesises results. Coordinates — does not execute code itself.

### `project-dev-lead.cant`

Development lead. Decomposes tasks into concrete implementation steps,
reviews worker output, and decides technical approach. Dispatches to
code-worker and docs-worker. **MUST NOT** hold Edit/Write/Bash tools
(TEAM-002 / ULTRAPLAN 10.3) — review-only authority.

### `project-code-worker.cant`

General-purpose code worker. Reads requirements from the dev-lead, writes
code, runs tests, and validates changes. Operates within declared file
permission globs.

### `project-docs-worker.cant`

Documentation worker. Writes READMEs, updates guides, adds inline
documentation. Operates within declared documentation file globs.

### `project-security-worker.cant`

Security worker. Reviews code for vulnerabilities, audits dependencies and
produces findings reports. Read-only; escalates remediation to the dev-lead.

## Template variables

Each template uses `{{placeholder}}` mustache syntax with dot notation for
nested paths. Placeholders are substituted at install time.

| Variable | Required | Example | Used by |
|----------|----------|---------|---------|
| `{{tech_stack}}` | yes | `"TypeScript/Node.js"`, `"Rust/Cargo"` | orchestrator, dev-lead, code-worker, docs-worker |
| `{{project_domain}}` | yes | `"API authentication"`, `"document processing"` | orchestrator, dev-lead, code-worker, docs-worker |
| `{{test_command}}` | yes | `"pnpm run test"`, `"cargo test"` | code-worker |
| `{{build_command}}` | yes | `"pnpm run build"`, `"cargo build"` | code-worker |
| `{{repo_structure}}` | optional | `["src/**","packages/**"]` | code-worker (write/delete globs) |
| `{{team_size}}` | optional | `"1-3 developers"` | orchestrator (context budget) |

## Installation

Seeds are NOT installed by default. To opt in during project init:

```bash
cleo init --install-seed-agents \
  --var tech_stack="TypeScript/Node.js" \
  --var project_domain="API gateway" \
  --var test_command="pnpm run test" \
  --var build_command="pnpm run build"
```

This copies any seed template that does not already exist in
`.cleo/cant/agents/`, substituting the declared variables. The flag is
idempotent and safe to run on already-initialised projects.

## Validation

All five templates parse and validate clean with `cant-core` *after*
variable substitution. The `template_project_*_parses_clean` tests in
`crates/cant-core/tests/parse_new_sections.rs` render each template with
sample values and enforce this in CI:

```bash
cargo test -p cant-core --test parse_new_sections template_
```

Use CANT syntax, not YAML: lists are inline arrays (`skills: [ct-cleo,
ct-task-executor]`), and `context_sources:` is a keyed sub-block with
`on_overflow:` inside it.

## Project-specific personas

Cleo's own project-specific personas (cleo-prime, cleo-dev, cleo-historian,
cleo-rust-lead, cleo-db-lead, cleoos-opus-orchestrator) are **NOT** shipped
here. They live in the cleocode repo's `.cleo/cant/agents/` for dogfood and
are not generic templates. See
[R3-CONTENT-AUDIT](../../../.cleo/agent-outputs/T-AGENTS-PRE-WAVE/R3-CONTENT-AUDIT.md)
for the classification rationale.
