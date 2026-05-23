---
title: Template + Config Inventory (T9856 · Saga T9855)
task: T9856
saga: T9855
generated: 2026-05-23
---

# Template + Config Inventory

Exhaustive audit of every template directory and every CLEO config file in
the cleocode monorepo, with merge precedence, dynamic-vars contract, and
drift-detection contract. Produced by T9856 (E1-AUDIT-INVENTORY) under
Saga T9855 SG-TEMPLATE-CONFIG-SSOT.

All claims below are grounded in current `main` (commit `f52dcb845`) via
`find packages -type d -name templates`, direct file reads, and
`grep` of the scaffolder / config-resolver source.

---

## 1. Template Directories (12 found)

| # | Location | Owner Package | Boundary Status | Contents | Consumer |
|---|---|---|---|---|---|
| 1 | `packages/core/templates/` | `@cleocode/core` | ✓ correct (SSoT home for global/project bootstrap assets) | `CLEO-INJECTION.md`, `config.template.json`, `global-config.template.json`, `agent-registry.json`, `cleo-gitignore`, `worktreeinclude`, `worktree-include` (legacy), `skillsmp.json.example`, `skillsmp.json.example.md`, `README.md`, `git-hooks/{commit-msg,pre-commit,pre-push}`, `github/ISSUE_TEMPLATE/{bug_report,config,feature_request,help_question}.yml`, `issue-templates/{bug_report,config,feature_request,help_question}.yml` | `cleo init` (core scaffolder), `cleo upgrade` |
| 2 | `packages/core/src/templates/` | `@cleocode/core` | ✓ correct (TS-level template runtime — code, not assets) | `index.ts`, `parser.ts` (mustache-style parser) | core scaffolder + `agents/variable-substitution.ts` |
| 3 | `packages/cleo/templates/` | `@cleocode/cleo` | ✗ **VIOLATION** — runtime template assets in CLI package (see T9858) | `HANDOFF-REDIRECT-STUB.md`, `hooks/{commit-msg,pre-push,pre-push.t1595-extension.sh}`, `cleoos-hub/{global-recipes/{justfile,README.md},pi-extensions/{cant-bridge,cleo-cant-bridge,orchestrator,stage-guide}.ts,README.md}`, `workflows/{release-fanout,release-prepare,release-publish,release-rollback}.yml.tmpl`, `workflows/README.md` | `cleo init --workflows` (T9531) → `core/init/scaffold-workflows.ts`; git-hooks installer → `core/git/hooks-install.ts` |
| 4 | `packages/agents/templates/` | `@cleocode/agents` | TBD per T9858 — defensible as **agent-runtime asset** (consumed by `loadProjectContext` + `substituteCantAgentBody`), not a release/init asset | 5 `.cant` files (`project-{code-worker,dev-lead,docs-worker,orchestrator,security-worker}.cant`) + `README.md` | `core/agents/seed-install.ts` (`cleo init --install-seed-agents`) |
| 5 | `packages/skills/skills/ct-contribution/templates/` | `@cleocode/skills` (skill-local) | ✓ acceptable per T9858 acceptance — skill-bundled JSON template | `contribution-init.json` (mustache placeholders for contribution protocol scaffolding) | `ct-contribution` skill `/contribution start` flow |
| 6 | `packages/adapters/src/providers/pi/templates/` | `@cleocode/adapters` | ✓ acceptable — provider-specific stub, only `hooks/README.md` (Pi uses TS extensions, NOT shell hooks; this directory is a placeholder + explainer) | `hooks/README.md` (documents why no shell shim ships) | `core/hooks/handlers/precompact.ts` (TS handler, not shell) |
| 7 | `packages/adapters/src/providers/shared/templates/` | `@cleocode/adapters` | ✓ acceptable — provider-neutral shared shell helper sourced by every provider precompact hook | `hooks/cleo-precompact-core.sh` (locates `.cleo/`, resolves `cleo` binary, drains memory + safestop) | sourced by every provider's `precompact.sh` template (5, 8, 9, 10 below) |
| 8 | `packages/adapters/src/providers/claude-code/templates/` | `@cleocode/adapters` | ✓ acceptable — provider-specific shell adapter that wraps shared core | `hooks/precompact-safestop.sh` | `cleo init --hooks claude-code` |
| 9 | `packages/adapters/src/providers/cursor/templates/` | `@cleocode/adapters` | ✓ acceptable | `hooks/precompact.sh` | `cleo init --hooks cursor` |
| 10 | `packages/adapters/src/providers/gemini-cli/templates/` | `@cleocode/adapters` | ✓ acceptable | `hooks/precompact.sh` | `cleo init --hooks gemini-cli` |
| 11 | `packages/adapters/src/providers/opencode/templates/` | `@cleocode/adapters` | ✓ acceptable | `hooks/precompact.sh` | `cleo init --hooks opencode` |
| 12 | `packages/cleo/test/templates/` | `@cleocode/cleo` (tests) | ✓ acceptable — test-only fixtures + snapshots, never shipped | `release-{fanout,prepare,publish,rollback}-render.test.ts` + `__snapshots__/*.yml.snap` | Vitest snapshot harness for `scaffold-workflows.ts` |

### Cross-template duplication detected

`packages/core/templates/git-hooks/commit-msg` AND
`packages/cleo/templates/hooks/commit-msg` BOTH exist as separately
maintained files. The cleo copy adds the T1608 diff-scope check;
the core copy stops at the T1588 baseline. Two installers consume
them via two different code paths:

- `packages/core/src/hooks.ts` reads `templates/git-hooks/` (core copy).
- `packages/core/src/git/hooks-install.ts` reads
  `packages/cleo/templates/hooks/` (cleo copy).

T9858 is the canonical owner of resolving this duplication — likely by
deleting the core copies and centralising on the cleo→core relocated
versions with the T1608 enhancement.

Similar pattern: `packages/core/templates/issue-templates/` AND
`packages/core/templates/github/ISSUE_TEMPLATE/` BOTH ship the same four
files (`bug_report.yml`, `config.yml`, `feature_request.yml`,
`help_question.yml`). The duplication is intra-package, not cross-package.

---

## 2. Config Files (5 distinct files; 3 schemas)

CLEO actually has **5** config files in active use — the brief listed 4
but missed `.cleo/release-config.json`. All five are catalogued here.

| # | Path | Scope | Purpose | Schema source | Merge precedence | Resolver |
|---|---|---|---|---|---|---|
| 1 | `<projectRoot>/.cleo/project-context.json` | project | Auto-detected ecosystem signals (`projectTypes`, `primaryType`, monorepo flag, `testing.framework` + `command`, `build.command`, `directories`, `conventions`, `llmHints`) — drives ADR-061 tool resolution + agent variable substitution | `packages/contracts/src/project-context.ts` (`ProjectContext` interface) | Project-only — has no global counterpart. Detector writes once on `cleo init`; `cleo upgrade` re-detects. | `loadProjectContext()` in `packages/core/src/agents/variable-substitution.ts:429`; `resolveToolCommand()` in ADR-061 tool resolver |
| 2 | `<projectRoot>/.cleo/project-info.json` | project | Stable project identity — `projectHash` (12-char SHA-256 of normalized path, used as worktree directory key), `projectId` (UUID surviving moves), `projectName`, `projectRoot` | `packages/core/src/project-info.ts` (`ProjectInfo` interface) | Project-only. Single writer = `ensureProjectInfo()` in `init.ts`; consumed by logging, audit, worktree layout. | `getProjectInfo()` / `getProjectInfoSync()` in `packages/core/src/project-info.ts` |
| 3 | `<projectRoot>/.cleo/config.json` | project | Per-project CLEO config overrides — `archive`, `enforcement`, `verification`, `lifecycle`, `hierarchy`, `defaults`, `session`, `release`, `output`, `backup`, `contextAlerts`, `orchestrator`, `agentOutputs`, `retention`, `brain` | Seeded from `packages/core/templates/config.template.json`; schema at `packages/core/schemas/config.schema.json` | **Project layer of the 4-tier cascade** (defaults → global → **project** → env). Overrides global; overridden by env. | `loadConfig(cwd)` in `packages/core/src/config.ts:222` |
| 4 | `~/.cleo/config.json` (XDG: `$XDG_CONFIG_HOME/cleo/config.json`) | global | Operator-global defaults — same schema fields as project config, applies cross-project | Seeded from `packages/core/templates/global-config.template.json`; schema at `packages/core/schemas/global-config.schema.json` | **Global layer** — lowest after hard-coded `DEFAULTS`. Overridden by project + env. | Same `loadConfig()` cascade; read via `getGlobalConfigPath()` |
| 5 | `<projectRoot>/.cleo/release-config.json` | project | Release-pipeline overrides consumed ONLY by the workflow scaffolder — `nodeVersion`, `installCmd`, `releaseBranchPrefix`, `prLabel`, `npmPublishCmd`, `publishers`, `fanout.{docsBuildCmd, docsDeploy, dockerRetag, sentinelNotify, studioDeploy, nightlyTrigger, dockerImage, dockerHubUser, sentinelWebhookUrl, studioDeployHook}`, `rollback.{npmPackages, cargoCrates}` | `ScaffoldReleaseConfig` interface in `packages/core/src/init/scaffold-workflows.ts:91` | Project-only, scoped to `cleo init --workflows`. Hard-coded defaults supplied per field; missing file ⇒ `{}` and every placeholder falls back to its `DEFAULT_*` constant. | `loadReleaseConfigJson()` in `packages/core/src/init/scaffold-workflows.ts:245` (mirror in `upgrade-workflows.ts:217`) |

### Cascade details (files 3 + 4)

`loadConfig()` (packages/core/src/config.ts:222) merges in strict order:

1. `DEFAULTS` (hard-coded in `config.ts`)
2. Global config (`~/.cleo/config.json`) — `deepMerge` over defaults
3. Project config (`<projectRoot>/.cleo/config.json`) — `deepMerge` over global
4. Environment variables via `ENV_MAP` — `setNestedValue` over merged result

`getConfigValue<T>(path)` exposes the same precedence with a `source`
tag (`'env' | 'project' | 'global' | 'default'`) so callers can surface
provenance to the user.

### Live observation (current dev environment)

- Local worktree has `.cleo/project-context.json` ✓
- Local worktree has NO `.cleo/project-info.json`, NO `.cleo/config.json`,
  NO `.cleo/release-config.json` — every cascade step falls through to
  defaults / global. This is normal for an existing checkout; both files
  are seeded only by `cleo init` (which the cleocode repo has never run
  on itself — see related T9781 / T9961).
- Global `~/.cleo/config.json` exists with a minimal `{llm, agent,
  telemetry}` shape — significantly narrower than the
  `global-config.template.json` schema, confirming the layer is
  hand-edited by the operator rather than re-seeded.

### Adjacent .cleo/*.json files (NOT cascade members)

These live in `.cleo/` but are SSoT artefacts, NOT user-edited config:

| Path | Role |
|---|---|
| `.cleo/canon.schema.json` | JSON-Schema for `canon.yml` (ADR-076 routing registry) |
| `.cleo/canon.yml` | Canonical docs routing registry |
| `.cleo/deprecations.schema.json` + `.cleo/deprecations.yml` | Deprecation ledger schema + data |
| `.cleo/core-first-baseline.json` | Lint baseline for SG-ARCH-SOLID core-first guard |
| `.cleo/define-command-ssot-baseline.json` | Lint baseline for `defineCommand` SSoT gate |

Globals on the same machine that are also NOT cascade members:
`auth-suppression.json`, `llm-credentials.json`, `sentient-state.json`,
`telemetry-config.json`, `user_profile.json`, `web-server.json` —
subsystem state files, each owned by its respective module.

---

## 3. Dynamic-vars Contract (templates ↔ project-context ↔ release-config)

The four workflow templates in `packages/cleo/templates/workflows/`
draw from a single 23-placeholder vocabulary. Resolution lives in
`packages/core/src/init/scaffold-workflows.ts` (`resolvePlaceholders` +
`buildSubstitutionMap`).

### Resolution precedence (highest first)

1. `.cleo/release-config.json` explicit override (file #5 above).
2. ADR-061 tool resolver (`resolveToolCommand(canonical, projectRoot)`)
   which reads `.cleo/project-context.json` `testing.command` /
   `build.command` AND falls through to `primaryType`-keyed archetype
   defaults (cargo, pytest, go, bun, …) when those keys are absent.
3. Hard-coded `DEFAULT_*` constants in `scaffold-workflows.ts`.

### Full placeholder vocabulary (23 placeholders, 4 templates)

| Placeholder | Used in template(s) | Source (in resolution order) | Default fallback |
|---|---|---|---|
| `{{NODE_VERSION}}` | prepare, publish, fanout, rollback | `release-config.nodeVersion` | `22.x` |
| `{{INSTALL_CMD}}` | prepare, publish, fanout | `release-config.installCmd` (NOT ADR-061 — install is not canonical) | `pnpm install --frozen-lockfile` |
| `{{LINT_CMD}}` | prepare, publish | `release-config` (none) → ADR-061 `tool:lint` → archetype default | `pnpm run lint` |
| `{{TYPECHECK_CMD}}` | prepare, publish | ADR-061 `tool:typecheck` | `pnpm run typecheck` |
| `{{TEST_CMD}}` | prepare, publish | ADR-061 `tool:test` → `project-context.testing.command` | `pnpm run test` |
| `{{BUILD_CMD}}` | prepare, publish | ADR-061 `tool:build` → `project-context.build.command` | `pnpm run build` |
| `{{BRANCH_PREFIX}}` | prepare | `release-config.releaseBranchPrefix` | `release` |
| `{{PR_LABEL}}` | prepare | `release-config.prLabel` | `release` |
| `{{NPM_PUBLISH_CMD}}` | publish, rollback | `release-config.npmPublishCmd` | `pnpm publish --access public --tag latest` |
| `{{PUBLISHERS}}` | publish, rollback | `release-config.publishers` | `npm` |
| `{{DOCS_BUILD_CMD}}` | fanout | `release-config.fanout.docsBuildCmd` | `pnpm run docs:build` |
| `{{ENABLE_DOCS_DEPLOY}}` | fanout | `release-config.fanout.docsDeploy` | `false` |
| `{{ENABLE_DOCKER_RETAG}}` | fanout | `release-config.fanout.dockerRetag` | `false` |
| `{{ENABLE_SENTINEL_NOTIFY}}` | fanout | `release-config.fanout.sentinelNotify` | `false` |
| `{{ENABLE_STUDIO_DEPLOY}}` | fanout | `release-config.fanout.studioDeploy` | `false` |
| `{{ENABLE_NIGHTLY_TRIGGER}}` | fanout | `release-config.fanout.nightlyTrigger` | `false` |
| `{{DOCKER_IMAGE}}` | fanout | `release-config.fanout.dockerImage` | `""` (required if `dockerRetag=true`) |
| `{{DOCKER_HUB_USER}}` | fanout | `release-config.fanout.dockerHubUser` | `""` (required if `dockerRetag=true`) |
| `{{SENTINEL_WEBHOOK_URL}}` | fanout | `release-config.fanout.sentinelWebhookUrl` | `""` (required if `sentinelNotify=true`) |
| `{{STUDIO_DEPLOY_HOOK}}` | fanout | `release-config.fanout.studioDeployHook` | `""` (required if `studioDeploy=true`) |
| `{{NPM_PACKAGES}}` | rollback | `release-config.rollback.npmPackages` | `""` (required if `PUBLISHERS` contains `npm`) |
| `{{CARGO_CRATES}}` | rollback | `release-config.rollback.cargoCrates` | `""` (required if `PUBLISHERS` contains `cargo`) |

Per-template placeholder counts (verified via
`grep -o '{{[A-Z_]*}}' packages/cleo/templates/workflows/*.yml.tmpl`):

- `release-prepare.yml.tmpl`: 8 placeholders
  (`BRANCH_PREFIX, BUILD_CMD, INSTALL_CMD, LINT_CMD, NODE_VERSION, PR_LABEL, TEST_CMD, TYPECHECK_CMD`).
- `release-publish.yml.tmpl`: 9 placeholders
  (`BUILD_CMD, INSTALL_CMD, LINT_CMD, NODE_VERSION, NPM_PUBLISH_CMD, PUBLISHERS, TEST_CMD, TYPECHECK_CMD`).
- `release-fanout.yml.tmpl`: 12 placeholders
  (`DOCKER_HUB_USER, DOCKER_IMAGE, DOCS_BUILD_CMD, ENABLE_DOCKER_RETAG, ENABLE_DOCS_DEPLOY, ENABLE_NIGHTLY_TRIGGER, ENABLE_SENTINEL_NOTIFY, ENABLE_STUDIO_DEPLOY, INSTALL_CMD, NODE_VERSION, SENTINEL_WEBHOOK_URL, STUDIO_DEPLOY_HOOK`).
- `release-rollback.yml.tmpl`: 4 placeholders
  (`CARGO_CRATES, NODE_VERSION, NPM_PACKAGES, PUBLISHERS`).

### Substitution mechanics

Single-pass regex per substitution: `new RegExp('\\{\\{' + name + '\\}\\}', 'g')`.

- No Mustache / Handlebars — deterministic line-for-line diffability.
- Unused placeholders are silently retained (no replacement). The README
  guarantees `actionlint` post-processing catches any leftover `{{...}}`.
- Placeholders MUST be `UPPER_SNAKE_CASE` wrapped in double braces.
- Templates MUST be ASCII outside of strings.

### Other dynamic-substitution surfaces (NOT the same vocabulary)

| Template family | Substitution syntax | Resolver |
|---|---|---|
| `packages/core/templates/config.template.json` | `{{SCHEMA_VERSION_CONFIG}}`, `{{TIMESTAMP}}` | Hard-coded in `cleo init` (no per-project override) |
| `packages/core/templates/global-config.template.json` | `{{SCHEMA_VERSION_GLOBAL_CONFIG}}` | Hard-coded |
| `packages/agents/templates/*.cant` | `{{tech_stack}}`, `{{project_domain}}`, `{{team_size}}`, dotted-path `{{project.name}}` | `substituteCantAgentBody()` in `packages/core/src/agents/variable-substitution.ts` — reads `.cleo/project-context.json` + CLI `--var k=v` overrides |
| `packages/skills/skills/ct-contribution/templates/contribution-init.json` | `{{CONTRIBUTION_ID}}`, `{{TIMESTAMP}}`, `{{AGENT_ID}}`, `{{SESSION_ID}}`, `{{EPIC_ID}}`, `{{TASK_ID}}`, `{{MARKER_LABEL}}` | Skill-local — supplied by `/contribution start` CLI args |

The workflow scaffolder, the agent substituter, and the contribution
seed each ship their own regex pass. **Drift risk**: a future
"templates SSoT" must either unify the substitution engine or formally
declare that each consumer owns its own (current state).

---

## 4. Drift Detection Contract

"Drift" means different things for templates vs. configs. The
T9860 dogfood CI gate must enforce all four flavours.

### 4.1 Template drift

| Flavour | Definition | Detection |
|---|---|---|
| **Structural** | Rendered workflow YAML in `.github/workflows/*.yml` diverges from re-render against current `.cleo/release-config.json` + ADR-061 resolution. | `cleo init --workflows --dry-run` + `diff` against on-disk. CI surfaces non-zero diff as `E_WORKFLOW_DRIFT`. |
| **Lexical** | A placeholder name in the `.tmpl` file no longer appears in the resolver's `buildSubstitutionMap`. (Adding a placeholder = silent unsubstituted token; removing = dead default.) | Snapshot tests at `packages/cleo/test/templates/release-*-render.test.ts` lock the rendered output. Source-of-truth grep: `grep -ho '{{[A-Z_]*}}' packages/cleo/templates/workflows/*.tmpl \| sort -u` vs. `Map.keys()` in `buildSubstitutionMap`. |
| **Schema** | The placeholder README (`packages/cleo/templates/workflows/README.md`) lists a placeholder that no template uses, or vice versa. | Pre-commit gate parses the README table + diffs against the live `.tmpl` vocabulary. |
| **Doc/code** | `packages/core/templates/README.md` lists a template that no longer ships, or a shipped template that is undocumented. | T9860 CI gate walks both directions. |

### 4.2 Config drift

| Flavour | Definition | Detection |
|---|---|---|
| **Schema validity** | A config file has a key absent from the JSON-Schema OR a required key is missing. | `Ajv` validation in `loadConfig()` (proposed; currently only DEFAULTS shape is enforced via TS types). |
| **Cascade collision** | Project config redefines a key that global config already sets to the same value (noise) OR overrides a key flagged as global-only (e.g. `telemetry.installId`). | Static rule list in T9857 `ConfigManifest` contract. |
| **Stale defaults** | A user's `.cleo/config.json` was seeded from an older `config.template.json` version (`_meta.schemaVersion` field) and lacks new required keys. | `cleo upgrade` migration plan; `cleo doctor` warning when `_meta.schemaVersion` < bundled template version. |
| **Orphan keys** | A config file contains a key NOT in the schema (user typo or removed feature). | `Ajv` `additionalProperties: false` (or warn-mode for forward-compatibility). |

### 4.3 Reference

T9860 (in-flight sibling task in this Saga) is the canonical CI dogfood
gate that wires these checks into `Architectural Boundary Check`. T9856
documents the contract; T9860 enforces it.

---

## 5. Follow-up Tasks

| Task | Subject | Status |
|---|---|---|
| T9858 | Boundary relocation: move `packages/cleo/templates/{workflows,hooks,cleoos-hub}` into `packages/core/templates/` so the runtime-template SSoT lives in core, not the CLI | in-flight (sibling) |
| T9860 | Dogfood CI gate — enforce sections 4.1 + 4.2 against the cleocode repo + a synthetic external fixture | in-flight (sibling) |
| T9857 | `TemplateManifest` + `ConfigManifest` contracts in `packages/contracts/` — typed registry mirroring sections 1 + 2 of this doc | pending (downstream) |
| T9859 | `cleo templates` + `cleo config` CLI namespaces — `cleo templates list`, `cleo templates diff`, `cleo config show --source`, `cleo config diff --layer` | pending (downstream) |
| T9861 | Sentient Tier-2 drift autowarn — daemon ingests T9860 outputs and proposes `cleo upgrade --workflows` / `cleo config migrate` tasks | pending (downstream) |

---

## 6. Open Questions

### 6.1 Should `packages/adapters/src/providers/*/templates/` move to core?

**T9858 ACs imply yes** ("all runtime templates under core"), but the
hooks under these directories are genuinely provider-specific (Claude
Code's `precompact-safestop.sh` differs from Cursor's `precompact.sh`).
**Proposed resolution**: keep them in `packages/adapters/` — they are
**adapter assets**, not project-bootstrap assets. The boundary rule in
AGENTS.md ("Harness-specific code in `packages/core/` belongs in
`packages/cleo-os/` / adapters") supports this.

### 6.2 Should `packages/agents/templates/*.cant` move?

These are **agent identities**, not GHA workflow templates. They use a
distinct substitution engine (`substituteCantAgentBody`) and live next
to the agent runtime that consumes them. **Proposed resolution**: keep
in `packages/agents/` — relocating would force `@cleocode/core` to
depend on the agent contract surface, which inverts the layering
contract.

### 6.3 Should `packages/skills/skills/ct-contribution/templates/` move?

Skills are self-contained packages. Skill-local templates that ship
inside a skill bundle (and are only used by that skill) should stay
skill-local. **Proposed resolution**: T9858 ACs already exempt these
("skill-local acceptable").

### 6.4 What about the `commit-msg` hook duplication (§1 cross-template note)?

Two installers, two source files, two consumer paths. Either:

- **Option A**: keep one canonical copy (the cleo one with the T1608
  diff-scope check), delete the core copy, and update
  `packages/core/src/hooks.ts` to read from the same path
  `git/hooks-install.ts` already uses.
- **Option B**: keep both but treat the core copy as a feature-flag
  fallback for environments where the diff-scope check is unwanted.

T9858 should pick one and ship it. The reading of `core/hooks.ts`
suggests it is a legacy path; Option A is the smaller blast radius.

### 6.5 `release-config.json` was missing from the brief

The brief catalogued 4 config files; the actual count is 5. Either
the brief's `config.json` was intended to cover both, or this file is
genuinely overlooked. T9857 `ConfigManifest` should include it as a
first-class scope and stop treating release-pipeline config as a
sibling of `release-config.json` lookups inside the scaffolder.

### 6.6 `worktreeinclude` vs. `worktree-include` (legacy)

`packages/core/templates/` ships BOTH. The new canonical is
`.worktreeinclude` at repo root (T9983); the legacy `.cleo/worktree-include`
is read for one deprecation cycle. Both template files exist so
`cleo init` can seed either path. T9858 / T9857 must agree on which
ships in the manifest and which gets a `deprecated: true` flag.

---

## Source files cited

- `packages/contracts/src/project-context.ts` — `ProjectContext` interface
- `packages/core/src/project-info.ts` — `ProjectInfo` interface
- `packages/core/src/config.ts:222` — `loadConfig()` 4-tier cascade
- `packages/core/src/init/scaffold-workflows.ts:91` — `ScaffoldReleaseConfig`
- `packages/core/src/init/scaffold-workflows.ts:282` — `resolvePlaceholders()`
- `packages/core/src/init/scaffold-workflows.ts:322` — `buildSubstitutionMap()`
- `packages/core/src/agents/variable-substitution.ts:429` — `loadProjectContext()`
- `packages/cleo/templates/workflows/README.md` — placeholder vocabulary spec
- `packages/core/templates/README.md` — core template directory index
- `packages/adapters/src/providers/pi/templates/hooks/README.md` — why-no-shell explainer
