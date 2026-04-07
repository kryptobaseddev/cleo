# Release Type Checklists

The release parent protocol handles several release types. Each type has a distinct checklist. Pick the checklist that matches the release config before running ship.

## Source-Only Release

No package is produced. Used for docs, spec updates, and internal code changes that precede a later packaged release.

### Checklist

- [ ] Version is a valid semver.
- [ ] Changelog has entries for every task in the release.
- [ ] `release.artifacts` is `[]` or all entries are `enabled: false`.
- [ ] Tests pass (opt-in via `--run-tests` for major/minor).
- [ ] Tag created and pushed.
- [ ] Manifest entry recorded with `agent_type: "documentation"`.

### Commands

```bash
cleo release ship v2026.4.5 --bump-version --create-tag --push --no-artifacts
cleo check protocol --protocolType release --version v2026.4.5 --hasChangelog true
```

## npm-Package Release

Publishes one or more npm packages from the monorepo. Uses `npm publish --provenance` for SLSA L3 keyless attestation via the repository's OIDC trust.

### Checklist

- [ ] `package.json#version` matches the release version in every publishable workspace.
- [ ] `release.artifacts[]` has an `npm-package` entry with `options.access: "public"` (for scoped public packages) or `options.access: "restricted"`.
- [ ] `options.provenance: true` is set on the npm-package entry.
- [ ] Trusted publishing is configured in npm registry settings.
- [ ] The CI workflow `.github/workflows/release.yml` will run the publish step with OIDC identity.
- [ ] Post-publish: the attestation reference is recorded in `.cleo/releases.json` via `record_release()`.

### Commands

```bash
cleo release ship v2026.4.5 --bump-version --create-tag --push
# CI handles the publish + attestation; the skill records the result.
cleo check protocol --protocolType release --version v2026.4.5 --hasChangelog true
cleo check protocol --protocolType artifact-publish --artifactType npm-package --buildPassed true
cleo check protocol --protocolType provenance --hasAttestation true --hasSbom true
```

## docker-image Release

Builds and pushes a container image to GHCR or another OCI registry, signs with cosign keyless, and generates a CycloneDX SBOM.

### Checklist

- [ ] `Dockerfile` at the image root is clean and reproducible.
- [ ] `release.artifacts[]` has a `docker-image` entry with the target registry.
- [ ] `release.security.provenance.framework: "slsa"` and `level: "SLSA_BUILD_LEVEL_3"`.
- [ ] Cosign keyless signing is wired through the CI OIDC identity.
- [ ] SBOM generator (syft or equivalent) is available in the CI image.
- [ ] Post-publish: the image digest, signature, and SBOM reference are recorded.

### Commands

```bash
cleo release ship v2026.4.5 --bump-version --create-tag --push
# CI runs: docker build → cosign sign → cosign attest → syft sbom → push
cleo check protocol --protocolType artifact-publish --artifactType docker-image --buildPassed true
cleo check protocol --protocolType provenance --hasAttestation true --hasSbom true
```

## cargo-crate Release

Publishes one or more crates from the Rust workspace to crates.io.

### Checklist

- [ ] `Cargo.toml#version` matches the release version for every publishable crate.
- [ ] `cargo publish --dry-run` succeeds locally and in CI.
- [ ] Inter-crate version bumps are consistent across the workspace.
- [ ] `CARGO_REGISTRY_TOKEN` is available in CI (not in config.json).
- [ ] Dependent crates publish after their dependencies (dependency order matters).

### Commands

```bash
cleo release ship v2026.4.5 --bump-version --create-tag --push
# CI runs: cargo test → cargo publish --dry-run → cargo publish
cleo check protocol --protocolType artifact-publish --artifactType cargo-crate --buildPassed true
```

## github-tarball Release

Creates a source tarball and attaches it to a GitHub Release. Optional cosign signing.

### Checklist

- [ ] Tarball exclude list is correct (no `.git/`, no secrets, no generated files).
- [ ] Checksum file (`checksums.txt`) is generated alongside the tarball.
- [ ] GitHub Release body includes the changelog section and the checksums.
- [ ] If signing is enabled, cosign keyless produces a `.sig` file alongside the tarball.

### Commands

```bash
cleo release ship v2026.4.5 --bump-version --create-tag --push
# gh release create runs in CI with the tarball attached
cleo check protocol --protocolType artifact-publish --artifactType github-release --buildPassed true
```

## Multi-Artifact Release

A release with more than one artifact type — typical for a major version that ships npm + docker + GitHub Release together.

### Checklist

- [ ] Every artifact's checklist above is completed.
- [ ] Artifacts are declared in a stable order in `release.artifacts[]` — the sub-protocol publishes sequentially in config order.
- [ ] Rollback semantics per artifact are understood (see references/composition.md).
- [ ] The provenance chain references every artifact digest in the same attestation.

### Commands

```bash
cleo release ship v2026.4.5 --bump-version --create-tag --push
# CI orchestrates all publishes; skill records the unified chain
cleo check protocol --protocolType release --version v2026.4.5 --hasChangelog true
```

## Which Checklist Wins?

If `release.artifacts[]` contains one entry, pick the checklist for that entry type. If it contains multiple entries, use the Multi-Artifact checklist and run each single-artifact checklist for the sub-types. If it is empty, use the Source-Only checklist.
