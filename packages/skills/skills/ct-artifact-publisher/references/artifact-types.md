# Per-Artifact-Type Notes

Detailed notes for each of the nine registered artifact types. Read the entry for the type you are shipping.

## npm-package

**Registry**: `https://registry.npmjs.org` (default) or a private registry.
**Auth**: `NPM_TOKEN` env var, or OIDC trusted publishing in CI.
**Default publish command**: `npm publish`
**Version source**: `package.json:version`
**Idempotency**: errors on duplicate version.

### Edge cases

- **Scoped packages**: `@scope/pkg` requires `--access public` to publish publicly.
- **Provenance flag**: set `options.provenance: true` to emit SLSA L3 attestation via OIDC.
- **Monorepo**: each workspace member is a separate artifact entry; order them by dependency chain (leaves first).
- **Unpublish**: allowed within 72 hours, then rejected by registry policy.
- **Dry-run**: `npm publish --dry-run` produces the tarball without pushing.

## python-wheel

**Registry**: `https://upload.pypi.org/legacy/` (default) or private.
**Auth**: `TWINE_USERNAME=__token__`, `TWINE_PASSWORD=<pypi-api-token>`.
**Default build**: `python -m build`
**Default publish**: `twine upload dist/*`
**Version source**: `pyproject.toml:project.version`

### Edge cases

- **Build backend**: `setuptools`, `hatchling`, `poetry`, `pdm` — all emit wheels into `dist/` but may differ on metadata. Validate the wheel with `twine check dist/*.whl` before upload.
- **No unpublish**: PyPI does not allow unpublish. Yank via admin console only.
- **Dry-run**: `twine upload --repository testpypi` is the de-facto dry-run target.

## python-sdist

Same registry/auth as python-wheel. Build command is `python -m build --sdist`. Produces `.tar.gz` source distributions. Usually shipped alongside a wheel, not standalone.

## go-module

**Registry**: `proxy.golang.org` (immutable).
**Auth**: None — proxy publishes on git tag push.
**Default build**: `go mod tidy`
**Default publish**: tag push triggers the proxy.
**Version source**: `go.mod:module` + git tag.

### Edge cases

- **Immutable**: once a version is cached by the proxy, it cannot be changed or removed.
- **Retraction**: add a `retract` directive in `go.mod` for versions to flag as bad.
- **Module path**: must match the repo URL; a rename requires a new module path.
- **Major versions ≥ 2**: require the major suffix in the module path (`.../v2`).

## cargo-crate

**Registry**: `crates.io` (default).
**Auth**: `CARGO_REGISTRY_TOKEN` env var.
**Default build**: `cargo build --release`
**Default publish**: `cargo publish`
**Version source**: `Cargo.toml:package.version`

### Edge cases

- **Workspaces**: each publishable crate is a separate entry; order by dependency.
- **`cargo publish --dry-run`**: required by ARTP-002; the skill MUST run this first.
- **Yank**: `cargo yank --vers <version>` flags a version as unbuildable; no true unpublish.
- **Rate limits**: crates.io throttles publishes; back off on 429.

## ruby-gem

**Registry**: `rubygems.org` (default).
**Auth**: `GEM_HOST_API_KEY` env var.
**Default build**: `gem build *.gemspec`
**Default publish**: `gem push *.gem`
**Version source**: `*.gemspec:version`

### Edge cases

- **Yank**: `gem yank <gem> -v <version>` removes from index (soft delete).
- **Dry-run**: no native dry-run for `gem push`; simulate by building only.
- **Signing**: RubyGems supports `--sign` with a cert; configure via the gemspec.

## docker-image

**Registry**: configurable — Docker Hub, GHCR, ECR, etc.
**Auth**: `docker login` session, or OIDC federation for GHCR.
**Default build**: `docker build -t <registry>:<tag> .`
**Default publish**: `docker push <registry>:<tag>`
**Version source**: tag string (not a manifest field).

### Edge cases

- **Multi-arch**: use `docker buildx` with `--platform linux/amd64,linux/arm64` and `--push` in one step.
- **Digest**: `docker inspect --format='{{.Id}}' <image>` gives the content-addressed digest.
- **Cosign signing**: delegate to ct-provenance-keeper; cosign keyless signs the image by digest.
- **Overwrites**: Docker pushes silently overwrite the same tag; rely on digest tracking for integrity.
- **Dry-run**: no native dry-run; `docker buildx build` without `--push` is the closest equivalent.

## github-release

**Registry**: `github.com/<owner>/<repo>/releases/<tag>`.
**Auth**: `GITHUB_TOKEN` env var or OIDC.
**Default build**: (none; artifacts are uploaded from disk)
**Default publish**: `gh release create <tag> <files>`
**Version source**: git tag.

### Edge cases

- **Idempotency**: errors if the tag already has a release unless `--discussion-category` or similar flags are used.
- **Deletion**: `gh release delete <tag>` is a full rollback.
- **Body**: pulled from the changelog section for the release version; include checksums in the body.
- **Assets**: each uploaded file produces a separate downloadable URL.

## generic-tarball

**Registry**: configurable — any HTTP target or object store.
**Auth**: custom per target.
**Default build**: `tar czf <output> --exclude=.git .`
**Default publish**: custom; the handler MUST provide one.
**Version source**: computed from the release version, not from a manifest.

### Edge cases

- **Reproducibility**: set `--sort=name --owner=0 --group=0 --mtime='UTC 2020-01-01'` for deterministic tarballs.
- **Exclude list**: always exclude `.git`, `node_modules`, `target`, `dist` (unless that's the payload), and any secret-bearing files.
- **Checksum file**: emit `checksums.txt` alongside the tarball for distribution verification.
