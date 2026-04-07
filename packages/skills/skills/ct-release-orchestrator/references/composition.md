# Release Protocol Composition

The release parent protocol composes with two sub-protocols: `artifact-publish` and `provenance`. This file explains the composition contract, the exit-code flow, and the rollback semantics when a sub-protocol fails mid-pipeline.

## Exit Code Flow

The composed pipeline has a single downstream exit-code convention: the parent bubbles whatever the sub-protocol returned, so the orchestrator can distinguish which layer failed.

```
release → artifact-publish → provenance
   54           86                90-94
   55           87
   56           88
               (89)
```

| Code | Source | Meaning |
|------|--------|---------|
| 54 | release | `E_VALIDATION_FAILED` — parent-level gate failed (tests, schema, version) |
| 55 | release | `E_VERSION_BUMP_FAILED` — bump script failed |
| 56 | release | `E_TAG_CREATION_FAILED` — git tag/commit failed |
| 65 | any | `HANDOFF_REQUIRED` — yielding control to next layer (not a failure) |
| 85 | artifact-publish | `E_ARTIFACT_TYPE_UNKNOWN` — handler missing |
| 86 | artifact-publish | `E_ARTIFACT_VALIDATION_FAILED` — pre-build validation |
| 87 | artifact-publish | `E_ARTIFACT_BUILD_FAILED` — build command failed |
| 88 | artifact-publish | `E_ARTIFACT_PUBLISH_FAILED` — publish failed (rollback attempted) |
| 89 | artifact-publish | `E_ARTIFACT_ROLLBACK_FAILED` — rollback failed, dirty state |
| 90 | provenance | `E_PROVENANCE_CONFIG_INVALID` |
| 91 | provenance | `E_SIGNING_KEY_MISSING` |
| 92 | provenance | `E_SIGNATURE_INVALID` |
| 93 | provenance | `E_DIGEST_MISMATCH` |
| 94 | provenance | `E_ATTESTATION_INVALID` |

The parent MUST NOT remap sub-protocol exit codes. A caller reading `cleo release ship` output needs to know exactly which step failed.

## Rollback Semantics

### Single-artifact publish

On a single-artifact release that fails at publish, the parent has a clean answer: the artifact was never on the registry, so there's nothing to roll back. The parent reports exit 88 and stops. The git tag may or may not have been created; the parent MUST NOT delete it. Tag deletion is a manual operation.

### Multi-artifact publish

On a multi-artifact release (e.g., npm + docker + tarball), the parent relies on the artifact-publish sub-protocol's per-registry rollback semantics. The sub-protocol keeps an `published_artifacts[]` list as it goes. On a failure at artifact[i], it attempts to roll back `artifacts[0..i-1]` using per-registry methods:

| Registry | Rollback |
|----------|----------|
| npm | `npm unpublish <pkg>@<version>` (within 72 hours only) |
| docker | registry API delete |
| cargo | `cargo yank` (soft, not a real unpublish) |
| github-release | `gh release delete` |
| generic-tarball | delete uploaded file (depends on target) |

If rollback succeeds across every already-published artifact, the pipeline exits 88 (clean failure). If any rollback fails, it exits 89 (dirty failure) and a human MUST intervene.

### Git tag and commit

The parent creates the release commit and tag **before** handing off to artifact-publish. This is deliberate: the commit carries the final state that the artifacts represent, and the tag is needed by CI jobs that watch for `v*.*.*` pushes. If artifact-publish fails, the tag remains; a re-run points at the same commit.

The parent MUST NOT auto-delete the tag on failure. If a human operator wants to retract the release, they use `git tag -d` and `git push --delete` manually after inspecting the dirty state.

## Handoff Data

Each handoff passes a minimal set of data to the next layer:

### Release → artifact-publish

```json
{
  "version": "v2026.4.5",
  "taskId": "T4900",
  "epicId": "T260",
  "commitSha": "3a2f1e9c...",
  "tagName": "v2026.4.5",
  "changelogPath": "CHANGELOG.md",
  "artifactsConfig": [ /* release.artifacts[] from config.json */ ]
}
```

### artifact-publish → provenance

```json
{
  "version": "v2026.4.5",
  "commitSha": "3a2f1e9c...",
  "builtArtifacts": [
    { "type": "npm-package", "path": "dist/cleo-2026.4.5.tgz", "sha256": "<hex>" },
    { "type": "docker-image", "digest": "sha256:<hex>" }
  ]
}
```

### provenance → artifact-publish (return)

```json
{
  "attestationPath": ".cleo/attestations/v2026.4.5.intoto.jsonl",
  "signed": true,
  "slsaLevel": "SLSA_BUILD_LEVEL_3",
  "transparencyLog": {
    "index": "123456789",
    "url": "https://rekor.sigstore.dev"
  }
}
```

### artifact-publish → release (return)

```json
{
  "published": [
    { "type": "npm-package", "registry": "npmjs.org", "publishedAt": "2026-04-06T19:50:00Z" },
    { "type": "docker-image", "registry": "ghcr.io", "publishedAt": "2026-04-06T19:51:12Z" }
  ],
  "attestationPath": ".cleo/attestations/v2026.4.5.intoto.jsonl"
}
```

## CI Handoff

In CI, the composition collapses: `.github/workflows/release.yml` runs all three sub-protocols in a single job sequence. The parent skill's job is to:

1. Assemble the handoff data structures above from the task + config.
2. Invoke the artifact-publish sub-protocol (or, in CI, let the workflow do it).
3. Record the returned provenance chain in `.cleo/releases.json` via `record_release()`.
4. Complete the task.

When CI is driving the workflow, the skill's role is record-keeping, not execution. The skill MUST NOT double-publish.

## Source-Only Releases

A source-only release (`release.artifacts == []`) skips both sub-protocols entirely. The pipeline ends after step 4 (git commit + tag). The parent still writes the manifest entry and sets `agent_type: "documentation"`; it just records a shorter chain.

Source-only releases are common for:

- Documentation-only releases
- Spec or protocol updates
- Code changes that don't produce a publishable artifact (e.g., internal refactors before the next package bump)
