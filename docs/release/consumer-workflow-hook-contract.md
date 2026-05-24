# CLEO consumer workflow and hook template contract

Task: T10476
Parent epic: T10468 (CI/hooks taxonomy)
Status: supported-surface contract, derived from shipped code paths

## Goal

Define the portable workflow and hook template surfaces CLEO supports for consumer projects, distinguish them from cleocode dogfood-only repository workflows, and name the shared code surfaces that implement the contract.

A surface is consumer-supported only when it is shipped by a CLEO package and installed or refreshed by a CLEO command/API intended to run outside this repository. Repository-local GitHub Actions and root `simple-git-hooks` configuration are dogfood-only unless a shipped installer explicitly renders them into a consumer project.

## Non-Goals

- Do not redesign workflow rendering, hook installation, branch protection, or release pipeline semantics.
- Do not mark the cleocode repository's own CI workflows as consumer-supported simply because their YAML lives in this repository.
- Do not promise support for templates or hook assets that exist on disk but are not reached by a shipped consumer installer.

## Requirements

- Classify every in-scope surface as consumer-supported, dogfood-only, shared, unsupported, or asset-only.
- For consumer-supported surfaces, identify owner package, install/refresh entrypoint, source path, destination path, and guarantee level.
- For dogfood-only surfaces, state why consumers must not treat the surface as required setup.
- For release surfaces, distinguish the supported CLI/API command contract from cleocode owner workflows.

## Out-of-Scope

- Editing workflow or hook installer behavior.
- Changing template registry entries.
- Changing branch protection, GitHub Actions required checks, or release orchestration policy.

## Supported consumer surfaces

### Release workflow templates

Owner: `@cleocode/core` owns the templates and renderer. `@cleocode/cleo` owns the CLI/dispatch entrypoints.

Install/refresh entrypoints:

- `cleo init --workflows` / workflow scaffolding compatibility path.
- `cleo upgrade workflows` for drift detection and, with explicit force, refresh.
- Core APIs under `packages/core/src/init/scaffold-workflows.ts`, `packages/core/src/init/upgrade-workflows.ts`, and the template registry in `packages/core/src/templates/manifest-data.ts`.

Supported templates:

| Template id | Source path | Consumer install path | Contract |
|---|---|---|---|
| `release-prepare` | `packages/core/templates/workflows/release-prepare.yml.tmpl` | `.github/workflows/release-prepare.yml` | Supported release-preparation workflow template. |
| `release-publish` | `packages/core/templates/workflows/release-publish.yml.tmpl` | `.github/workflows/release-publish.yml` | Supported release publish/tag workflow template. |
| `release-fanout` | `packages/core/templates/workflows/release-fanout.yml.tmpl` | `.github/workflows/release-fanout.yml` | Supported optional post-publish fanout workflow template. |
| `release-rollback` | `packages/core/templates/workflows/release-rollback.yml.tmpl` | `.github/workflows/release-rollback.yml` | Supported rollback workflow template. |

Guarantees:

- Templates are project-agnostic GitHub Actions YAML templates rendered from `{{UPPER_SNAKE_CASE}}` placeholders by deterministic regex substitution.
- Template metadata is listed in `TEMPLATE_MANIFEST_ENTRIES` with kind `workflow`, source path, install path, substitution mode, and update strategy.
- `cleo upgrade workflows` supports read-only drift detection. Mutation requires the mutate path and explicit force semantics; writes are audited to `.cleo/audit/upgrade-workflows.jsonl` by the core upgrade primitive.
- Existing rendered workflow files are not consumer-owned source of truth; the shipped template plus project config/archetype inputs are the source of truth.

Non-guarantees:

- CLEO does not support arbitrary `.github/workflows/*.yml` files in a consumer project as part of this contract.
- The cleocode repository's own `.github/workflows/*.yml` files are not installed into consumers and are not compatibility surfaces.
- Consumer branch protection requirements are not inferred from the cleocode repository's required checks; only the rendered release workflow semantics are in this contract.

### Project git hook templates

Owner: `@cleocode/core`.

Install/refresh entrypoints:

- `installCleoHooks(projectRoot, opts)` from `@cleocode/core`.
- Any CLI path that delegates to that API inherits this contract; no separate CLI-only hook contract is implied.

Supported hooks:

| Hook | Source path | Consumer destination | Contract |
|---|---|---|---|
| `commit-msg` | `packages/core/templates/git-hooks/commit-msg` | `<core.hooksPath or .git/hooks>/commit-msg` | Supported CLEO-managed git hook. |
| `pre-push` | `packages/core/templates/git-hooks/pre-push` | `<core.hooksPath or .git/hooks>/pre-push` | Supported CLEO-managed git hook. |

Guarantees:

- The installer respects `git config core.hooksPath`; otherwise it writes to `.git/hooks`.
- Hooks are written executable where the platform permits it.
- Sentinel ownership protects user hooks: without `force`, CLEO overwrites only hooks whose first five lines include `# CLEO_MANAGED_HOOK v1`.
- Existing non-CLEO hooks are skipped without force and reported in the result.

Non-guarantees:

- `packages/core/templates/git-hooks/pre-commit` and `packages/core/templates/git-hooks/pre-push.t1595-extension.sh` are shipped assets/registry entries, but they are not installed by `installCleoHooks` because `CLEO_HOOK_NAMES` is exactly `commit-msg` and `pre-push`.
- The cleocode root `simple-git-hooks` configuration is not a consumer install path.

### Provider PreCompact hook templates

Owner: `@cleocode/adapters` owns provider shims and installation wiring. `@cleocode/core` owns CLI commands invoked by those shims (`cleo memory precompact-flush`, `cleo safestop`).

Install/refresh entrypoints:

- `cleo init` active-adapter installation path when a provider adapter calls `installProviderHookTemplates`.
- `installProviderHookTemplates(options)` from `@cleocode/adapters`.

Supported installed providers:

| Provider | Source shim | Shared helper | Consumer destination/wiring | Contract |
|---|---|---|---|---|
| `claude-code` | `packages/adapters/src/providers/claude-code/templates/hooks/precompact-safestop.sh` | `packages/adapters/src/providers/shared/templates/hooks/cleo-precompact-core.sh` | `~/.claude/hooks/{precompact-safestop.sh,cleo-precompact-core.sh}` plus `~/.claude/settings.json` `PreCompact` entry | Supported adapter hook install. |
| `cursor` | `packages/adapters/src/providers/cursor/templates/hooks/precompact.sh` | same shared helper | `<project>/.cursor/hooks/{precompact.sh,cleo-precompact-core.sh}` plus `<project>/.cursor/hooks.json` `preCompact` entry | Supported adapter hook install. |
| `opencode` | `packages/adapters/src/providers/opencode/templates/hooks/precompact.sh` | same shared helper | `<project>/.opencode/plugins/hooks/{precompact.sh,cleo-precompact-core.sh}` plus generated `<project>/.opencode/plugins/cleo-precompact.js` | Supported adapter hook install. |

Guarantees:

- Provider shims source the shared helper rather than duplicating core logic.
- Installation is best-effort/idempotent: identical existing files may be skipped; failures in provider hook wiring should not redefine the whole CLEO init contract.
- The installed shell commands use public CLEO CLI commands, not private core internals.

Limited/asset-only surface:

- `gemini-cli` has a `precompact.sh` template and is accepted by the shared installer type union, but the inspected provider install path does not call `installProviderHookTemplates`. It is a shipped asset, not a documented installed consumer hook, until that provider wires the installer.

## Dogfood-only cleocode repository surfaces

The following are explicitly excluded from the consumer template contract:

| Surface | Path/config | Why excluded |
|---|---|---|
| cleocode GitHub Actions | `.github/workflows/*.yml` in this repository | Owner CI for this repository; not rendered by consumer install commands. |
| Root commit hook | `package.json` `simple-git-hooks.commit-msg` -> `scripts/hooks/commit-msg-release-lint.mjs` | Release commit hygiene for cleocode contributors only. |
| Root pre-commit hook | `package.json` `simple-git-hooks.pre-commit` -> `scripts/hooks/pre-commit-docs-drift.mjs` | Docs publication drift guard for this repo only. |
| Hook support scripts | `scripts/hooks/*` | Local maintainer scripts unless separately referenced by a shipped consumer installer. |
| Owner release workflows | `.github/workflows/release.yml`, `release-prepare.yml`, `auto-tag-on-release-merge.yml` | These operate the cleocode repository release process and are not the same as the templated consumer release workflows under `packages/core/templates/workflows/`. |

## Shared surfaces

These are shared product surfaces, not dogfood workflows:

- `packages/core/templates/workflows/README.md` describes the release workflow template placeholder and permission contract.
- `packages/core/src/templates/manifest-data.ts` is the template registry SSoT for shipped template ids, source paths, install paths, and update strategies.
- `packages/core/src/templates/registry.ts` is the read API for template lookup and install-status probes.
- `packages/core/src/init/scaffold-workflows.ts` and `packages/core/src/init/upgrade-workflows.ts` render and refresh consumer release workflow templates.
- `packages/core/src/git/hooks-install.ts` is the project git hook installer contract.
- `packages/adapters/src/providers/shared/hook-template-installer.ts` is the provider hook-template copier used by supported adapters.

## Release command/template contract

Supported release command surfaces are CLI/API operations that manage release plans and rendered consumer workflows; they are not equivalent to cleocode's own GitHub Actions files.

| Surface | Status | Notes |
|---|---|---|
| `cleo release plan` | Supported command surface | Builds the canonical release plan envelope from project state. |
| `cleo release open` | Supported command surface | Dispatches release preparation behavior; consumers should treat the command/API as the contract, not a repo-local workflow filename. |
| `cleo release gate` and `cleo release ivtr-suggest` | Supported command surfaces | Read/check helpers exposed through the release dispatch domain. |
| `cleo upgrade workflows` | Supported workflow-template refresh surface | Detects and refreshes drift for the four shipped release workflow templates. |
| Legacy `release start` / `verify` / `publish` commands | Unsupported | Removed with the legacy pipeline; do not document as consumer setup. |
| cleocode `.github/workflows/release.yml` and tag workflows | Dogfood/owner CI | Not installed into consumers; branch/tag behavior belongs to this repository. |

## Evidence sources

- `packages/core/src/templates/manifest-data.ts`
- `packages/core/templates/workflows/README.md`
- `packages/core/src/init/scaffold-workflows.ts`
- `packages/core/src/init/upgrade-workflows.ts`
- `packages/core/src/git/hooks-install.ts`
- `packages/adapters/src/providers/shared/hook-template-installer.ts`
- `packages/adapters/src/providers/{claude-code,cursor,opencode,gemini-cli}/templates/hooks/*.sh`
- `packages/adapters/src/providers/{claude-code,cursor,opencode}/install.ts`
- `packages/cleo/src/dispatch/domains/upgrade.ts`
- `packages/cleo/src/dispatch/domains/release.ts`
- `package.json` root `simple-git-hooks`
- `.github/workflows/*.yml`
