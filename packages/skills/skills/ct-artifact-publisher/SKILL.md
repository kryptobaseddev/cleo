---
name: ct-artifact-publisher
description: "Builds and publishes artifacts to registries (npm, PyPI, cargo, docker, GitHub releases, generic tarballs) following the validate, then dry-run, then build, then publish, then record-provenance pipeline. Invoked by ct-release-orchestrator as a sub-skill when a release has artifact config. Never stores credentials in output or manifest (ARTP-008), always dry-runs first (ARTP-002), halts and attempts rollback on failure (ARTP-009). Triggers when a release config has at least one enabled artifact handler."
---

# Artifact Publisher

## Overview

Sub-protocol of ct-release-orchestrator. Runs the build-then-publish pipeline for every enabled artifact in `release.artifacts[]`: pre-validates the config, dry-runs each build, produces SHA-256 checksums, publishes sequentially, and delegates signing plus attestation to ct-provenance-keeper. Handles nine artifact types via a uniform handler interface.

## Core Principle

> Every artifact gets a checksum, a dry-run, and a rollback plan.

## Immutable Constraints

| ID | Rule | Enforcement |
|----|------|-------------|
| ARTP-001 | Artifact config MUST be validated before build. | `validate_artifact()` must return 0 before `build_artifact()` runs; exit 86. |
| ARTP-002 | Dry-run MUST execute before any real publish. | Pipeline halts if dry-run fails; exit 86. |
| ARTP-003 | Every handler MUST implement `{prefix}_validate`, `{prefix}_build`, `{prefix}_publish`. | Missing handler function exits 85. |
| ARTP-004 | SHA-256 checksums MUST be generated for every built artifact. | Missing checksum blocks publish. |
| ARTP-005 | Provenance metadata MUST be recorded via `record_release()` after publish. | Composition handoff to ct-provenance-keeper. |
| ARTP-006 | Multi-artifact publish MUST execute sequentially. | No parallel publishes; prevents race conditions. |
| ARTP-007 | Manifest entry MUST set `agent_type: "artifact-publish"`. | Validator rejects any other value. |
| ARTP-008 | Credentials MUST NOT appear in config, output, or manifest. | Agents declare env vars by name only; actual values stay in the environment. |
| ARTP-009 | Pipeline MUST halt and attempt rollback on the first publish failure. | Exit 88 on rollback success, exit 89 on rollback failure. |

## Supported Artifact Types

Nine registered handler types cover the common publishing surface. Each has a default build and publish command that the handler can override via config.

| Type | Build command (default) | Publish command (default) | Registry |
|------|-------------------------|---------------------------|----------|
| `npm-package` | (none, `npm publish` reads `files`) | `npm publish` | npmjs.org |
| `python-wheel` | `python -m build` | `twine upload dist/*` | pypi.org |
| `python-sdist` | `python -m build --sdist` | `twine upload dist/*` | pypi.org |
| `go-module` | `go mod tidy` | (tag push triggers proxy) | proxy.golang.org |
| `cargo-crate` | `cargo build --release` | `cargo publish` | crates.io |
| `ruby-gem` | `gem build *.gemspec` | `gem push *.gem` | rubygems.org |
| `docker-image` | `docker build -t <ref> .` | `docker push <ref>` | configurable (OCI) |
| `github-release` | (none) | `gh release create` | github.com |
| `generic-tarball` | `tar czf ...` | (custom) | configurable |

Per-type edge cases and exact invocation patterns live in [references/artifact-types.md](references/artifact-types.md).

## Handler Interface

Every handler is three Bash functions with a uniform contract:

```bash
# Validate config, check tool availability, verify version consistency.
{prefix}_validate(artifact_config_json) -> exit 0 | 1

# Produce build output in a known location. Respects dry_run.
{prefix}_build(artifact_config_json, dry_run) -> exit 0 | 1

# Push build output to the registry. Respects dry_run.
{prefix}_publish(artifact_config_json, dry_run) -> exit 0 | 1
```

A full pseudocode example for a custom handler is in [references/handler-interface.md](references/handler-interface.md). To register a new handler:

```bash
source lib/release-artifacts.sh
register_artifact_handler "my-custom-type" "my_custom"
```

## Pipeline Phases

The sub-protocol runs in three ordered phases:

| Phase | Scope | Halt condition |
|-------|-------|----------------|
| 1. Pre-validate | All artifacts | Halt before any build |
| 2. Build | Sequential per artifact | Halt pipeline |
| 3. Publish | Sequential per artifact | Rollback published artifacts, then halt |

Sequential order matters: if artifact 1 (npm) publishes successfully but artifact 2 (docker) fails, the pipeline rolls back artifact 1 using `npm unpublish` (within 72 hours) before exiting. Rollback feasibility varies by registry — see composition.md in ct-release-orchestrator for the full table.

## Credentials Handling

Credentials are referenced, never stored. The skill reads environment variables by name from the config and verifies they are set before publishing:

```json
{
  "credentials": {
    "envVar": "NPM_TOKEN",
    "ciSecret": "NPM_TOKEN",
    "required": true
  }
}
```

The skill MUST NOT:

- Echo or log credential values.
- Write credential values to `config.json` or the manifest entry.
- Pass credentials as CLI arguments (visible in `ps`).
- Include credential values in output files.

In CI, trusted publishing is preferred: the workflow exchanges an OIDC token for a short-lived registry credential, and the skill never sees the token. The CI path is already configured in `.github/workflows/release.yml` for npm.

Missing credentials exit 90 (`E_PROVENANCE_CONFIG_INVALID` bubbled from provenance) or fail the credential check with a clear error pointing at the missing env var.

## Integration

Validate the sub-protocol entry through `cleo check protocol`:

```bash
cleo check protocol \
  --protocolType artifact-publish \
  --taskId T4901 \
  --artifactType npm-package \
  --buildPassed true
```

Exit code 0 = artifact published successfully. Exit code 85 = unknown artifact type. Exit code 86 = validation failed. Exit code 87 = build failed. Exit code 88 = publish failed, rollback attempted. Exit code 89 = rollback failed, dirty state.

This skill always hands off to ct-provenance-keeper after publish, before writing the manifest entry, so the provenance chain is recorded in the same pipeline.

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Publishing without a dry-run first | Irreversible registry state on failure | ARTP-002 requires dry-run; the skill refuses to skip it |
| Storing credentials in `config.json` | Committed to VCS, visible to every agent | Reference by env var name; actual values stay in the environment |
| Parallel multi-artifact publish | Race conditions; partial state on failure | Sequential execution in config order (ARTP-006) |
| Skipping checksum generation | Cannot verify artifact integrity downstream | Generate SHA-256 for every build output |
| Logging credential values | Exposure in audit trail and agent context | Never echo credentials; test only the env var is set, not its value |
| Hardcoding registry URLs | Breaks across environments | Use the `registry` field in the config |
| Manual rollback without recording | Lost provenance chain | Record rollback in the manifest and the `releases.json` chain |
| Building before validating | Wastes time on invalid config | Pre-validate every artifact before the first build |
| Ignoring rollback failures | Leaves the pipeline in dirty state | Exit 89 and require manual intervention — do not retry blindly |

## Critical Rules Summary

1. Every artifact MUST be pre-validated before any build starts.
2. Every publish MUST be preceded by a successful dry-run.
3. Credentials MUST NEVER leave the environment — no logging, no config, no manifest.
4. Publishes run sequentially in config order; no parallel publishes.
5. SHA-256 checksums are mandatory for every build output.
6. Provenance MUST be recorded via `record_release()` after publish, via ct-provenance-keeper.
7. On first publish failure, halt and attempt rollback; exit 88 on clean rollback, 89 on dirty.
8. Validate every run via `cleo check protocol --protocolType artifact-publish`.
