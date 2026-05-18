# CLEO GitHub Actions workflow templates

This directory contains CLEO's templated GitHub Actions workflows for the
release pipeline defined in
`.cleo/rcasd/T9345/research/SPEC-T9345-release-pipeline-v2.md`. Templates
are project-agnostic: they ship with `{{PLACEHOLDER}}` markers that are
resolved at scaffold time by `cleo init --workflows` (T9531) against the
local `.cleo/project-context.json` and the ADR-061 tool resolver.

## Template files

| Template                          | SPEC section | Purpose                                                |
|-----------------------------------|--------------|--------------------------------------------------------|
| `release-prepare.yml.tmpl`        | §5.1         | Cut release branch, bump version, open bump-PR.        |
| `release-publish.yml.tmpl`        | §5.2         | Publish + tag once the bump-PR is merged.              |
| `release-fanout.yml.tmpl`         | §5.3         | Best-effort post-publish fanout (docs, docker, etc.).  |
| `release-rollback.yml.tmpl`       | §5.4 *(T9535, future)* | Rollback workflow (revert PR + npm deprecate). |

## Template contract

- Templates MUST use `{{PLACEHOLDER}}` markers compatible with simple regex
  substitution (`s/{{NAME}}/value/g`). They MUST NOT use Mustache, Handlebars,
  or any nested-syntax templating engine — the scaffold step relies on
  deterministic, single-pass regex replacement so a stale template can be
  diffed cleanly against a re-render.
- Placeholder names MUST be `UPPER_SNAKE_CASE` wrapped in double braces.
- Templates MUST be ASCII-only outside of strings.
- Templates MUST pass `actionlint` after substitution. The
  `release-prepare-render.test.ts` snapshot test renders with sample values
  and (if `actionlint` is on `PATH`) pipes the output through `actionlint -`
  via `child_process.execSync`.

## Placeholders

All four templates draw from the same placeholder vocabulary. Unused
placeholders for a given template are silently ignored by the scaffolder.

| Placeholder           | Source                                                 | Default                              | Example                              |
|-----------------------|--------------------------------------------------------|--------------------------------------|--------------------------------------|
| `{{NODE_VERSION}}`    | `.cleo/project-context.json` `node.version`            | `22.x`                               | `"22.x"`                             |
| `{{INSTALL_CMD}}`     | ADR-061 archetype defaults (`primaryType`-specific)    | `pnpm install --frozen-lockfile`     | `pnpm install --frozen-lockfile`     |
| `{{LINT_CMD}}`        | ADR-061 `tool:lint` resolution                         | `pnpm run lint`                      | `pnpm biome ci .`                    |
| `{{TYPECHECK_CMD}}`   | ADR-061 `tool:typecheck` resolution                    | `pnpm run typecheck`                 | `pnpm run typecheck`                 |
| `{{TEST_CMD}}`        | ADR-061 `tool:test` resolution                         | `pnpm run test`                      | `pnpm run test`                      |
| `{{BUILD_CMD}}`       | ADR-061 `tool:build` resolution                        | `pnpm run build`                     | `pnpm run build`                     |
| `{{BRANCH_PREFIX}}`   | `release.branchPrefix` in `.cleo/config.json`          | `release`                            | `release`                            |
| `{{PR_LABEL}}`        | `release.prLabel` in `.cleo/config.json`               | `release`                            | `release`                            |
| `{{NPM_PUBLISH_CMD}}` | `release.npmPublishCmd` in `.cleo/config.json`         | `pnpm publish --access public --tag latest` | `pnpm publish -r --access public --tag latest` |
| `{{PUBLISHERS}}`      | `release.publishers` in `.cleo/config.json`            | `npm`                                | `npm cargo`                          |
| `{{DOCS_BUILD_CMD}}`  | `release.fanout.docsBuildCmd` in `.cleo/config.json`   | `pnpm run docs:build`                | `pnpm --filter @cleocode/docs run build` |
| `{{ENABLE_DOCS_DEPLOY}}`     | `release.fanout.docsDeploy` in `.cleo/config.json`     | `false`                  | `true`                               |
| `{{ENABLE_DOCKER_RETAG}}`    | `release.fanout.dockerRetag` in `.cleo/config.json`    | `false`                  | `true`                               |
| `{{ENABLE_SENTINEL_NOTIFY}}` | `release.fanout.sentinelNotify` in `.cleo/config.json` | `false`                  | `true`                               |
| `{{ENABLE_STUDIO_DEPLOY}}`   | `release.fanout.studioDeploy` in `.cleo/config.json`   | `false`                  | `true`                               |
| `{{ENABLE_NIGHTLY_TRIGGER}}` | `release.fanout.nightlyTrigger` in `.cleo/config.json` | `false`                  | `true`                               |
| `{{DOCKER_IMAGE}}`    | `release.fanout.dockerImage` in `.cleo/config.json`    | *(none — required if `dockerRetag=true`)* | `cleocode/cleo`                |
| `{{DOCKER_HUB_USER}}` | `release.fanout.dockerHubUser` in `.cleo/config.json`  | *(none — required if `dockerRetag=true`)* | `cleocode`                     |
| `{{SENTINEL_WEBHOOK_URL}}` | `release.fanout.sentinelWebhookUrl` in `.cleo/config.json` | *(none — required if `sentinelNotify=true`)* | `https://sentinel.example.com/hooks/release` |
| `{{STUDIO_DEPLOY_HOOK}}` | `release.fanout.studioDeployHook` in `.cleo/config.json` | *(none — required if `studioDeploy=true`)*   | `https://studio.example.com/deploy`        |

Source precedence (highest first):

1. Explicit override in `.cleo/project-context.json` (ADR-061 §1).
2. Project archetype default keyed on `primaryType` (e.g. `node` → `pnpm`,
   `rust` → `cargo`, `python` → `uv`).
3. Hard-coded fallback in the scaffolder.

## GitHub permissions required per template

| Template                     | `contents`      | `pull-requests` | `id-token`            | `packages`         | Other            |
|------------------------------|-----------------|------------------|----------------------|--------------------|------------------|
| `release-prepare.yml.tmpl`   | `write`         | `write`          | `write` (signed tags) | (MUST NOT request) | —                |
| `release-publish.yml.tmpl`   | `write` (tag)   | `read`           | `write` (OIDC)        | `write` (publish job only) | —        |
| `release-fanout.yml.tmpl`    | `read`          | —                | `write` (Pages, docs job only)* | —        | `pages: write`*  |
| `release-rollback.yml.tmpl`  | `write` (revert + tag delete) | `write`          | —                     | `write` (npm deprecate) | —          |

*Per-job — only granted to the job that needs it.

## Required secrets

| Template                     | Required secrets        | Optional secrets                                  |
|------------------------------|-------------------------|---------------------------------------------------|
| `release-prepare.yml.tmpl`   | `GITHUB_TOKEN` (auto)   | *(none)* — MUST NOT require `NPM_TOKEN` (R-210)   |
| `release-publish.yml.tmpl`   | `GITHUB_TOKEN`, `NPM_TOKEN`, `ANTHROPIC_API_KEY` | `CARGO_TOKEN`, `PYPI_TOKEN`, `DOCKER_HUB_TOKEN` |
| `release-fanout.yml.tmpl`    | `GITHUB_TOKEN` (auto)   | `DOCKER_HUB_TOKEN` (if `dockerRetag=true`), `SENTINEL_TOKEN` (if `sentinelNotify=true`), `STUDIO_DEPLOY_TOKEN` (if `studioDeploy=true`) |

## Scaffolding workflow

```bash
# Render the templates against the local project, writing to .github/workflows/.
cleo init --workflows

# Re-render after editing project-context.json or release config.
cleo init --workflows --force
```

The scaffolder reads each `*.yml.tmpl` file in this directory, performs
regex substitution against the placeholder vocabulary above, validates the
result with `actionlint`, and writes the rendered YAML to
`<project>/.github/workflows/<basename>.yml`. Existing files are NOT
overwritten without `--force`.

## Extending without forking

Per SPEC R-260, downstream projects MAY layer customizations onto the
rendered workflows via a sibling `.github/workflows/<basename>.overrides.yml`
file (planned: `.workflow-overrides.yml` at repo root for cross-template
overrides). The scaffolder merges overrides as a final pass; conflicts at
the same YAML key path resolve to the override.

Override examples (illustrative — full schema lands with T9531):

```yaml
# .github/workflows/release-prepare.overrides.yml
jobs:
  preflight:
    steps:
      - name: Project-specific cache warm
        run: ./scripts/warm-cache.sh
        timeout-minutes: 3
```

Overrides MUST NOT remove or relax any RFC2119 invariant from
`SPEC-T9345-release-pipeline-v2.md`. The scaffolder rejects override files
that drop required `timeout-minutes`, modify `concurrency.group`, or strip
declared permissions.

## Cross-references

- SPEC: `.cleo/rcasd/T9345/research/SPEC-T9345-release-pipeline-v2.md`
  - §5.1 → `release-prepare.yml.tmpl` *(T9532, landed)*
  - §5.2 → `release-publish.yml.tmpl` *(T9533, landed)*
  - §5.3 → `release-fanout.yml.tmpl` *(T9534, current)*
  - §5.4 → `release-rollback.yml.tmpl` *(T9535)*
- ADR-061 (tool resolver): governs `tool:*` placeholder resolution.
- ADR-073 (release pipeline v2): umbrella architectural decision.
- T9531: `cleo init --workflows` scaffold command (consumes these templates).
- T9532: `release-prepare.yml.tmpl` + README skeleton + snapshot test.
- T9533: `release-publish.yml.tmpl` + README placeholders + snapshot test
  (eliminates F6 tag-on-pre-merge-SHA race by construction).
- T9534: `release-fanout.yml.tmpl` + 11 fanout placeholders + snapshot test
  (current task — five independent best-effort jobs gated on env toggles,
  every job carries `continue-on-error: true` so fanout failures cannot
  mark the release as failed; fanout jobs MUST NOT be required status
  checks per R-244).
