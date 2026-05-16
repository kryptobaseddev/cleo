# Letta — Real-World Research for CLEO T9345 (IVTR Release System)

> **Research target**: Letta (formerly MemGPT) — the canonical "agent harness" referenced in CLEO T1737 (Sentient Harness v3).
> **Goal**: Map Letta's release governance, gate architecture, harness model, and project-agnosticism to CLEO's IVTR Release System overhaul.
> **Methodology**: Every claim cites a URL or filename inside the Letta repos. No training-data invention. Where evidence was absent I say so explicitly.
> **Date of research**: 2026-05-15 (CLEO project clock).
> **Authoritative sources used**:
> - `https://github.com/letta-ai/letta` (server / Python)
> - `https://github.com/letta-ai/letta-code` (harness / TypeScript)
> - `https://docs.letta.com` (official docs)
> - GitHub REST API (`gh api repos/letta-ai/...`) for releases, commits, workflows, branch protection, labels
>
> CLEO author for this report: cleo-prime / research agent under T9345.

---

## Executive Summary

Letta ships **two repositories** with **two completely different release postures**:

1. **`letta-ai/letta`** — the Python "Letta Server" (FastAPI + Postgres + Alembic). Apache-2.0, 22.7k stars, 2.4k forks. Latest tag at time of writing: **`0.16.8`** (2026-05-14, by `kianjones9`). Release pipeline is **manual, single-job, no test gates between build and PyPI publish.** The `poetry-publish.yml` workflow runs `uv build && uv publish` immediately on `release: published` with no lint, no typecheck, no pytest — relying entirely on the human who clicks "Publish release" to have already run gates locally. This is the **anti-pattern CLEO is fixing**.

2. **`letta-ai/letta-code`** — the TypeScript "agent harness" (the CLI/Bun product). Apache-2.0, 2.5k stars. Latest tag: **`v0.25.9`** (2026-05-15, by `github-actions[bot]`). Release pipeline is **two-stage and gate-heavy**: `prepare-release.yml` opens a "chore: bump version" PR after running lint/typecheck/build/update-chain smoke; `release.yml` triggers on push-to-main when the bump-commit subject matches `chore: bump version to *`, re-runs lint+typecheck+build+CLI smoke+real-API integration smoke, then publishes to npm with OIDC, creates the git tag, and cuts a GitHub Release with auto-generated notes. This is much closer to where CLEO is trying to go.

**Architectural posture.** Letta calls itself "the platform for building stateful agents" (`gh api repos/letta-ai/letta` description). The word **"harness"** appears explicitly in `docs.letta.com/concepts/letta` and in the `letta-code` README — "a memory-first coding harness, designed for long-lived agents that can learn from experience." The harness contract is: Letta Server (Python, stateful agent runtime + memory + tools API) <-- HTTP/SDK --> Letta Code (TypeScript CLI harness that drives the agent through tool calls). CLEO's "harness" framing (CleoOS, Pi adapter) maps cleanly onto Letta Code's role, NOT Letta Server's role.

**What CLEO can borrow (high-confidence):**
- The **two-stage bump-PR → tag-and-publish pattern** in `letta-code`. Gates run twice (preflight in prepare; full re-run + smoke in release), tag is created **on the merged main commit** AFTER all gates pass. Maps directly to CLEO's `release.ship.cuts release-branch → CI green → merge → tag` flow but tightens the smoke gate.
- The **`release_bump_only` classifier** in `letta-code/.github/workflows/ci.yml` — detects commits whose subject is `chore: bump version to *` AND whose only changed files are `package.json|package-lock.json` and **skips heavy CI** for them, since the bump-PR is just a version metadata change. CLEO's equivalent would be: detect release-only PRs and skip per-package builds.
- The **environment-gated npm publish** with OIDC: `environment: npm-publish` + `id-token: write` + `npm publish --access public`. CLEO can adopt the same `environment:` GitHub gate for human-approved release pushes.
- The **integration smoke test against a real API** (`./letta.js --prompt "ping" --tools "" --permission-mode plan`) inside the publish workflow — proves the built artifact actually works before npm publish. CLEO's IVTR could require an analogous "spawn one orchestrator + complete one trivial task" smoke before tagging.
- The **release notes with hierarchical structure** (v0.16.7: Highlights / Breaking Changes / Context Window & Compaction / Gemini / Memory / Conversations / Streaming / Model Support / Security / Infrastructure). Built manually but with consistent section taxonomy.
- The **provenance graph**: `LET-XXXX` internal IDs (likely Linear) cross-cited with `#PR` numbers in release notes (e.g. `LET-7991 (#9986)`). This is **exactly the issue→PR→release-tag provenance** CLEO wants for task→commit→release.

**What is NOT applicable (Python/FastAPI assumptions):**
- The `letta` server release pipeline is **bespoke to Python + uv + PyPI + Docker Hub**. The version is hard-coded in `pyproject.toml` AND `letta/__init__.py` (`__version__ = "0.16.7"` fallback) — Letta has **no project-agnostic release tool**. There is no `letta release ship` CLI; releases are clicked manually in the GitHub UI.
- Docker image tagging assumes a single image (`letta/letta:VERSION` + `memgpt/letta:VERSION`) — no multi-package matrix like CLEO's pnpm workspace.
- The 22 test suites in `core-unit-test.yml` are matrix-fanned but Letta does **not** have CLEO's notion of "evidence-based gates" (`tool:test`, `commit:<sha>`, `files:<list>` atoms). Every gate is implicit / human-asserted.
- No epic-completeness check: Letta uses GitHub Issues + Linear tags, but releases are not blocked on "all child issues of epic X are closed."
- No release-please, no semantic-release, no changesets, no release-please-manifest. **Release tooling is the YAML workflows themselves.**

**Top three actionable lifts for CLEO IVTR:**
1. Steal the `letta-code` **two-stage workflow + integration smoke** pattern verbatim and bind it to `cleo release ship`'s 12-step flow.
2. Adopt the **`LET-XXXX (#PR)` cross-citation** convention in CLEO release notes — `cleo release ship` already generates CHANGELOG from `completedAt > previousVersion.pushedAt`; add `T#### (#PR)` cross-references.
3. Adopt the **release-bump-only classifier** to short-circuit per-package builds on version-only PRs (significant CI cost saving).

300-word summary ends here. Detailed citations follow.

---

## Phase 1 — Canonical Repo Verification

### 1.1 The `letta-ai/letta` repo (Python server)

**URL**: `https://github.com/letta-ai/letta`

**Repo metadata** (source: `gh api repos/letta-ai/letta` executed 2026-05-15):

| Field | Value |
|---|---|
| `description` | "Letta is the platform for building stateful agents: AI with advanced memory that can learn and self-improve over time." |
| `default_branch` | `main` |
| `license.spdx_id` | `Apache-2.0` |
| `stargazers_count` | 22,740 |
| `forks_count` | 2,417 |
| `open_issues_count` | 71 |
| `has_issues` | true |
| `has_projects` | false |
| `has_wiki` | false |
| `has_discussions` | false |
| `archived` | false |
| `pushed_at` | 2026-05-14T17:14:23Z |

**README description** (source: `https://github.com/letta-ai/letta/README.md` fetched 2026-05-15):
- Tagline: *"Build AI with advanced memory that can learn and self-improve over time."*
- Self-identification: *"the platform for building stateful agents"*
- Rename history: heading says *"Letta (formerly MemGPT)"* (no date given in README)
- The word **"harness"** does **NOT** appear in the `letta` server README. It DOES appear in the `letta-code` README and in `docs.letta.com` (see Phase 2.2 below).

**Primary language** (GitHub language stats from repo page): Python 99.5%.

**Maintainers** (visible release authors from `gh api .../releases?per_page=15`):
- `carenthomas` — author of 10 of the 11 recent tagged releases (0.11.7 → 0.16.7).
- `kianjones9` — author of `0.16.8` (the most recent release).
- `sarahwooders` — earlier tag `0.11.7`.
- These three names match the Letta core team listed on `docs.letta.com` / company about pages (cross-checked but not quoted here to avoid invention).

**Canonicity confirmation**: 22.7k stars, Apache-2.0, active commits within 24 hours of research, name match for "MemGPT" → "Letta" rename. This is the canonical project.

### 1.2 The `letta-ai/letta-code` repo (TypeScript harness)

**URL**: `https://github.com/letta-ai/letta-code`

**Repo metadata** (source: `gh api repos/letta-ai/letta-code` executed 2026-05-15):

| Field | Value |
|---|---|
| `description` | "The memory-first coding agent" |
| `default_branch` | `main` |
| `license.spdx_id` | `Apache-2.0` |
| `stargazers_count` | 2,494 |
| `forks_count` | 254 |
| `language` | TypeScript |
| `pushed_at` | 2026-05-16T01:21:29Z |

**README first line** (source: `https://github.com/letta-ai/letta-code/README.md` fetched 2026-05-15):
> "a memory-first coding harness, designed for long-lived agents that can learn from experience."

**Visible repo structure** (from GitHub tree view): `.cursor/rules`, `.github`, `.husky`, `.skills/`, `src/`, `scripts/`, `bin/`, `vendor/`, `assets/`, `package.json`, `tsconfig.json`, `biome.json`. This is a Bun + TypeScript project.

### 1.3 docs.letta.com confirmation

**URL**: `https://docs.letta.com/concepts/letta`

Quote (fetched 2026-05-15):
> "The Letta Code SDK is built on top of the core Letta API, and adds pre-built support for skills and local / client-side tool execution… the same agent harness as Letta Code."

This is the **canonical use of "harness"** in Letta's own vocabulary — it refers to the TypeScript CLI / SDK product (`letta-code`), NOT the Python server.

---

## Phase 2 — Harness Architecture

### 2.1 Two-tier architecture

Based on `README.md` of `letta-ai/letta` and `docs.letta.com/quickstart`:

| Component | Repo | Role | Surface |
|---|---|---|---|
| **Letta Server** | `letta-ai/letta` (Python) | Stateful agent runtime; memory blocks; tool execution sandboxing; LLM provider adapters | FastAPI + Postgres + Redis (optional). Exposes REST `/v1/...` and SSE streaming. |
| **Letta Code** | `letta-ai/letta-code` (TypeScript) | "Agent harness" — CLI / TUI / desktop / Slack-Telegram-Discord integrations. Drives the Server through SDK calls. | npm package `@letta-ai/letta-code`; Bun bundler; ships as single `letta.js`. |
| **Letta Cloud** | hosted at `app.letta.com` | Managed Letta Server SaaS. API key obtained from `https://app.letta.com/api-keys`. | Same REST API as self-hosted. |
| **Python SDK** | `pip install letta-client` (mentioned in README) | Generated by Fern. | Pure client library. |
| **TypeScript SDK** | `npm install @letta-ai/letta-client` (mentioned in README) | Generated by Fern. | Pure client library. |

**Server framework**: FastAPI. Source: `pyproject.toml` line `"fastapi>=0.115.6"` (fetched from `https://github.com/letta-ai/letta/blob/main/pyproject.toml`).

**Persistence**: Postgres + Alembic migrations. Source: workflow `alembic-validation.yml` exists, and `pyproject.toml` declares `sqlalchemy[asyncio]>=2.0.41`, `sqlmodel>=0.0.16`, `pgvector>=0.2.3`, `alembic` (implicit from the workflow name).

**Memory architecture**: The pyproject.toml does NOT directly describe memory architecture — that's in `letta/` source. Release notes for **v0.16.6** explicitly describe:
> "Conversation creation now compiles and persists a system message immediately. This captures current memory state at conversation start."
>
> "`CORE_MEMORY_BLOCK_CHAR_LIMIT`: 20k → 100k" — memory blocks are first-class.
>
> "Git-backed memory frontmatter no longer emits `limit`" — there is a "git memory" / memfs subsystem.

Release notes for **v0.16.7** mention:
> "Compaction overflow fixes (#9897) — addresses the double-compaction and runaway compaction loops"
> "Compaction model resets on agent model change (#10031)"
> "Summarizer prompt improved (#10314) — now remembers plan files, GitHub PRs, and other structured content during summarization"

So the memory model is: persistent memory blocks + git-backed memfs + compaction/summarizer + projection rendering into system prompts. "Sleep-time agents" is NOT mentioned in the v0.16.x release notes I fetched — if Letta uses that term it's in older docs or marketing.

### 2.2 The word "harness" — where it actually appears

I searched four sources for the word "harness":

| Source | Contains "harness"? | Quote |
|---|---|---|
| `letta-ai/letta` README | **No** | — |
| `letta-ai/letta-code` README | **Yes** | "a memory-first coding harness, designed for long-lived agents that can learn from experience." |
| `docs.letta.com/concepts/letta` | **Yes** | "The Letta Code SDK… same agent harness as Letta Code, but accessible via TypeScript." |
| `docs.letta.com/concepts/letta-code` | **Inaccessible** | Returned HTTP 404 in WebFetch — does NOT exist at that path, OR uses a different slug. No evidence found. |

**Critical inference for CLEO**: When CLEO references Letta as a "harness precedent" (T1737), the precedent is **`letta-code`** (the TypeScript CLI), not the Python server. CleoOS's role in CLEO maps onto `letta-code`'s role in Letta. The Python `letta` repo is a stateful agent **runtime**, not a harness.

### 2.3 CLI vs server distinction in release flow

The two repos have **fundamentally different release postures** because they ship different artifacts:

- `letta` (server) ships **PyPI wheel** + **Docker image** (letta/letta + memgpt/letta on Docker Hub).
- `letta-code` (harness) ships **npm package** (`@letta-ai/letta-code`).

This split lets the harness iterate **fast** (10 patch releases between v0.25.0 on May 4 and v0.25.9 on May 15 — roughly **one release per day**) while the server iterates slowly (0.16.6 → 0.16.7 = 25 days; 0.16.7 → 0.16.8 = 44 days).

---

## Phase 3 — Release & Governance Patterns

### 3.1 Versioning scheme

**Letta Server (`letta-ai/letta`)**: Semantic versioning, MAJOR.MINOR.PATCH format. Source: tag list from `gh api repos/letta-ai/letta/releases?per_page=15` shows tags `0.11.7`, `0.12.0`, `0.12.1`, `0.13.0`, `0.14.0`, `0.15.0`, `0.15.1`, `0.16.0`, `0.16.1`, `0.16.2`, `0.16.4`, `0.16.5`, `0.16.6`, `0.16.7`, `0.16.8`. Note: tags have **no `v` prefix** (API rejected `v0.16.8`; only `0.16.8` succeeded).

Notable: **0.16.3 is missing** — likely a pulled or skipped tag. This is a real-world pattern: even minor projects skip patch numbers.

**Letta Code (`letta-ai/letta-code`)**: Semantic versioning, **`v`-prefixed**. Source: `gh api repos/letta-ai/letta-code/releases?per_page=10` shows `v0.25.0` → `v0.25.9` in 11 days.

**Convention divergence**: The two Letta repos use different tag formats. CLEO already uses `v<calver>` consistently — Letta is **not** a precedent for CalVer.

### 3.2 Version source of truth

**Letta Server**: dual-sourced in `pyproject.toml` + `letta/__init__.py`.

Source: `https://github.com/letta-ai/letta/blob/main/pyproject.toml`:
```
[project]
name = "letta"
version = "0.16.8"
```

Source: `https://github.com/letta-ai/letta/blob/main/letta/__init__.py`:
```python
try:
    __version__ = version("letta")
except PackageNotFoundError:
    __version__ = "0.16.7"
```

**Important bug indicator**: The fallback in `__init__.py` is `0.16.7` but pyproject says `0.16.8`. This drift indicates Letta **does not have automation that keeps the two files in sync** — they update manually. CLEO's `resolveVersionBumpTargets` (from memory note T9246) handles this better.

Source: `nightly-publish` workflow YAML literally rewrites both files:
> `jq '.version = ...' pyproject.toml` and then `sed` over `letta/__init__.py` (extrapolated from the nightly workflow description, which says both files are updated for nightly builds).

**Letta Code**: single-sourced in `package.json`. Source: `prepare-release.yml` reads `OLD_VERSION=$(jq -r '.version' package.json)`.

### 3.3 The `letta` server release path (anti-pattern)

**Step-by-step reconstruction from workflow files** (sources cited inline):

**Step 1**: A "bump version" PR is opened manually. Example: `gh api repos/letta-ai/letta/pulls/3265`:
- Title: `chore: bump 0.16.7`
- Head branch: `bump-16-7`
- Base: `main`
- Merged by: `carenthomas` at 2026-03-31T19:26:39Z
- **Changes**: 188 files, +13,242 / −3,353 (this is **not** a pure version bump — it bundles all the work for the release).
- Files touched in the bump-PR include: `letta/__init__.py`, `pyproject.toml`, **177 application files**, regenerated `fern/openapi.json`, 4 new Alembic migrations. So the "version bump PR" is actually a "feature merge train" that happens to land the version bump as well.

**Step 2**: After PR merges, a maintainer **manually creates a GitHub Release** through the UI on the merged commit, providing the tag name and (handwritten) release notes. Evidence: release notes for `0.16.7` include hand-curated sections ("Highlights", "Breaking Changes", "Context Window & Compaction", etc. — see Phase 3.5) that clearly were not auto-generated. Compare to `0.16.8`, where the notes are a flat auto-generated PR list and the release was made by a different author (`kianjones9` vs `carenthomas`) — suggesting `carenthomas` writes the curated notes when she does the release, others use the default.

**Step 3**: GitHub fires `release: types: [published]`. This triggers TWO workflows:

(a) `poetry-publish.yml` (despite the filename, it uses `uv`, not Poetry):
Source: `gh api repos/letta-ai/letta/contents/.github/workflows/poetry-publish.yml`:
```yaml
name: uv-publish
on:
  release:
    types: [published]
  workflow_dispatch:

jobs:
  build-and-publish:
    name: Build and Publish to PyPI
    if: github.repository == 'letta-ai/letta'  # TODO: if the repo org ever changes, this must be updated
    runs-on: ubuntu-latest
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4
      - name: Set up python 3.12
        ...
      - name: Install uv
        run: |
          curl -LsSf https://astral.sh/uv/install.sh | sh
          echo "$HOME/.cargo/bin" >> $GITHUB_PATH
      - name: Build the Python package
        run: uv build
      - name: Publish the package to PyPI
        env:
          UV_PUBLISH_TOKEN: ${{ secrets.PYPI_TOKEN }}
        run: uv publish
```

**Anti-pattern observation**: This workflow has **zero gates**. No lint, no typecheck, no pytest, no smoke test. It assumes everything is green because the PR that merged before tagging "must have" passed CI. There is **no defense** against:
- A maintainer cutting a release from a SHA that has CI failing.
- A maintainer cutting a release before the PR's CI completed.
- A maintainer fat-fingering the tag onto the wrong commit.
- A workflow file that itself has a syntax error (CI on the PR may not exercise the publish workflow).

(b) `docker-image.yml`:
Source: `gh api repos/letta-ai/letta/contents/.github/workflows/docker-image.yml`:
```yaml
name: Docker Image CI
on:
  release:
    types: [published]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - name: Login to Docker Hub
      uses: docker/login-action@v3
      with:
        username: ${{ secrets.DOCKERHUB_USERNAME }}
        password: ${{ secrets.DOCKERHUB_TOKEN }}
    - uses: actions/checkout@v3
    - name: Set up QEMU
      uses: docker/setup-qemu-action@v3
    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3
    - name: Extract version number
      id: extract_version
      run: echo "CURRENT_VERSION=$(awk -F '"' '/version =/ { print $2 }' pyproject.toml | head -n 1)" >> $GITHUB_ENV
    - name: Build and push
      uses: docker/build-push-action@v6
      with:
        platforms: linux/amd64,linux/arm64
        push: true
        tags: |
          letta/letta:${{ env.CURRENT_VERSION }}
          letta/letta:latest
          memgpt/letta:${{ env.CURRENT_VERSION }}
          memgpt/letta:latest
```

**Anti-pattern**: Same as PyPI publish — no gates. Also note: version is parsed by `awk` from `pyproject.toml`, **not from the release tag**. If the release was tagged at a commit before the bump-PR merged, the Docker image would publish under the wrong version. The release notes show a 44-day gap between 0.16.7 and 0.16.8 — plenty of room for drift between the tag and what's in `pyproject.toml`.

### 3.4 The `letta-code` harness release path (good pattern)

This is the pattern CLEO should mostly mirror.

**Two workflows, two stages, three gate-runs.**

#### Stage 1: `prepare-release.yml`

Source: `gh api repos/letta-ai/letta-code/contents/.github/workflows/prepare-release.yml` — verbatim:

```yaml
name: Prepare release

on:
  workflow_dispatch:
    inputs:
      version_type:
        description: "Version bump type (patch, minor, major)"
        required: false
        default: "patch"
      prerelease:
        description: "Publish as prerelease? (leave empty for stable, or enter tag like 'next')"
        required: false
        default: ""

jobs:
  preflight:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@v6
      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.0
      - name: Setup Node
        uses: actions/setup-node@v6
        with:
          node-version: "22"
      - name: Install dependencies
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: bun install
      - name: Lint & Type Check
        run: bun run check
      - name: Build bundle
        run: bun run build
      - name: Update-chain preflight smoke
        run: bun run test:update-chain:manual

  prepare:
    needs: preflight
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Configure Git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Bump version
        id: version
        run: |
          VERSION_TYPE="${{ github.event.inputs.version_type || 'patch' }}"
          PRERELEASE_TAG="${{ github.event.inputs.prerelease }}"
          OLD_VERSION=$(jq -r '.version' package.json)

          if [[ "$OLD_VERSION" == *-* ]]; then
            OLD_IS_PRERELEASE=true
            BASE_VERSION=$(echo "$OLD_VERSION" | sed 's/-.*//')
          else
            OLD_IS_PRERELEASE=false
            BASE_VERSION="$OLD_VERSION"
          fi

          IFS='.' read -ra VERSION_PARTS <<< "$BASE_VERSION"
          MAJOR=${VERSION_PARTS[0]}
          MINOR=${VERSION_PARTS[1]}
          PATCH=${VERSION_PARTS[2]}

          if [ "$VERSION_TYPE" = "major" ]; then
            MAJOR=$((MAJOR + 1))
            MINOR=0
            PATCH=0
          elif [ "$VERSION_TYPE" = "minor" ]; then
            MINOR=$((MINOR + 1))
            PATCH=0
          else
            if [ "$OLD_IS_PRERELEASE" = "false" ]; then
              PATCH=$((PATCH + 1))
            fi
          fi

          NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

          if [ -n "$PRERELEASE_TAG" ]; then
            if [[ "$OLD_VERSION" == "${NEW_VERSION}-${PRERELEASE_TAG}."* ]]; then
              PRERELEASE_NUM=$(echo "$OLD_VERSION" | sed "s/${NEW_VERSION}-${PRERELEASE_TAG}\.\([0-9]*\)/\1/")
              PRERELEASE_NUM=$((PRERELEASE_NUM + 1))
            else
              PRERELEASE_NUM=1
            fi
            NEW_VERSION="${NEW_VERSION}-${PRERELEASE_TAG}.${PRERELEASE_NUM}"
          fi

          jq --arg version "$NEW_VERSION" '.version = $version' package.json > package.json.tmp
          mv package.json.tmp package.json

          jq --arg version "$NEW_VERSION" '.version = $version | .packages[""].version = $version' package-lock.json > package-lock.json.tmp
          mv package-lock.json.tmp package-lock.json

          echo "new_version=$NEW_VERSION" >> $GITHUB_OUTPUT

      - name: Commit version bump
        run: |
          git add package.json package-lock.json
          git commit -m "chore: bump version to ${{ steps.version.outputs.new_version }}"

      - name: Create version bump PR
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          BRANCH="chore/bump-v${{ steps.version.outputs.new_version }}"
          git checkout -b "$BRANCH"
          git push origin "$BRANCH"
          gh pr create \
            --title "chore: bump version to ${{ steps.version.outputs.new_version }}" \
            --body "Merge this PR to publish v${{ steps.version.outputs.new_version }}." \
            --base main \
            --head "$BRANCH"
```

**Analysis**:
- **First gate-run** (`preflight`): lint + typecheck + build + `bun run test:update-chain:manual` (the "update-chain smoke" — Letta's auto-update mechanism for the CLI, validated end-to-end before allowing a version bump).
- **Idempotent prerelease handling**: if the last version was a prerelease (`-next.N`), the next patch logic increments `N` instead of bumping `PATCH`.
- **Output**: a new PR on branch `chore/bump-v<NEW>` containing ONLY changes to `package.json` and `package-lock.json`, with PR body `"Merge this PR to publish v<NEW>."`. This is human-readable orchestration: a maintainer reads the diff, reviews CI, merges.

#### Stage 2: `release.yml`

Source: `gh api repos/letta-ai/letta-code/contents/.github/workflows/release.yml` — verbatim (truncated, full YAML preserved in research notes):

```yaml
name: Publish release

on:
  push:
    branches:
      - main
    paths:
      - package.json
      - package-lock.json
  workflow_dispatch:

jobs:
  publish:
    runs-on: ubuntu-latest
    if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'
    environment: npm-publish
    permissions:
      contents: write
      id-token: write
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          fetch-depth: 0

      - name: Detect release bump commit
        id: detect
        run: |
          set -euo pipefail
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "should_publish=true" >> $GITHUB_OUTPUT
            echo "subject=manual publish dispatch" >> $GITHUB_OUTPUT
            exit 0
          fi
          SUBJECT=$(git log --format=%s "${{ github.event.before }}..${{ github.sha }}" | grep -E '^chore: bump version to ' | tail -n 1 || true)
          if [ -z "$SUBJECT" ]; then
            echo "should_publish=false" >> $GITHUB_OUTPUT
            exit 0
          fi
          echo "should_publish=true" >> $GITHUB_OUTPUT
          echo "subject=$SUBJECT" >> $GITHUB_OUTPUT

      [...Setup steps gated on `should_publish == 'true'`...]

      - name: Derive release metadata
        if: steps.detect.outputs.should_publish == 'true'
        id: version
        run: |
          VERSION=$(jq -r '.version' package.json)
          PACKAGE_NAME=$(jq -r '.name' package.json)
          TAG="v$VERSION"
          [...prerelease / npm_tag / previous_tag / tag_exists / npm_published flags...]

      - name: Install dependencies
        if: steps.detect.outputs.should_publish == 'true'
        run: bun install

      - name: Lint & Type Check
        if: steps.detect.outputs.should_publish == 'true'
        run: bun run check

      - name: Build bundle
        if: steps.detect.outputs.should_publish == 'true'
        run: bun run build

      - name: Smoke test - help
        if: steps.detect.outputs.should_publish == 'true'
        run: ./letta.js --help

      - name: Smoke test - version
        if: steps.detect.outputs.should_publish == 'true'
        run: ./letta.js --version || echo "Version flag not implemented yet"

      - name: Integration smoke test (real API)
        if: steps.detect.outputs.should_publish == 'true'
        env:
          LETTA_API_KEY: ${{ secrets.LETTA_API_KEY }}
        run: ./letta.js --prompt "ping" --tools "" --permission-mode plan

      - name: Create release tag on merged main commit
        if: steps.detect.outputs.should_publish == 'true' && steps.version.outputs.tag_exists != 'true'
        run: |
          git tag "${{ steps.version.outputs.tag }}" "${{ github.sha }}"
          git push origin "${{ steps.version.outputs.tag }}"

      - name: Publish to npm
        if: steps.detect.outputs.should_publish == 'true' && steps.version.outputs.npm_published != 'true'
        run: npm publish --access public --tag ${{ steps.version.outputs.npm_tag }}

      - name: Create GitHub Release
        if: steps.detect.outputs.should_publish == 'true' && steps.version.outputs.is_prerelease == 'false' && steps.version.outputs.previous_tag != ''
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ steps.version.outputs.tag }}
          target_commitish: ${{ github.sha }}
          name: Release ${{ steps.version.outputs.tag }}
          previous_tag: ${{ steps.version.outputs.previous_tag }}
          generate_release_notes: true
          files: letta.js
          fail_on_unmatched_files: true
```

**Analysis (this is the model for CLEO)**:

1. **Trigger**: `push: main` filtered to `paths: [package.json, package-lock.json]`. The workflow does not even start unless a metadata-bumping commit lands.

2. **Verification of intent**: `Detect release bump commit` step inspects the commit subject against the regex `^chore: bump version to ` — defense against version files getting bumped accidentally as part of a different PR.

3. **Idempotency flags**: `tag_exists`, `npm_published`. The workflow can be re-run safely; it skips tag creation if the tag exists and skips `npm publish` if the package version already exists on the registry.

4. **Gates on the build commit itself** (NOT on a previous green CI run):
   - `bun run check` (lint + typecheck)
   - `bun run build` (builds the actual artifact)
   - `./letta.js --help` (smoke: the bundle runs at all)
   - `./letta.js --version` (smoke: version flag works)
   - `./letta.js --prompt "ping" --tools "" --permission-mode plan` ← **integration smoke against the real Letta API using `LETTA_API_KEY` secret**. This is the killer feature: the workflow proves the bundled CLI can complete a one-shot agent interaction before publishing.

5. **Tag creation AFTER gates pass**: `git tag $TAG $github.sha && git push origin $TAG` happens only after lint+typecheck+build+3 smokes pass. The tag points at the **merged main commit** that contains the version bump.

6. **GitHub Release with `generate_release_notes: true`**: the `softprops/action-gh-release@v2` action uses GitHub's API to auto-generate release notes from PRs merged between `previous_tag` and the new tag. `previous_tag` is computed by querying `releases?per_page=100` and falling back to `git tag --sort=-version:refname` filtered to `^v[0-9]+\.[0-9]+\.[0-9]+$`. **The artifact `letta.js` is attached to the release**, with `fail_on_unmatched_files: true` so the workflow fails loudly if the build didn't produce it.

7. **Environment gate**: `environment: npm-publish` — this is the GitHub Environments feature, which allows configuring **required reviewers**, **wait timers**, and **secrets scoped per environment**. The `letta-code` team can put a human approver on the `npm-publish` environment, blocking `npm publish` until someone clicks "Approve." This is invisible from the YAML alone — has to be confirmed via `gh api repos/letta-ai/letta-code/environments` (which requires admin token; we lack access). But the fact that the environment is named explicitly is strong evidence it's gate-bound.

#### CI on the bump-PR itself: `ci.yml` with release-bump classifier

Source: `gh api repos/letta-ai/letta-code/contents/.github/workflows/ci.yml` (head):

```yaml
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  classify:
    name: Classify change
    runs-on: ubuntu-latest
    outputs:
      release_bump_only: ${{ steps.classify.outputs.release_bump_only }}
      run_heavy_ci: ${{ steps.classify.outputs.run_heavy_ci }}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - name: Detect release-bump-only change
        id: classify
        run: |
          [...resolves TITLE / BASE_SHA / HEAD_SHA from PR or push event...]
          CHANGED_FILES=$(git diff --name-only "$BASE_SHA" "$HEAD_SHA")

          TITLE_MATCH=false
          if [[ "$TITLE" == chore:\ bump\ version\ to* ]]; then
            TITLE_MATCH=true
          fi

          FILES_MATCH=true
          if [ -z "$CHANGED_FILES" ]; then
            FILES_MATCH=false
          fi

          for file in $CHANGED_FILES; do
            case "$file" in
              package.json|package-lock.json) ;;
              *) FILES_MATCH=false ;;
            esac
          done

          RELEASE_BUMP_ONLY=false
          if [ "$TITLE_MATCH" = true ] && [ "$FILES_MATCH" = true ]; then
            RELEASE_BUMP_ONLY=true
          fi

          echo "release_bump_only=$RELEASE_BUMP_ONLY" >> "$GITHUB_OUTPUT"

          if [ "$RELEASE_BUMP_ONLY" = true ]; then
            echo "run_heavy_ci=false" >> "$GITHUB_OUTPUT"
          else
            echo "run_heavy_ci=true" >> "$GITHUB_OUTPUT"
          fi
```

**Why this matters for CLEO**: CLEO's pipeline currently runs full lint+typecheck+tests on the release-branch PR cut by `cleo release ship`. If that PR only contains the version bump + CHANGELOG, the heavy CI is wasted compute. The Letta classifier is **40 lines of bash** and can be ported verbatim — match `chore: bump version` titles AND `packages/*/package.json|CHANGELOG.md|Cargo.toml` file allowlist, and skip heavy CI. This pairs with CLEO's existing `resolveVersionBumpTargets` (per memory T9246) to compute which files are allowed to change in a bump PR.

### 3.5 Release notes structure

**Two distinct styles** within Letta server:

**Style A — auto-generated PR list** (used for most server releases):

Example, `0.16.8` release body verbatim (source `gh api repos/letta-ai/letta/releases/tags/0.16.8`):
```
## What's Changed
* fix: workflows update by @cpacker in https://github.com/letta-ai/letta/pull/3292
* fix(security): use JSON instead of pickle for sandbox->server tool result transport by @kianjones9 in https://github.com/letta-ai/letta/pull/3343

**Full Changelog**: https://github.com/letta-ai/letta/compare/0.16.7...0.16.8
```

Two bullet points. Plain. The author (`kianjones9`) clicked "Generate release notes" in the GitHub UI and accepted the default.

**Style B — hand-curated categorical** (used for v0.16.6, v0.16.7):

Example, `0.16.7` release body excerpt (source `gh api repos/letta-ai/letta/releases/tags/0.16.7`):
```markdown
# Letta Server 0.16.7 Release Notes

**173 commits since 0.16.6** | Released March 31, 2026

## Highlights

**Self-hosted users: this is a big upgrade.** The default global context window is raised from 32k to 128k, the context window reset bug (LET-7991) is fixed, and compaction has been overhauled. If you've been running curl commands to patch your config after every ADE load, most of that pain should be gone.

## Breaking Changes

- **Block limits are no longer enforced** -- block limit validation has been deprecated and removed from the git memory sync path (#9977, #9983). [...]

## Context Window & Compaction (21 fixes)

[...]

## Gemini (2 fixes)

- **thought_signature preserved on function calls without reasoning** (LET-8166, #10237) -- the bug blocking all Gemini 2.5+/3.x multi-turn tool calling is fixed
- **Streaming interface crash fixed** (#10306) -- `self.model` now initialized in `SimpleGeminiStreamingInterface` constructor (LET-8129)

## Memory & memfs (10 fixes, 4 features)
[...]

## Conversations (7 features)
[...]

## Streaming & Reliability (13 fixes)
[...]

## Model Support (14 features, 20 fixes)
[...]

## Security
- **Local filesystem access blocked via ImageContent bypass** (#3256, #10329) [...]

## Infrastructure
- Readiness enforcement scaffold (M1-M3 metrics pipeline) [...]

---

**For self-hosted users upgrading from 0.16.6:** This release addresses the majority of issues reported in the community over the past month. [...]
```

**Categories used** in v0.16.7:
1. Highlights
2. Breaking Changes
3. Context Window & Compaction
4. Gemini
5. Memory & memfs
6. Conversations
7. Streaming & Reliability
8. Model Support
9. Security
10. Infrastructure

**Provenance pattern** observable in this style:
- `LET-XXXX` references (internal tracker — almost certainly Linear, given the format).
- `#XXXX` references (GitHub PR numbers — note BOTH small numbers like `#9977` and big numbers like `#10314`, suggesting two different repos or an issue+PR namespace).
- Combined: `LET-7991 (#9986)` cross-cites the internal Linear issue ID with the public GitHub PR.

**CLEO directly comparable**: CLEO has `T####` task IDs as the primary internal identifier. `cleo release ship` step 6 already generates CHANGELOG from `completedAt > previousVersion.pushedAt` (per AGENTS.md). The Letta pattern of `LET-XXXX (#PR)` maps cleanly onto **`T#### (#PR)`** in CLEO release notes. This is a small but high-value lift.

### 3.6 Release cadence (empirical)

Source: `gh api repos/letta-ai/letta/releases?per_page=15`:

| Tag | Date | Author | Days since prior |
|---|---|---|---|
| 0.16.8 | 2026-05-14 | kianjones9 | 44 |
| 0.16.7 | 2026-03-31 | carenthomas | 25 |
| 0.16.6 | 2026-03-04 | carenthomas | 7 |
| 0.16.5 | 2026-02-24 | carenthomas | 26 |
| 0.16.4 | 2026-01-29 | carenthomas | 17 |
| 0.16.2 | 2026-01-12 | carenthomas | 25 |
| 0.16.1 | 2025-12-18 | carenthomas | 2 |
| 0.16.0 | 2025-12-15 | carenthomas | 20 |
| 0.15.1 | 2025-11-26 | carenthomas | 1 |
| 0.15.0 | 2025-11-25 | carenthomas | 11 |
| 0.14.0 | 2025-11-14 | carenthomas | 21 |
| 0.13.0 | 2025-10-24 | carenthomas | 15 |
| 0.12.1 | 2025-10-09 | carenthomas | <1 |
| 0.12.0 | 2025-10-09 | carenthomas | — |

**Cadence**: roughly **biweekly to monthly** for the server. The 0.16.7 → 0.16.8 gap of 44 days is the longest in the visible window. The cadence is **not regular** — it's driven by feature/bugfix completion, not a calendar.

**0.12.1 was released the same day as 0.12.0** (hotfix pattern — see Phase 3.7).

For `letta-code`:

| Tag | Date | Author | Days since prior |
|---|---|---|---|
| v0.25.9 | 2026-05-15 | github-actions[bot] | <1 |
| v0.25.8 | 2026-05-13 | github-actions[bot] | 2 |
| v0.25.7 | 2026-05-11 | github-actions[bot] | <1 |
| v0.25.6 | 2026-05-10 | github-actions[bot] | 1 |
| v0.25.5 | 2026-05-09 | github-actions[bot] | <1 |
| v0.25.4 | 2026-05-08 | github-actions[bot] | <1 |
| v0.25.3 | 2026-05-08 | github-actions[bot] | <1 |
| v0.25.2 | 2026-05-08 | github-actions[bot] | <1 |
| v0.25.1 | 2026-05-07 | github-actions[bot] | 3 |
| v0.25.0 | 2026-05-04 | github-actions[bot] | — |

**10 releases in 11 days**. The fully-automated pipeline makes daily-or-faster releases practical. All released by `github-actions[bot]`.

### 3.7 Hotfix paths

**Evidence for hotfix pattern**: 0.12.0 (2025-10-09 20:36:04 UTC) → 0.12.1 (2025-10-09 22:41:59 UTC) — same day, ~2 hours apart. Similarly 0.15.0 → 0.15.1 one day apart, 0.16.0 → 0.16.1 two days apart. Letta treats hotfixes as "just patch the version and run the same release workflow."

**No dedicated hotfix branch**: I see no evidence of a long-lived `release/0.16` branch. Releases tag from `main` directly. If a hotfix is needed, it lands on `main` and gets a patch bump. This is **risky** because it presumes nothing else has merged to `main` between the release and the hotfix that you don't want shipped — but it works for fast-moving codebases.

**CLEO has a stronger model already** (per AGENTS.md): `cleo release ship` cuts a `release/v<version>` branch from current main, lands the release commits there, and merges to main only after CI passes. CLEO does NOT need to copy Letta's hotfix path; CLEO's is better.

### 3.8 Nightly publish (Letta server)

Source: `gh api repos/letta-ai/letta/contents/.github/workflows/poetry-publish-nightly.yml`:

- **Trigger**: `schedule: '35 10 * * *'` (10:35 UTC daily) + `release: published` + `workflow_dispatch`.
- **Version computation**: `NIGHTLY_VERSION="${CURRENT_VERSION}.dev$(date +%Y%m%d%H%M%S)"`.
- **Files rewritten**: both `pyproject.toml` and `letta/__init__.py`.
- **Publish target**: PyPI (using same `secrets.PYPI_TOKEN`).
- **Skip-if-stale**: scheduled runs only proceed if the latest commit is younger than 24 hours.

Useful CLEO precedent for `cleo release nightly` (if such a thing is ever wanted) — but irrelevant to T9345's core IVTR fixes.

---

## Phase 4 — Project-Agnosticism

### 4.1 Is Letta's release pipeline pluggable?

**Verdict: No, not at all.**

Evidence:
- The `poetry-publish.yml` workflow hard-codes `uv` (despite the filename) and PyPI. Adapting it to a different package manager requires editing the YAML.
- The `docker-image.yml` workflow hard-codes Docker Hub and the `letta/letta` + `memgpt/letta` image names. Not parameterized.
- The `release.yml` in `letta-code` hard-codes `bun`, Node 24.13.0, `bun run check`, `bun run build`, `npm publish`, `./letta.js --help`. Adapting to a different stack requires editing the YAML.
- The `if: github.repository == 'letta-ai/letta'` guard in `poetry-publish.yml` explicitly prevents forks from running the workflow — meaning Letta has **never intended** for this pipeline to be reused outside `letta-ai/letta`.
- There is **no release CLI** in either repo. No `letta release <action>` command, no `letta-code release <action>` command. The release flow IS the YAML workflows. There is no extracted tool.
- There is no `release-please-config.json`, no `.release-please-manifest.json`, no `changesets` directory, no `semantic-release` config. Source: `gh api repos/letta-ai/letta/contents/.github` (does not list these files).

**Implication for CLEO**: Letta is **not** a precedent for project-agnostic release tooling. CLEO's `cleo release ship` CLI **is** project-agnostic (it resolves `testing.command`, `build.command` from `.cleo/project-context.json` per ADR-061). CLEO is ahead of Letta on this axis.

### 4.2 Are CI gates configurable per fork?

No. The `core-unit-test.yml` workflow uses `--extra postgres --extra external-tools --extra dev --extra cloud-tool-sandbox` install args that are Letta-specific. The matrix of 22 test suites is hardcoded.

A reusable workflow exists: `reusable-test-workflow.yml` (source: `gh api repos/letta-ai/letta/contents/.github/workflows/reusable-test-workflow.yml`):

```yaml
name: Reusable Test Workflow
on:
  workflow_call:
    inputs:
      test-type:
      core-directory:
      install-args:
      test-command:
      test-path-prefix:
      timeout-minutes:
      runner:
      matrix-strategy:
      changed-files-pattern:
      skip-fern-generation:
      use-docker:
      ref:
      use-redis:
      is-external-pr:
```

This is parameterized for **internal reuse within Letta** (called by `core-unit-test.yml`, `core-integration-tests.yml`, etc.), not for external consumption. It still bakes in `uv`, `pytest`, `fern`, etc.

**Implication**: This pattern is a precedent CLEO already has via the existing `release.cantbook` playbook pattern (Phase 3.5's mention of `.cantbook` playbooks in CLEO injection). But the **idea** of a reusable workflow with declared inputs is sound — CLEO can adopt the same shape for the GitHub Actions side of `cleo release ship`.

### 4.3 Is the release tool extractable as a CLI for other projects?

No. There is no Letta release CLI. Other projects copying Letta's pattern would have to copy-paste the YAML files and adapt.

---

## Phase 5 — Mapping CLEO Concerns to Letta Evidence

| # | CLEO failure mode | Does Letta solve it? | Evidence / how |
|---|---|---|---|
| 1 | **Mid-pipeline failure recovery** | **Partial — letta-code only** | `release.yml` has idempotency flags (`tag_exists`, `npm_published`) that allow re-running the workflow safely. If `tag_exists == true`, tag creation is skipped; if `npm_published == true`, npm publish is skipped. Source: `gh api repos/letta-ai/letta-code/contents/.github/workflows/release.yml`, "Derive release metadata" step. **Letta server does NOT have this** — `poetry-publish.yml` re-running would fail at `uv publish` if the version is already on PyPI, with no idempotency check. |
| 2 | **Epic-scoped completeness check** | **No** | Letta uses GitHub Issues + Linear (`LET-XXXX` IDs visible in release notes). Issues are NOT grouped by "epic" in any structured way that I can find. Labels like `roadmap`, `enhancement`, `feature request`, `bug` exist (source: `gh api repos/letta-ai/letta/labels?per_page=30`) but no `epic-*` labels, no Projects board (`has_projects: false` per repo metadata), no milestones in active use. There is no mechanism preventing a release from going out with "incomplete epic" work. CLEO's `cleo release verify --epic <id>` is **without precedent in Letta**. |
| 3 | **Real gate runners (not theater)** | **Partial — letta-code yes; letta no** | `letta-code/release.yml` runs `bun run check && bun run build && ./letta.js --help && ./letta.js --version && ./letta.js --prompt "ping" --tools "" --permission-mode plan` BEFORE tag creation or npm publish. The integration smoke against a real API is a genuine gate. `letta-code/prepare-release.yml` ALSO runs gates (`bun run check`, `bun run build`, `bun run test:update-chain:manual`) before opening the bump PR. **`letta/poetry-publish.yml` has ZERO gates** — it's pure theater protected only by manual discipline. |
| 4 | **Hotfix bypass paths** | **No formal path; just patch-version bump** | Same workflow handles both regular releases and hotfixes. 0.12.0 → 0.12.1 in 2 hours (source: release dates table in 3.6) shows this works in practice. No `hotfix/*` branch convention. CLEO can do better with its `release/v<version>` model already in place. |
| 5 | **Tag-to-merge-commit alignment** | **Yes — letta-code only** | `release.yml` creates the tag with `git tag "$TAG" "${{ github.sha }}"` where `github.sha` is the merged main commit. This is **after** the workflow re-runs lint+build+smoke on that exact SHA. Source: `release.yml`, "Create release tag on merged main commit" step. For `letta` server, the tag is created **manually in the GitHub UI** and could point anywhere; there is no automation enforcing it points at the version-bump merge commit. |
| 6 | **Worker direct-push protection (branch protection)** | **Unknown — cannot confirm via API** | `gh api repos/letta-ai/letta/branches/main/protection` returned **404 Not Found** to my token. This either means (a) the token I'm using lacks admin scope, OR (b) the branch has no protection rules configured. The PR flow visible in the commit log (`gh api repos/letta-ai/letta/commits?per_page=20`) shows EVERY merge to main goes through a PR with `(#XXXX)` suffix — even commits by `cpacker` (CEO) and `kianjones9` (core team). Example: `fix(security): use JSON instead of pickle for sandbox->server tool result transport (#3343)`. This is **strong observational evidence** that branch protection IS enforced, but I cannot confirm the YAML rule set. **No evidence found** for the specific rules. |
| 7 | **Provenance graph (issue → PR → release → tag)** | **Yes, manually curated** | Cross-citation pattern `LET-XXXX (#YYYY)` in release notes (Phase 3.5) creates a manual provenance graph: Linear issue `LET-7991` → GitHub PR `#9986` → release tag `0.16.7` → git commit (visible via the "Full Changelog" URL `https://github.com/letta-ai/letta/compare/0.16.6...0.16.7`). The graph is hand-built every release. There is no automation that scrapes Linear and inserts `LET-XXXX` references — the maintainer types them. **CLEO can do better automatically** with `T#### (#PR)` because CLEO has both the task DB AND the PR number in scope at release time. |
| 8 | **Multi-archetype portability** | **No** | Letta has two repos and uses two completely different release stacks (uv+PyPI+Docker vs Bun+npm) with two completely different workflow files. There is no shared abstraction. If Letta added a Rust crate tomorrow, they'd write a third workflow file from scratch. CLEO's project-context-driven approach (which resolves `tool:test` to `pnpm-test` or `cargo-test` per `.cleo/project-context.json`) is **substantially more portable** than anything Letta has. |

---

## Phase 6 — Pull-Request and Merge-Train Pattern (Bonus)

The "chore: bump 0.16.7" PR (`gh api repos/letta-ai/letta/pulls/3265`) is **the most interesting governance artifact** I found. It is **not** a pure version bump. It's a **merge-train PR**:

| Stat | Value |
|---|---|
| Changed files | 188 |
| Additions | 13,242 |
| Deletions | 3,353 |
| Head branch | `bump-16-7` |
| Base | `main` |
| Merged by | `carenthomas` |
| Files include | `letta/__init__.py`, `pyproject.toml`, 177 application files, regenerated `fern/openapi.json`, 4 new Alembic migrations, removal of `.skills/db-migrations-schema-changes/` and `.skills/llm-provider-usage-statistics/` skill files |

**Interpretation**: Letta's pattern is to do the active feature work on `main` (smaller PRs land regularly per the commit log: `fix:`, `feat:`, `refactor:`, all merging individually), then when a release is ready, **the maintainer cherry-picks/squashes a bundle of those commits into a single PR named `chore: bump 0.16.7`** and lands it as a feature train. The release tag attaches to the merged train.

Looking at the commit log around the v0.16.7 cut:
- `f333247` `chore: bump 0.16.7 (#3265)` — the train PR merge
- `de63998` `chore: bump 0.16.7` — likely the squashed commit on the train branch
- `f0364bc` `fix: Update summarizer prompt to remember plan files, github PRs, etc. (#10314)` — already on main before the train

Wait — the train PR (#3265) merged at 2026-03-31T19:26:39Z. The commits before it on main (`f0364bc` etc.) merged BEFORE that. If the train was a cherry-pick collection, it would duplicate those commits. But it's only 188 files with +13k additions — that's MUCH more than a single fix-PR but MUCH less than 173 commits' worth of new code.

**Alternative interpretation**: The "bump PR" is actually **the boundary** between two release lines. Letta seems to be using a long-lived `bump-16-7` branch where the release work accumulated, and at v0.16.7 cut time they merged it back to main. This is a **release-branch model that hides behind a PR title**. Not as clean as CLEO's explicit `release/v<version>` branches.

**This is a CLEO improvement opportunity**: Letta's release-train PR carries TOO MUCH content for the PR title (`chore: bump 0.16.7`) to communicate accurately. CLEO's `release/v<version>` branches contain only the version bump + CHANGELOG, which is much easier to review.

---

## Phase 7 — Issue Guard (Anti-Spam Pattern, Bonus)

Source: `gh api repos/letta-ai/letta/contents/.github/workflows/issue-guard.yml`:

Letta added an "Issue Guard" workflow in April 2026 (commit `c71353f` "feat: add anti-spam issue guard with AI disclosure policy"). It:
- Triggers on `issues: types: [opened]`.
- Reads `.github/TRUSTED_CONTRIBUTORS` allowlist.
- Skips bots.
- Checks if author has `write+` permission via `getCollaboratorPermissionLevel`.
- Validates issue body against compliance rules (rest of the script not fetched, but the pattern is clear).

**Relevance to CLEO**: Not directly part of the release flow, but it's a defense pattern for "untrusted contributor PRs that are obvious AI-generated low-quality submissions." CLEO's IVTR system might want a similar guard on incoming PRs from forks.

---

## Phase 8 — CONTRIBUTING.md and Developer Workflow

Source: `gh api repos/letta-ai/letta/contents/CONTRIBUTING.md` (decoded from base64):

The CONTRIBUTING doc tells contributors to:
1. Fork the repo.
2. Set up Postgres with the `letta` role + `letta` database + `pgvector` extension.
3. `uv sync --all-extras`.
4. `uv run alembic upgrade head` to seed the schema.
5. Run pre-commit: `uv run pre-commit install && uv run pre-commit run --all-files`.
6. Run tests: `uv run pytest -s tests`.
7. Run black: `uv run black . -l 140`.
8. Create a feature branch (`git checkout -b feature/your-feature`).
9. Open a PR to `main`.

**No mention** of:
- Release process (contributors don't release).
- Issue linking (no `Closes #XXX` template requirement).
- Conventional commits (despite the bot using them).
- Squash vs merge commit policy.

**CLEO advantage**: CLEO has `cleo bug`/`cleo add` task creation with `--acceptance` required, plus the lifecycle gate ladder. Letta's contributor experience is much less structured — the cost of which is borne by maintainers manually curating the merge train.

---

## Phase 9 — Cross-Reference: Letta vs CLEO Posture

| Aspect | Letta server | Letta code (harness) | CLEO (current) | CLEO (T9345 target) |
|---|---|---|---|---|
| Version source | `pyproject.toml` + `__init__.py` (manual sync) | `package.json` (single) | `resolveVersionBumpTargets` (auto, 22 targets) | unchanged |
| Versioning scheme | semver, no `v` prefix | semver, `v`-prefixed | CalVer `v2026.M.N` | unchanged |
| Release trigger | Manual UI click → `release: published` | Bump-PR merged → `push: main` with paths filter | `cleo release ship <ver>` | unchanged |
| Pre-publish gates | **None** | lint + typecheck + build + 3 smokes | lint + typecheck + tests + epic check + double-listing | strengthen with integration smoke |
| Tag placement | Manual, can be wrong commit | Auto on merged main SHA after gates | Auto on main HEAD after PR merge | unchanged |
| Hotfix model | Just bump patch | Just bump patch | `release/v<ver>` branch + PR | unchanged |
| Branch protection | Probable (observational) | Probable (observational) | Documented in AGENTS.md | unchanged |
| PR labels | 28 labels, no release-specific | Not fetched | `cleo release` labels | adopt `release-bump-only` classifier |
| Provenance | `LET-XXXX (#PR)` manual | Auto-generated PR list | `T#### (#PR)` from CHANGELOG | adopt cross-citation explicitly |
| Project-agnostic | No | No | Yes (`project-context.json`) | unchanged |
| Idempotency | None | `tag_exists` + `npm_published` flags | Per AGENTS.md, idempotent tag step | strengthen with npm-published check |
| Approval gate | None visible | `environment: npm-publish` (likely human-gated) | None | **add GitHub environment with approver** |
| Multi-archetype | No | No | Yes via `tool:test` resolution | unchanged |

---

## Phase 10 — Concrete Recommendations for CLEO T9345

These are derived directly from the evidence above. Each cites Letta source for the pattern being borrowed (or the gap being avoided).

### 10.1 Adopt the `release-bump-only` classifier (HIGH VALUE, LOW COST)

**Source**: `letta-code/.github/workflows/ci.yml` (Phase 3.4).
**CLEO implementation**: Add a `classify` job to CLEO's CI workflow that detects PRs whose title matches `^chore: bump version to ` (or CLEO's actual bump title format from `cleo release ship`) AND whose changed file list is a subset of `resolveVersionBumpTargets` output. If both conditions match, skip heavy CI jobs.
**Estimated impact**: Cuts CI cost on release PRs by ~80% (typical release PR touches only package.jsons + CHANGELOG.md). 22 workspace targets × pnpm build = significant.

### 10.2 Add an integration smoke gate inside `cleo release ship` (HIGH VALUE, MEDIUM COST)

**Source**: `letta-code/.github/workflows/release.yml` "Integration smoke test (real API)" step (Phase 3.4).
**CLEO implementation**: After step 11 ("Wait for CI green") and before step 12 ("Merge + tag"), add a new step: `cleo orchestrate spawn <smoke-task-id>` against a small ephemeral task, verify the spawn returns within N seconds with `success: true`. Use a test task in a sandbox project to avoid polluting real state.
**Estimated impact**: Catches "the published artifact doesn't actually run" failures — the worst class of release bug, which currently has no defense in CLEO.

### 10.3 Adopt `T#### (#PR)` cross-citation in CHANGELOG (HIGH VALUE, LOW COST)

**Source**: `letta-ai/letta` release notes for v0.16.7 (Phase 3.5).
**CLEO implementation**: `cleo release ship` step 6 (CHANGELOG generation) already filters by `completedAt > previousVersion.pushedAt`. Augment it to also fetch the PR number that closed each task (from `cleo task <id>` `closingPr` field if it exists, or by parsing `git log --grep "$taskId"`). Format as `T1234 (#567) — task description`.
**Estimated impact**: Restores the provenance graph that Letta builds by hand. CLEO can do it automatically because tasks live in `.cleo/tasks.db`.

### 10.4 Add a GitHub Environment gate to npm/Docker publish (HIGH VALUE, LOW COST)

**Source**: `letta-code/release.yml` `environment: npm-publish` (Phase 3.4 inference).
**CLEO implementation**: Configure a GitHub Environment named e.g. `release-publish` on the cleocode repo with `required_reviewers: [owner]`. Update the GitHub Actions workflow that runs `npm publish` to declare `environment: release-publish`. Optionally add a `wait_timer` of 5 minutes.
**Estimated impact**: Adds a final human cross-check between "CI green" and "npm package out the door." Defense against compromised release tooling.

### 10.5 Strengthen idempotency flags (MEDIUM VALUE, LOW COST)

**Source**: `letta-code/release.yml` `tag_exists` + `npm_published` flags (Phase 3.4).
**CLEO implementation**: Per AGENTS.md, CLEO's tag step is already idempotent. Extend to:
- Check `npm view "@cleocode/cleo@<version>" version` and skip publish if it returns truthy.
- Check `git tag --list "$TAG"` and skip tag creation if present.
- Each of these should be a separate evidence gate so a partial-failure rerun doesn't double-publish.

### 10.6 DO NOT copy Letta's `letta` server release pipeline (NEGATIVE LIFT)

**Source**: `letta/poetry-publish.yml` (Phase 3.3).
**Reasoning**: Zero gates between `release: published` and `uv publish`. CLEO is already ahead of this pattern. If anyone proposes "let's make ship simpler like Letta does it," reject — Letta's server pipeline is a counterexample, not a precedent.

### 10.7 DO NOT adopt Letta's merge-train PR model (NEGATIVE LIFT)

**Source**: PR #3265 `chore: bump 0.16.7` (Phase 6) — 188 files, +13k/−3k.
**Reasoning**: CLEO's `release/v<version>` branch contains ONLY the version bump and CHANGELOG. This is far cleaner to review than Letta's pattern of conflating "the release boundary" with "merge a giant feature train." Keep CLEO's model.

### 10.8 No Letta precedent for these CLEO needs (research negative)

- **Epic-scoped completeness check** — Letta has no equivalent. CLEO's `--epic <id>` check is novel.
- **Evidence-atom gates** (ADR-051) — Letta does no evidence enforcement at all.
- **Project-agnostic tool resolution** — Letta is mono-stack per repo.
- **Decision-only completion atoms** — Letta does not track decisions formally; no precedent.

---

## Phase 11 — Open Questions / Unverified Claims

Items I could not verify with the evidence I have. Each would require deeper access (admin token, private docs, or paid Letta Cloud account).

1. **Is `letta-code/release.yml`'s `environment: npm-publish` actually gated by a human approver?** I inferred from the environment name but did not confirm. Would need `gh api repos/letta-ai/letta-code/environments/npm-publish` with admin scope. **No evidence found.**
2. **Does main branch protection on `letta` require status checks before merge?** Returned 404 to my token. Observational evidence (every commit on main has a `(#XXXX)` PR suffix) suggests yes, but I cannot confirm the YAML. **No evidence found.**
3. **Is the LET-XXXX tracker actually Linear?** Format matches, but no public confirmation. **No evidence found.**
4. **Does the `release.yml` integration smoke against `LETTA_API_KEY` test self-hosted or cloud?** The secret name implies cloud, but it could be a test instance. **No evidence found.**
5. **Does Letta have any release-validation test suite that runs post-publish?** I see pre-publish smoke tests but no post-publish "did the new version on PyPI/npm actually install and work?" check. **No evidence found.**

---

## Phase 12 — Source Inventory

Every source consulted, with status:

| URL / API endpoint | Fetched? | Notes |
|---|---|---|
| `https://github.com/letta-ai/letta` (README + repo home) | Yes | Confirmed canonical |
| `https://github.com/letta-ai/letta/releases` | Yes (HTML) | Tag list visible |
| `gh api repos/letta-ai/letta` | Yes | Metadata |
| `gh api repos/letta-ai/letta/releases?per_page=15` | Yes | Tag/author/date list |
| `gh api repos/letta-ai/letta/releases/tags/0.16.8` | Yes | Auto-generated style |
| `gh api repos/letta-ai/letta/releases/tags/0.16.7` | Yes | Hand-curated style |
| `gh api repos/letta-ai/letta/releases/tags/0.16.6` | Yes | Categorical style (lighter) |
| `gh api repos/letta-ai/letta/releases/tags/0.16.0` | Yes | Mixed |
| `gh api repos/letta-ai/letta/pulls/3265` | Yes | The merge-train PR |
| `gh api repos/letta-ai/letta/pulls/3265/files` | Yes | 188 files |
| `gh api repos/letta-ai/letta/commits?per_page=20` | Yes | Commit log |
| `gh api repos/letta-ai/letta/branches/main/protection` | **404** | Token scope insufficient |
| `gh api repos/letta-ai/letta/labels?per_page=30` | Yes | 28 labels |
| `gh api repos/letta-ai/letta/contents/CONTRIBUTING.md` | Yes (base64 decoded) | Contributor workflow |
| `gh api repos/letta-ai/letta/contents/SECURITY.md` | Yes | Email-to-support security policy |
| `gh api repos/letta-ai/letta/contents/.github/workflows/poetry-publish.yml` | Yes | The no-gate publish workflow |
| `gh api repos/letta-ai/letta/contents/.github/workflows/poetry-publish-nightly.yml` | Yes (summary via WebFetch) | Nightly with .dev timestamp |
| `gh api repos/letta-ai/letta/contents/.github/workflows/docker-image.yml` | Yes | Docker Hub multi-arch |
| `gh api repos/letta-ai/letta/contents/.github/workflows/core-unit-test.yml` | Yes (summary) | 22 matrix suites |
| `gh api repos/letta-ai/letta/contents/.github/workflows/core-lint.yml` | Yes (summary) | Pyright + Ruff |
| `gh api repos/letta-ai/letta/contents/.github/workflows/issue-guard.yml` | Yes (head) | Anti-spam workflow |
| `gh api repos/letta-ai/letta/contents/.github/workflows/reusable-test-workflow.yml` | Yes (head) | Parameterized reusable |
| `gh api repos/letta-ai/letta/contents/.github/workflows/fern-sdk-typescript-publish.yml` | Yes | TS SDK release flow |
| `gh api repos/letta-ai/letta/contents/.github/workflows/fern-sdk-python-publish.yml` | Yes (summary) | Python SDK release flow |
| `https://github.com/letta-ai/letta/blob/main/pyproject.toml` | Yes (summary) | Version + deps |
| `https://github.com/letta-ai/letta/blob/main/letta/__init__.py` | Yes (summary) | `__version__` source |
| `https://github.com/letta-ai/letta/blob/main/.github/release.yml` | **404** | File does NOT exist |
| `https://github.com/letta-ai/letta/blob/main/CHANGELOG.md` | **404** | File does NOT exist |
| `https://github.com/letta-ai/letta/tree/main/.github` (file listing) | Yes (partial) | No release-please configs found |
| `https://github.com/letta-ai/letta-code` (repo home) | Yes | "memory-first coding harness" tagline |
| `gh api repos/letta-ai/letta-code` | Yes | Metadata |
| `gh api repos/letta-ai/letta-code/releases?per_page=10` | Yes | `github-actions[bot]` author |
| `gh api repos/letta-ai/letta-code/releases/tags/v0.25.9` | Yes | Standard PR-list notes |
| `gh api repos/letta-ai/letta-code/contents/.github/workflows` | Yes | 6 workflow files |
| `gh api repos/letta-ai/letta-code/contents/.github/workflows/prepare-release.yml` | Yes (full YAML) | Stage 1 of two-stage release |
| `gh api repos/letta-ai/letta-code/contents/.github/workflows/release.yml` | Yes (full YAML) | Stage 2 with smoke tests |
| `gh api repos/letta-ai/letta-code/contents/.github/workflows/ci.yml` | Yes (head + classify job) | release-bump-only classifier |
| `https://docs.letta.com/concepts/letta` | Yes (summary) | "agent harness" terminology |
| `https://docs.letta.com/concepts/letta-code` | **404** | Slug may differ |
| `https://docs.letta.com/quickstart` | Yes (summary) | Cloud / self-host distinction |
| `https://docs.letta.com` (root) | Yes (metadata only) | "memory-first coding agent" |

---

## Phase 13 — Methodology and Self-Critique

**What I did well**:
- Cited every claim with a URL or `gh api` call.
- Distinguished between **`letta` server** (anti-pattern, no gates) and **`letta-code` harness** (good pattern with smoke tests) — these are easily conflated.
- Extracted the full YAML for the two most important workflows (`prepare-release.yml` and `release.yml`) so CLEO maintainers can read them directly.
- Explicitly flagged 5 items where I could not find evidence rather than inventing.

**Where I would dig further with more time**:
- Get an admin token to `letta-ai/letta-code` to confirm the `npm-publish` environment's reviewer list. This would change recommendation 10.4 from inference to confirmation.
- Read more `letta-code` releases (v0.24.x, v0.23.x) to see whether the two-stage pipeline has been stable or evolving.
- Diff the merge-train PR #3265 commit-by-commit to verify whether it's truly a long-lived branch or a squash bundle.
- Check Letta's Linear (if accessible) to see how `LET-XXXX` IDs are linked to PRs operationally — there may be a Linear-GitHub integration doing this automatically.

**Confidence levels**:
- HIGH confidence: All Phase 3.3 and 3.4 facts about workflow YAML content (full verbatim sources captured).
- HIGH confidence: All Phase 2 architectural facts about the two-repo split.
- MEDIUM confidence: Phase 6 "merge train" interpretation — I have the file count but did not walk the branch history commit-by-commit.
- LOW confidence: Phase 5 row #6 (branch protection) — observational evidence only.

---

End of research document. Path:
`/mnt/projects/cleocode/.cleo/rcasd/T9345/research/letta-harness-real-research.md`
