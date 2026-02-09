# Artifact Publish Protocol

**Version**: 1.0.0
**Type**: Conditional Protocol
**Max Active**: 3 protocols (including base)

---

## Trigger Conditions

This protocol activates when the task involves:

| Trigger | Keywords | Context |
|---------|----------|---------|
| Package Publish | "publish", "package", "distribute" | Registry distribution |
| Artifact Build | "artifact", "build artifact", "bundle" | Build output |
| Container Push | "docker push", "container registry", "image publish" | Container distribution |
| Language Package | "crate", "gem", "wheel", "sdist" | Language-specific publishing |
| Multi-Artifact | "publish all", "release artifacts", "multi-package" | Coordinated publish |

**Explicit Override**: `--protocol artifact-publish` flag on task creation.

**Relationship to Release Protocol**: This protocol orchestrates artifact building and publishing. The release protocol orchestrates version bumping, tagging, and changelog. They compose: release triggers artifact-publish for the distribution phase.

---

## Requirements (RFC 2119)

### MUST

| Requirement | Description |
|-------------|-------------|
| ARTP-001 | MUST validate artifact configuration before build |
| ARTP-002 | MUST execute dry-run before any real publish |
| ARTP-003 | MUST follow handler interface contract: `validate -> build -> publish` |
| ARTP-004 | MUST generate SHA-256 checksums for all built artifacts |
| ARTP-005 | MUST record provenance metadata via `record_release()` |
| ARTP-006 | MUST use sequential execution for multi-artifact publish |
| ARTP-007 | MUST set `agent_type: "artifact-publish"` in manifest |
| ARTP-008 | MUST NOT store credentials in config, output, or manifest |
| ARTP-009 | MUST halt pipeline and attempt rollback on first publish failure |

### SHOULD

| Requirement | Description |
|-------------|-------------|
| ARTP-010 | SHOULD verify registry reachability before publish |
| ARTP-011 | SHOULD validate version consistency between config and artifact metadata |
| ARTP-012 | SHOULD log all publish operations to audit trail |
| ARTP-013 | SHOULD verify build output exists and is non-empty before publish |

### MAY

| Requirement | Description |
|-------------|-------------|
| ARTP-020 | MAY batch validation across all artifacts before starting builds |
| ARTP-021 | MAY generate SBOM alongside artifacts (delegate to provenance protocol) |
| ARTP-022 | MAY sign artifacts using configured signing method (delegate to provenance protocol) |

---

## Artifact Lifecycle

### State Machine

```
configured -> validated -> built -> published
                |            |         |
              failed       failed    failed -> rollback
```

### State Transitions

| From | To | Trigger | Condition |
|------|----|---------|-----------|
| configured | validated | `validate_artifact()` returns 0 | Config present, handler exists |
| configured | failed | `validate_artifact()` returns non-0 | Missing config, bad handler |
| validated | built | `build_artifact()` returns 0 | Validate passed |
| validated | failed | `build_artifact()` returns non-0 | Build error |
| built | published | `publish_artifact()` returns 0 | Build output exists |
| built | failed | `publish_artifact()` returns non-0 | Registry error, auth error |
| failed | rollback | Automatic on publish failure | Prior artifacts already published |

### Per-Artifact State Tracking

```json
{
  "type": "npm-package",
  "state": "published",
  "checksum": "sha256:abc123...",
  "buildOutput": "dist/",
  "publishedAt": "2026-01-26T14:00:00Z",
  "dryRun": false
}
```

---

## Handler Interface

### Contract

Every artifact type implements three functions following `lib/release-artifacts.sh`:

```bash
{prefix}_validate(artifact_config_json) -> exit 0|1
{prefix}_build(artifact_config_json, dry_run) -> exit 0|1
{prefix}_publish(artifact_config_json, dry_run) -> exit 0|1
```

### Registered Handlers (9 types)

| Artifact Type | Handler Prefix | Default Build | Default Publish |
|---------------|----------------|---------------|-----------------|
| `npm-package` | `npm_package` | (none) | `npm publish` |
| `python-wheel` | `python_wheel` | `python -m build` | `twine upload dist/*` |
| `python-sdist` | `python_sdist` | `python -m build --sdist` | `twine upload dist/*` |
| `go-module` | `go_module` | `go mod tidy` | Git tag push |
| `cargo-crate` | `cargo_crate` | `cargo build --release` | `cargo publish` |
| `ruby-gem` | `ruby_gem` | `gem build *.gemspec` | `gem push *.gem` |
| `docker-image` | `docker_image` | `docker build -t <registry>:latest .` | `docker push <registry>:latest` |
| `github-release` | `github_release` | (none) | `gh release create` |
| `generic-tarball` | `generic_tarball` | `tar czf` | (custom) |

### Execution Decision Tree

```
Is artifact type in config?
+-- NO -> Exit 85 (E_ARTIFACT_TYPE_UNKNOWN)
+-- YES
    +-- has_artifact_handler(type)?
    |   +-- NO -> Exit 85 (E_ARTIFACT_TYPE_UNKNOWN)
    |   +-- YES -> Proceed
    +-- Is artifact enabled? (.enabled != false)
        +-- NO -> Skip (log: "Artifact disabled")
        +-- YES -> Execute pipeline: validate -> build -> publish
```

### Custom Handlers

```bash
source lib/release-artifacts.sh

my_custom_validate() { ... }
my_custom_build() { ... }
my_custom_publish() { ... }

register_artifact_handler "my-custom-type" "my_custom"
```

---

## Configuration Schema Reference

Artifacts configured in `.cleo/config.json` under `release.artifacts[]`:

```json
{
  "release": {
    "artifacts": [
      {
        "type": "npm-package",
        "enabled": true,
        "package": "package.json",
        "buildCommand": "npm run build",
        "publishCommand": "npm publish",
        "registry": "https://registry.npmjs.org",
        "options": {
          "access": "public",
          "provenance": true,
          "tag": "latest"
        },
        "credentials": {
          "envVar": "NPM_TOKEN",
          "ciSecret": "NPM_TOKEN",
          "required": true
        }
      }
    ]
  }
}
```

### Config Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | MUST | One of 9 registered handler types |
| `enabled` | boolean | MAY | Default: `true`. Set `false` to skip |
| `package` | string | MAY | Path to package manifest |
| `buildCommand` | string | MAY | Override default build command |
| `publishCommand` | string | MAY | Override default publish command |
| `registry` | string | MAY | Registry URL |
| `options` | object | MAY | Handler-specific publish options |
| `credentials` | object | SHOULD | Credential reference (not the credential itself) |

---

## Multi-Artifact Orchestration

### Pipeline Phases

| Phase | Scope | On Failure |
|-------|-------|------------|
| 1. Pre-validate | All artifacts | Halt before any build |
| 2. Build | Sequential per artifact | Halt pipeline |
| 3. Publish | Sequential per artifact | Rollback published artifacts |

Artifacts MUST be processed sequentially in config array order.

### Phase 1: Pre-Validate All

```bash
for artifact in $(echo "$config" | jq -c '.release.artifacts[]'); do
    type=$(echo "$artifact" | jq -r '.type')
    validate_artifact "$type" "$artifact" || exit 86
done
```

### Phase 2: Build Sequential

```bash
built_artifacts=()
for artifact in $(echo "$config" | jq -c '.release.artifacts[]'); do
    type=$(echo "$artifact" | jq -r '.type')
    build_artifact "$type" "$artifact" "$dry_run" || exit 87
    built_artifacts+=("$type")
done
```

### Phase 3: Publish with Rollback

```bash
published_artifacts=()
for artifact in $(echo "$config" | jq -c '.release.artifacts[]'); do
    type=$(echo "$artifact" | jq -r '.type')
    if ! publish_artifact "$type" "$artifact" "$dry_run"; then
        rollback_published "${published_artifacts[@]}"
        exit 88
    fi
    published_artifacts+=("$type")
done
```

---

## Rollback Semantics

### Per-Registry Feasibility

| Artifact Type | Rollback Method | Feasibility |
|---------------|----------------|-------------|
| `npm-package` | `npm unpublish <pkg>@<version>` (within 72h) | Partial |
| `python-wheel` | No API unpublish; yank via PyPI admin | Manual |
| `docker-image` | Registry API delete | Full |
| `github-release` | `gh release delete <tag>` | Full |
| `cargo-crate` | `cargo yank --version <ver>` | Partial (yank only) |
| `ruby-gem` | `gem yank <gem> -v <version>` | Full |
| `go-module` | Retract directive in go.mod | Partial |
| `generic-tarball` | Delete uploaded file | Depends on target |

### Rollback Decision Tree

```
Publish failed at artifact[i]?
+-- i == 0 -> No rollback needed (nothing published)
+-- i > 0
    +-- --no-rollback flag set?
    |   +-- YES -> Log warning, exit 88
    |   +-- NO -> Attempt rollback of artifacts[0..i-1]
    +-- Rollback succeeded?
        +-- YES -> Exit 88 (clean failure)
        +-- NO -> Exit 89 (dirty failure, manual intervention)
```

---

## Registry Abstraction

### Universal Interface

| Operation | Description | Implementation |
|-----------|-------------|----------------|
| `validate` | Check handler exists, config valid | `validate_artifact(type, config)` |
| `build` | Produce artifact from source | `build_artifact(type, config, dry_run)` |
| `publish` | Push artifact to registry | `publish_artifact(type, config, dry_run)` |
| `check_reachability` | Verify registry accessible | Handler-specific (SHOULD) |

### Per-Registry Auth and Behavior

| Registry | Auth Mechanism | Version Source | Publish Idempotency |
|----------|----------------|----------------|---------------------|
| npm | `NPM_TOKEN` env var | `package.json:version` | Error on duplicate |
| PyPI | `TWINE_PASSWORD` env var | `pyproject.toml:version` | Error on duplicate |
| crates.io | `CARGO_REGISTRY_TOKEN` env var | `Cargo.toml:version` | Error on duplicate |
| RubyGems | `GEM_HOST_API_KEY` env var | `*.gemspec:version` | Error on duplicate |
| Docker | `docker login` session | Tag string | Overwrites silently |
| GitHub | `GITHUB_TOKEN` env var | Git tag | Error on duplicate |
| Go Proxy | No auth (tag-based) | `go.mod:module` + Git tag | Immutable |

---

## Credential Handling

### Declarative Model

Agents MUST NOT store, log, or embed credentials. Agents declare credential requirements; the environment provides them.

### Credential Resolution Order

| Priority | Source | Context |
|----------|--------|---------|
| 1 | Environment variable (`credentials.envVar`) | Local and CI |
| 2 | CI secret injection (`credentials.ciSecret`) | CI only |
| 3 | Credential manager (keychain/vault) | Future |

### Validation Decision Tree

```
Is credentials.required == true?
+-- NO -> Proceed without credential check
+-- YES
    +-- Is $envVar set in environment?
    |   +-- YES -> Credential available, proceed
    |   +-- NO
    |       +-- Is --dry-run set?
    |       |   +-- YES -> Warn, proceed (skip publish)
    |       |   +-- NO -> Exit 90 (credential missing)
    +-- Is credential value non-empty?
        +-- YES -> Proceed
        +-- NO -> Exit 90 (credential missing)
```

### Agent Prohibitions

| MUST NOT | Rationale |
|----------|-----------|
| Echo/log credential values | Exposure in audit trail |
| Store credentials in config.json | Committed to version control |
| Include credentials in manifest entry | Visible to orchestrator |
| Pass credentials as CLI arguments | Visible in `ps` output |
| Store credentials in output files | Readable by other agents |

---

## Error Codes (85-89)

| Code | Constant | Meaning | Recovery |
|------|----------|---------|----------|
| 85 | `E_ARTIFACT_TYPE_UNKNOWN` | Artifact type not registered | Check config type field, verify handler exists |
| 86 | `E_ARTIFACT_VALIDATION_FAILED` | Pre-build validation failed | Fix package manifest, check tool availability |
| 87 | `E_ARTIFACT_BUILD_FAILED` | Build command returned non-zero | Check build output, verify dependencies |
| 88 | `E_ARTIFACT_PUBLISH_FAILED` | Publish failed (rollback attempted) | Check registry auth, network, version conflicts |
| 89 | `E_ARTIFACT_ROLLBACK_FAILED` | Rollback failed | Manual intervention required |

### Recoverability

| Code | Recoverable | Agent Action |
|------|:-----------:|--------------|
| 85 | No | Fix config, re-run |
| 86 | Yes | Fix manifest, retry |
| 87 | Yes | Fix build, retry |
| 88 | Yes | Fix auth/network, retry |
| 89 | No | Manual intervention |

---

## Validation Gates

### Pre-Publish Checklist

| Gate | Check | Required | Command |
|------|-------|----------|---------|
| Config Valid | `validate_release_config()` returns 0 | MUST | `source lib/release-config.sh` |
| Handler Exists | `has_artifact_handler(type)` returns 0 | MUST | `source lib/release-artifacts.sh` |
| Artifact Valid | `validate_artifact(type, config)` returns 0 | MUST | Per handler |
| Version Consistent | Package manifest version matches release | SHOULD | Handler-specific |
| Credential Available | `$envVar` is set and non-empty | MUST (if required) | `[[ -n "${!envVar}" ]]` |
| Dry-Run Success | Full pipeline succeeds with `dry_run=true` | MUST | Per ARTP-002 |
| Build Output Exists | Build produced expected files | SHOULD | Handler-specific |
| Checksum Generated | SHA-256 computed for all artifacts | MUST | `sha256sum <artifact>` |
| Registry Reachable | Network check to registry | SHOULD | Handler-specific |
| Provenance Recorded | `record_release()` called | MUST | Post-publish |

### Gate Execution Order

```
1. Config Valid            (blocks all)
2. Handler Exists          (blocks validate)
3. Credential Available    (blocks publish)
4. Artifact Valid          (blocks build)
5. Dry-Run Success         (blocks real publish)
6. Build + Checksum        (blocks publish)
7. Registry Reachable      (blocks publish)
8. Publish
9. Provenance Recorded     (post-publish)
```

---

## Output Format

### File Output

```markdown
# Artifact Publish: {Description}

**Task**: T####
**Date**: YYYY-MM-DD
**Status**: complete|partial|blocked
**Agent Type**: artifact-publish

---

## Summary

{2-3 sentence summary of artifacts published}

## Pipeline Results

| # | Artifact Type | State | Checksum | Registry |
|---|---------------|-------|----------|----------|
| 1 | npm-package | published | sha256:abc1... | npmjs.org |
| 2 | docker-image | published | sha256:def2... | ghcr.io |

## Validation Results

| Gate | Status | Notes |
|------|--------|-------|
| Config Valid | PASS | 2 artifacts configured |
| Handlers Exist | PASS | npm-package, docker-image |
| Credentials | PASS | NPM_TOKEN, GITHUB_TOKEN set |
| Dry-Run | PASS | All pipelines succeeded |
| Checksums | PASS | SHA-256 generated |
| Provenance | PASS | Recorded to releases.json |
```

### Manifest Entry

```bash
cleo research add \
  --title "Artifact Publish: vX.Y.Z" \
  --file "YYYY-MM-DD_artifact-publish-vXYZ.md" \
  --topics "artifact-publish,npm-package,docker-image,release" \
  --findings "2 artifacts published,All checksums verified,Provenance recorded" \
  --status complete \
  --task T#### \
  --not-actionable \
  --agent-type artifact-publish
```

---

## Integration Points

### Base Protocol

- Inherits task lifecycle (focus, execute, complete)
- Inherits manifest append requirement
- Inherits error handling patterns

### Protocol Interactions

| Combined With | Behavior |
|---------------|----------|
| release | Release protocol triggers artifact-publish for distribution phase |
| provenance | Artifact-publish calls provenance for signing and attestation |
| implementation | Implementation builds are inputs to artifact builds |
| contribution | Contribution records feed artifact provenance chain |

### Composition with Release Protocol

```
Release Protocol                    Artifact Publish Protocol
---                                 ---
1. Version bump
2. Changelog generation
3. Validation gates
4. Git commit + tag
5. ---- HANDOFF ----------------------> 6. Load artifact config
                                        7. Pre-validate all artifacts
                                        8. Build all artifacts
                                        9. Publish all artifacts
                                       10. Record provenance
11. <--- RETURN ---------------------- 11. Return pipeline results
12. Push to remote
13. Update release status
```

### CI/CD Integration

| Event | Workflow | Artifact Action |
|-------|----------|-----------------|
| Tag push `v*.*.*` | `release.yml` | Build tarball, checksums, GitHub Release |
| Manual dispatch | `artifact-publish.yml` | Full pipeline from config |
| PR merge to main | `build-check.yml` | Dry-run only (validation) |

---

## Workflow Sequence

```
 1. Read task requirements (cleo show T####)
 2. Set focus (cleo focus set T####)
 3. Load release config (source lib/release-config.sh)
 4. Enumerate enabled artifacts (get_artifact_type)
 5. Pre-validate all artifacts (validate_artifact loop)
 6. Check credentials for all artifacts
 7. Execute dry-run for all artifacts
 8. Build all artifacts sequentially
 9. Generate checksums for all built artifacts
10. Publish all artifacts sequentially (rollback on failure)
11. Record provenance (record_release)
12. Write output file
13. Append manifest entry
14. Complete task (cleo complete T####)
15. Return: "Artifact publish complete. See MANIFEST.jsonl for summary."
```

---

## Example

**Task**: Publish CLEO v0.85.0 artifacts

**Config** (`.cleo/config.json` excerpt):
```json
{
  "release": {
    "artifacts": [
      {
        "type": "npm-package",
        "enabled": true,
        "package": "mcp-server/package.json",
        "buildCommand": "cd mcp-server && npm run build",
        "options": { "access": "public" },
        "credentials": { "envVar": "NPM_TOKEN", "required": true }
      },
      {
        "type": "generic-tarball",
        "enabled": true,
        "buildCommand": "tar czf cleo-0.85.0.tar.gz --exclude=.git ."
      }
    ]
  }
}
```

**Manifest Entry Command**:
```bash
cleo research add \
  --title "Artifact Publish: v0.85.0" \
  --file "2026-02-09_artifact-publish-v0850.md" \
  --topics "artifact-publish,npm-package,generic-tarball,v0.85.0" \
  --findings "npm-package published to npmjs,tarball built,Checksums verified,Provenance recorded" \
  --status complete \
  --task T3200 \
  --epic T3147 \
  --not-actionable \
  --agent-type artifact-publish
```

**Return Message**:
```
Artifact publish complete. See MANIFEST.jsonl for summary.
```

---

## Anti-Patterns

| Pattern | Why Avoid |
|---------|-----------|
| Publishing without dry-run first | Irreversible registry state |
| Storing credentials in config.json | Committed to VCS, visible to agents |
| Parallel multi-artifact publish | Race conditions, partial state on failure |
| Skipping checksum generation | Cannot verify artifact integrity |
| Publishing without version check | Duplicate version errors |
| Ignoring publish failures | Inconsistent state across registries |
| Logging credential values | Exposure in audit trail and context |
| Building without validation | Wastes time on invalid config |
| Manual rollback without recording | Lost provenance chain |
| Hardcoding registry URLs | Breaks across environments |

---

*Protocol Version 1.0.0 - Artifact Publish Protocol*
