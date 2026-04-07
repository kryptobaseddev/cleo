---
name: ct-release-orchestrator
description: "Orchestrates the full release pipeline: version bump, then changelog, then commit, then tag, then conditionally forks to artifact-publish and provenance based on release config. Parent protocol that composes ct-artifact-publisher and ct-provenance-keeper as sub-protocols: not every release publishes artifacts (source-only releases skip it), and artifact publishers delegate signing and attestation to provenance. Use when shipping a new version, running cleo release ship, or promoting a completed epic to released status."
---

# Release Orchestrator

## Overview

Owns the top of the release pipeline: semver bump, changelog, release commit, and git tag. Composes two sub-protocols conditionally — ct-artifact-publisher when the release config has enabled artifacts, and ct-provenance-keeper when signing or attestation is required. Source-only releases (docs, spec changes) stop after the tag and skip both sub-protocols.

## Core Principle

> Release is the parent protocol; artifact-publish and provenance are conditional sub-protocols.

## Immutable Constraints

| ID | Rule | Enforcement |
|----|------|-------------|
| RLSE-001 | Version MUST follow semantic versioning (`v{major}.{minor}.{patch}`). | `validateReleaseProtocol` rejects non-semver strings; exit 53. |
| RLSE-002 | Changelog MUST be updated with all changes before the tag. | `hasChangelog: false` fails validation unless `--no-changelog` is explicit. |
| RLSE-003 | All validation gates MUST pass before the release proceeds. | Ship halts on any gate failure; exit 54. |
| RLSE-004 | Release MUST be tagged in version control. | Missing tag fails validation; exit 56. |
| RLSE-005 | Breaking changes MUST be documented with a migration path. | Required section in the changelog entry. |
| RLSE-006 | Version MUST be consistent across all files listed in `release.versionBump`. | Mismatched files fail validation; exit 55. |
| RLSE-007 | Manifest entry MUST set `agent_type: "documentation"`. | Validator rejects any other value. |
| RLSE-008 | Parent protocol MUST hand off to artifact-publish when `release.artifacts` is non-empty. | Composition invariant from ARTP-005. |
| RLSE-009 | Provenance chain MUST be recorded for every signed release. | Composition invariant from PROV-005. |

## Composition Pipeline

The release parent protocol composes with the artifact-publish and provenance sub-protocols via explicit handoffs:

```
Release Protocol                        Artifact Publish Protocol
---                                     ---
1.  Version bump
2.  Changelog generation
3.  Validation gates
4.  Git commit + tag
5.  ---- HANDOFF ------------------> 6.  Load artifact config
                                     7.  Pre-validate all artifacts
                                     8.  Build all artifacts
                                     9.  ---- HANDOFF ----> Provenance Protocol
                                                             10. Compute digests
                                                             11. Generate in-toto attestation
                                                             12. Sign (sigstore keyless)
                                                             13. Record chain in releases.json
                                     14. <--- RETURN ----
                                     15. Publish signed artifacts
                                     16. Record provenance to releases.json
17. <--- RETURN ---------------------- 
18. Push to remote
19. Update release status to "released"
```

Each handoff uses a distinct exit code:

| Edge | Exit code | Meaning |
|------|-----------|---------|
| Release → artifact-publish | 65 (`HANDOFF_REQUIRED`) | Parent yields control to the sub-protocol |
| artifact-publish → provenance | 65 (`HANDOFF_REQUIRED`) | Sub-protocol delegates signing |
| provenance → artifact-publish | 0 on success | Return to parent sub-protocol |
| artifact-publish → release | 0 on success, 88 on publish fail | Return to parent with result |
| release → tag push | 0 on success, 56 on tag fail | Final commit |

Partial-failure rollback semantics are documented in [references/composition.md](references/composition.md).

## Conditional Trigger Matrix

Not every release needs both sub-protocols. The parent decides based on `release.artifacts` and `release.security.provenance.enabled`:

| Release type | Needs artifact-publish | Needs provenance |
|--------------|:---------------------:|:----------------:|
| `source-only` (docs, spec changes, code-only merges without a package) | no | no |
| `npm-package` | yes | yes (SLSA L3 via npm `--provenance`) |
| `docker-image` | yes | yes (cosign keyless attestation) |
| `cargo-crate` | yes | yes (GPG or sigstore) |
| `github-tarball` | yes | optional (MAY sign via cosign) |
| `multi-artifact` (npm + docker + tarball combo) | yes | yes |

The parent skill inspects `.cleo/config.json#release.artifacts[]`. If the array is empty or all entries are disabled, the release is `source-only` and the pipeline stops after the tag.

## CI Integration

The existing `.github/workflows/release.yml` uses `npm publish --provenance` with the repository's OIDC trust configuration, producing SLSA L3 keyless attestations automatically. This skill's responsibility is to ensure the resulting chain is recorded in the manifest entry and in `.cleo/releases.json`, not to re-implement the signing step. When CI has already produced an attestation, the skill MUST read its reference from the workflow output and record it verbatim.

## Integration

Invoke the parent pipeline via `cleo release ship`, then validate with `cleo check protocol`:

```bash
# Kick off the release pipeline.
cleo release ship v2026.4.5 \
  --epic T260 \
  --bump-version \
  --create-tag \
  --push

# Validate the parent protocol entry.
cleo check protocol \
  --protocolType release \
  --taskId T4900 \
  --version v2026.4.5 \
  --hasChangelog true
```

Exit code 0 = release complete. Exit code 50 = release not found. Exit code 54 = validation gate failed. Exit code 55 = version bump failed. Exit code 56 = tag creation failed. Exit code 88 = artifact publish failed (bubbled from sub-protocol). Exit code 94 = attestation invalid (bubbled from provenance).

For source-only releases, pass `--no-artifacts` to skip the artifact-publish handoff. Every other release type leaves the default behavior alone.

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Publishing artifacts before running validation gates | Can't roll back a successful publish on a failed build | Follow the pipeline order: gates → commit → tag → publish |
| Pushing the git tag before publishing artifacts | Tag points to a commit whose packages never shipped | Push the tag after artifacts are live, or use the same job |
| Skipping the dry-run phase | Irreversible registry state on first real attempt | ARTP-002 requires dry-run; the parent skill refuses to skip it |
| Source-only releases triggering artifact-publish | Wasted CI time, false SLSA attestations | Check `release.artifacts` before handoff; skip if empty |
| Not recording the provenance chain in releases.json | Canon loses the commit → build → artifact → attestation link | Parent MUST record even when CI generated the attestation |
| Overusing `--force` to bypass epic completeness | Ships partial epics without review | Use the guard mode `warn` and address gaps explicitly |
| Mutating a `released` entry after the fact | Canon must be immutable once shipped | Create a new release entry for the hotfix |
| Running ship on a dirty worktree | Commits scoop up unrelated changes | Require a clean worktree before step 1 |

## Critical Rules Summary

1. Version MUST be valid semver; the parent skill refuses non-semver strings.
2. The changelog MUST be updated before the tag — no exceptions beyond explicit `--no-changelog`.
3. All validation gates MUST pass before the commit step.
4. The pipeline composes with artifact-publish and provenance only when the release config calls for it.
5. Exit codes bubble up unchanged: 88 from artifact-publish and 94 from provenance surface at the parent.
6. `released` entries are immutable; hotfixes go into new entries.
7. Manifest entry MUST set `agent_type: "documentation"` and record the full chain via `record_release()`.
8. Always validate via `cleo check protocol --protocolType release` before declaring the release done.
