# Hermes-Agent — Real-World Research (T9345 IVTR Release System)

**Status**: Research artifact — primary evidence for T9345 RCASD phase
**Researcher**: cleo-prime (T9345 research worker)
**Date compiled**: 2026-05-15
**Primary sources**: Local clone at `/mnt/projects/hermes-agent/` (fork of `NousResearch/hermes-agent`, last fetched 2026-05-13, HEAD `d93ac84d9` at `v2026.5.7-583`)
**Secondary sources**: Public README at `https://github.com/NousResearch/hermes-agent`, `https://hermes-agent.nousresearch.com/docs/`, owner's local precedent doc

---

## 0. Executive Summary (300 words)

Hermes-agent is real. It is the canonical project at
`github.com/NousResearch/hermes-agent` ("The self-improving AI agent built by
Nous Research"), MIT-licensed, currently at `v0.13.0` / CalVer tag
`v2026.5.7` (released 2026-05-07). The owner of this CLEO repo already
keeps a fork at `github.com/kryptobaseddev/hermes-agent` with a fully
operational 12-hourly upstream sync workflow, so the local
`/mnt/projects/hermes-agent/` checkout is canonical, current, and
trustworthy as a primary source. There is no ambiguity with "Nous Hermes"
LLM weights or with `Hermes-Function-Calling` — the precedent CLEO's
`docs/specs/hermes-agent-llm-provider-architecture.md` cites is
unambiguously this Python codebase.

**Borrowable for T9345 (HIGH confidence)**: dual CalVer + SemVer tagging
with the `next_available_tag` collision-safe suffixing; commit-driven
Conventional-Commits changelog with author resolution via an
`AUTHOR_MAP`; PR-only main with **release-as-event** (the `release:
published` GitHub event drives downstream deploys and Docker `:latest`
retag); the digest-then-manifest Docker pattern with an ancestor check
that prevents `:main` / `:latest` from regressing; the
"`release.py --bump minor --publish`" single-script pipeline; pinned
direct deps + OSV scanning + supply-chain audit; the
contributor-attribution gate as a CI block.

**NOT borrowable / mismatched for CLEO (HIGH confidence)**: there is NO
multi-stage IVTR-style gate ladder, NO epic-scoped completeness check,
NO task↔commit↔release provenance graph, NO worker-direct-push protection
beyond GitHub branch protection, NO mid-pipeline failure recovery layer
beyond "fix and re-run `release.py`", and NO hotfix bypass path beyond
shipping a same-day suffixed tag (`v2026.X.Y.2`, etc.). The Hermes-agent
release surface is **minimalist and human-driven** — closer to "shell
script + GitHub events" than to CLEO's `cleo release ship` 12-step
pipeline. CLEO must build its own provenance graph and gate runners;
Hermes-agent only offers patterns for tagging, changelog generation,
release-event-driven CI, and contributor attribution.

---

## 1. Identification — Which "Hermes-agent" Is the Precedent?

### 1.1 Candidates considered

| Candidate | What it actually is | Match for CLEO precedent? |
|----------|--------------------|---------------------------|
| **NousResearch/hermes-agent** | The self-improving AI agent platform built by Nous Research. Python, MIT, 24k+ PRs, 200+ contributors. | **YES — confirmed primary** |
| Nous Research "Hermes" model family (Hermes 2 / 3 / 4) | LLM fine-tune weights, not a software project. Lives under HuggingFace, not under a "hermes-agent" repo. | No — model weights, no release pipeline to study. |
| `NousResearch/Hermes-Function-Calling` | Function-calling format spec + sample code. Static repo, ~10 commits, last touched 2024-ish. | No — wrong shape, wrong activity level. |
| `NousResearch/hermes-agent-self-evolution` | Companion repo for DSPy/GEPA skill evolution. | No — adjunct, not the main project. |
| `mudrii/hermes-agent-docs` | Third-party documentation mirror, v0.2.0 only. | No — derivative. |
| LangChain "Hermes" integrations | Provider adapter shims. | No — not a release pipeline. |
| Internal cleocode reference | None — verified by `find /mnt/projects/cleocode -iname '*hermes*'`. | N/A. |

### 1.2 Confirmation

**Local doc** (`docs/specs/hermes-agent-llm-provider-architecture.md:6`)
states `**Source repo**: /mnt/projects/hermes-agent/`. That directory
exists, is a git repo, and its remotes are:

```
origin    https://github.com/kryptobaseddev/hermes-agent.git
upstream  https://github.com/NousResearch/hermes-agent.git
```

`scripts/release.py:1296` hardcodes `repo_url="https://github.com/NousResearch/hermes-agent"`,
which is the canonical confirmation that the upstream identity is
`NousResearch/hermes-agent`. The local CLEO doc explicitly maps Hermes
file paths (`agent/credential_pool.py`, `providers/base.py`,
`agent/transports/types.py`, etc.) onto CLEO Phase 4 contracts, so
**this is the precedent**.

### 1.3 Current release/tag visible

```
v2026.5.7   2026-05-07   Hermes Agent v0.13.0 (2026.5.7)
v2026.4.30  2026-04-30   Hermes Agent v0.12.0 (2026.4.30)
v2026.4.23  2026-04-23   Hermes Agent v0.11.0 (2026.4.23)
v2026.4.16  2026-04-16   Hermes Agent v0.10.0 (2026.4.16)
v2026.4.13  2026-04-13   Hermes Agent v0.9.0 (v2026.4.13)
v2026.4.8   2026-04-08   Hermes Agent v0.8.0 (2026.4.8)
v2026.4.3   2026-04-03   Hermes Agent v0.7.0 (2026.4.3)
v2026.3.30  2026-03-30   Hermes Agent v0.6.0 (2026.3.30)
v2026.3.28  2026-03-28   Hermes Agent v0.5.0 (v2026.3.28)
v2026.3.23  2026-03-23   Hermes Agent v0.4.0 (v2026.3.23)
v2026.3.17  2026-03-17   Hermes Agent v0.3.0 (v2026.3.17)
v2026.3.12  2026-03-12   Hermes Agent v0.2.0 (2026.3.12)
```
*(Source: `git for-each-ref --sort=-creatordate refs/tags/v20*` against the local checkout.)*

The local checkout is 583 commits ahead of `v2026.5.7` on `upstream/main`
(`git describe → v2026.5.7-583-gd93ac84d9`), meaning `v0.14.0` /
`v2026.6.x` is already in flight upstream.

### 1.4 License + maintainer

`LICENSE`: **MIT**, "Copyright (c) 2025 Nous Research". Full text reproduced
in §A1.

Maintainer signals:
- Primary author per `pyproject.toml`: `Nous Research`.
- `scripts/release.py:42` author map enumerates 600+ contributor emails →
  this is a high-traffic public OSS project, not a single-person hobby.
- Release notes (`RELEASE_v0.13.0.md:4`) confirm scale: "864 commits ·
  588 merged PRs · 829 files changed · 128,366 insertions · 282 issues
  closed · 295 community contributors" — for **one** release cycle.

---

## 2. Local Precedent Doc — What CLEO Is Borrowing From Hermes

CLEO's `docs/specs/hermes-agent-llm-provider-architecture.md` treats
Hermes-agent as the architecture reference for **LLM provider stack
unification** (CLEO Phase 4 epic T9261 — already shipped in
`v2026.5.73`). The mapping it documents:

| Hermes component | CLEO Phase 4 equivalent |
|-----------------|------------------------|
| `ProviderProfile` (`providers/base.py`) | `ProviderProfile` (Phase 3, already ported) |
| Provider registry (`providers/__init__.py`) | `ProviderRegistry` (Phase 3) |
| `PooledCredential` (`credential_pool.py`) | Phase 3 `CredentialPool` |
| `CredentialPool.pick_credential()` | `credentialPool.pickCredentialForProvider()` |
| Provider adapters (`*_adapter.py`) | `LlmTransport` impls (Phase 4 W1) |
| `AuxiliaryClient` | `LlmExecutor.execute('compression', …)` |
| `AIAgent` context/turn tracking | `LlmSession` (Phase 4 W2) |
| `NormalizedResponse` | `NormalizedResponse` (Phase 4 W0b contract) |

**Critical context for T9345**: This local doc establishes that CLEO
already imports architecture ideas from Hermes wholesale. T9345 is
asking the orthogonal question — does Hermes have a **release governance
pattern** worth borrowing for the IVTR overhaul? The answer is "yes for
mechanics, no for semantics" — Hermes solved tagging + changelog + CI
glue elegantly, but did NOT solve epic-completeness, gate ladders, or
task-provenance — because Hermes simply doesn't have those concerns.

Quote (`hermes-agent-llm-provider-architecture.md:14-18`):

> Hermes Agent is a Python-based multi-provider LLM agent framework. Its
> LLM provider stack solves the same core problems that CLEO Phase 4
> targets …

The doc never claims Hermes solves release governance. It is purely a
provider-stack precedent.

---

## 3. Release & Governance Patterns — The Evidence

### 3.1 Versioning scheme — dual CalVer + SemVer

**Source**: `scripts/release.py:1056-1082` + `pyproject.toml:7` + tag
history above.

Hermes-agent runs **dual versioning**:

- **CalVer**: `v<YYYY>.<M>.<D>` — used as the **git tag** and the
  GitHub release name. Same-day collisions get a `.<N>` suffix
  starting at `.2` (`scripts/release.py:1044-1053`).
- **SemVer**: `<MAJOR>.<MINOR>.<PATCH>` — lives in
  `hermes_cli/__init__.py` and `pyproject.toml`. Bumped explicitly via
  `--bump {major|minor|patch}` (`scripts/release.py:1063-1082`).

The two are linked but independent. Example: `v0.13.0` (SemVer) ships
under the tag `v2026.5.7` (CalVer date `2026.5.7`). The release title
is `Hermes Agent v0.13.0 (2026.5.7)`.

Why this matters for CLEO: CLEO is also on CalVer (per
`AGENTS.md` "CalVer YYYY.MM.patch") but is **single-versioned** —
the tag is the only identity. Hermes-agent shows a working pattern for
keeping CalVer-as-tag while still emitting SemVer for downstream
packagers (Homebrew, AUR, Nix) — the wheel filename uses the SemVer
(`hermes_agent-0.13.0-py3-none-any.whl`), the GitHub release uses
the CalVer tag, and `pyproject.toml` is bumped on every release.

Key code (`scripts/release.py:1085-1109`):

```python
def update_version_files(semver: str, calver_date: str):
    """Update version strings in source files."""
    # Update __init__.py — both __version__ and __release_date__
    content = re.sub(r'__version__\s*=\s*"[^"]+"',
                     f'__version__ = "{semver}"', content)
    content = re.sub(r'__release_date__\s*=\s*"[^"]+"',
                     f'__release_date__ = "{calver_date}"', content)
    # Update pyproject.toml — version = "X.Y.Z"
    pyproject = re.sub(r'^version\s*=\s*"[^"]+"',
                       f'version = "{semver}"',
                       pyproject, flags=re.MULTILINE)
```

### 3.2 The release pipeline — `scripts/release.py`

**Source**: `scripts/release.py:1400-1564` (the `main()` function), full
file `1568` lines.

Hermes-agent does **not** use a GitHub Actions release workflow. There
is no `release.yml` in `.github/workflows/`. The release pipeline is a
**single Python script** run from a maintainer's laptop with `gh` CLI:

```bash
# 1. Preview (dry run, default)
python scripts/release.py --bump minor

# 2. Ship it
python scripts/release.py --bump minor --publish

# 3. First-ever release
python scripts/release.py --bump minor --publish --first-release

# 4. Override CalVer date (belated release)
python scripts/release.py --bump minor --publish --date 2026.3.15
```

The 12 steps `release.py main()` executes when `--publish`:

| # | Step | Source |
|--:|------|--------|
| 1 | Compute CalVer date (or accept `--date`) | `release.py:1414-1419` |
| 2 | Resolve next available tag (same-day suffix safe) | `release.py:1421-1424` |
| 3 | Read current SemVer from `hermes_cli/__init__.py` | `release.py:1427-1431` |
| 4 | Find previous tag (`v20*`, sort `-v:refname`) | `release.py:1434-1438` |
| 5 | Gather commits since prev tag (no merges, with co-authors) | `release.py:1440-1445` |
| 6 | Generate categorized changelog markdown | `release.py:1459-1470` |
| 7 | Update `__init__.py` + `pyproject.toml` version strings | `release.py:1478-1480` |
| 8 | `git add` + `git commit` version bump | `release.py:1482-1494` |
| 9 | `git tag -a <tag> -m "Hermes Agent v<X.Y.Z> (<calver>)\n\nWeekly release"` | `release.py:1496-1504` |
| 10 | `git push origin HEAD --tags` | `release.py:1506-1513` |
| 11 | Build sdist + wheel via `python -m build` (optional; non-fatal if missing) | `release.py:1515-1521` |
| 12 | `gh release create <tag> --title ... --notes-file ... <artifacts>` | `release.py:1523-1558` |

**Critical absences**:
- No pre-flight test gate (CI runs on every PR; release.py trusts
  `main` is green at publish time).
- No lint/typecheck gate (same).
- No "epic completeness" check (Hermes has no epic concept).
- No "wait for CI green" step.
- No branch-cut step — releases tag `main` directly.
- No hotfix branch model — same-day patches get `.2`, `.3` suffixes
  on the date.

**Comparison to CLEO `cleo release ship`** (12 steps per
`AGENTS.md` "Release & Branching (ADR-065)"): CLEO's pipeline includes
**all** the absences above as explicit steps (gates 2-5, 8, 11). Hermes
gets away with less because it has fewer enforcement targets — a
single Python package, no Rust workspace, no per-task acceptance gates,
no IVTR loop.

### 3.3 The release-as-event model

**Source**: `.github/workflows/docker-publish.yml:24-26`,
`.github/workflows/deploy-site.yml:3-5`.

The downstream automation hangs off the **`release: published` GitHub
event**, not off a tag push:

- `docker-publish.yml:24` — `on: release: types: [published]` →
  triggers the multi-arch Docker build + `:latest` retag.
- `deploy-site.yml:3-5` — `on: release: types: [published]` →
  triggers Vercel deploy hook + GitHub Pages docs build.

This is a **decoupling pattern**: the release.py script tags the commit
and creates the GitHub release; CI side-effects fan out asynchronously
when the release is "published" in the GitHub UI/API. Pushing a tag
alone does NOT trigger them — the GitHub Release object (created by
`gh release create` in step 12) is the trigger.

Why CLEO should care: CLEO's `cleo release ship` step 12 currently
"merges + tags from main + cleanup". If T9345 surfaces a need to fan
out downstream effects (docs deploy, container retag, sentinel
notification) without tightly coupling them to the in-band ship
pipeline, the `release: published` event provides a clean seam.

### 3.4 Docker `:main` vs `:latest` — the ancestor check

**Source**: `.github/workflows/docker-publish.yml:290-535`.

This is the most sophisticated CI piece Hermes ships. Two floating
tags:

- `:main` — moves on every push to `main` (the "dev build").
- `:latest` — moves only on `release: published` (the "stable release").

Both use the **same protection pattern** — read the OCI revision label
off the current registry image, look up that commit in git, and only
advance the tag if the candidate commit is a strict ancestor (descendant
of the current `:main` SHA). Quote
(`.github/workflows/docker-publish.yml:399-406`):

```bash
# Our SHA must be a descendant of the current :main to be safe.
if git merge-base --is-ancestor "${current_sha}" "${GITHUB_SHA}"; then
  echo "Our commit is a descendant of :main — safe to advance."
  echo "push_main=true" >> "$GITHUB_OUTPUT"
else
  echo "Another run advanced :main past us (or diverged) — leaving it alone."
  echo "push_main=false" >> "$GITHUB_OUTPUT"
fi
```

Combined with `concurrency: cancel-in-progress: false`, this means
`:main` and `:latest` can **never go backwards in git history**, even
under race conditions (two CI runs landing concurrently) or backport
scenarios (releasing `v1.1.5` after `v1.2.3` is already out — the older
release sees the ancestor check fail and leaves `:latest` alone).

**For CLEO T9345**: This is the gold standard pattern for "tag-to-merge-
commit alignment" (CLEO failure mode #5). CLEO currently does
`git merge --no-ff` then tag from main; the ancestor check would
catch the case where main has advanced between merge and tag.

### 3.5 Multi-arch Docker pipeline

**Source**: `.github/workflows/docker-publish.yml:42-289`.

Pattern:
1. `build-amd64` job — native amd64, build + load + smoke test + push
   by-digest (no tag).
2. `build-arm64` job — native arm64 on `ubuntu-24.04-arm`, same shape.
3. `merge` job — `docker buildx imagetools create -t <tag>` stitches
   the two digests into one manifest list. Runs in ~30s, no rebuild.
4. `move-main` / `move-latest` — ancestor-checked floating tag
   advancement (see §3.4).

**Smoke test step** (`.github/actions/hermes-smoke-test/action.yml:29-47`):
the image must respond to `hermes --help` AND `hermes dashboard --help`
before the digest is pushed. The dashboard subcommand check is an
explicit regression guard for issue #9153 (dashboard was once present
in source but missing from the published image).

**For CLEO**: The smoke-test-before-push pattern is directly portable.
CLEO already smokes against an installed binary post-release; pulling
the smoke gate **into** the release pipeline (between build and push)
would convert post-mortem incidents into pre-flight blocks.

### 3.6 CI gate inventory (current upstream)

Every workflow:

| File | Trigger | Blocks merge? | Purpose |
|------|---------|---------------|---------|
| `tests.yml` | push/PR to main | YES (timeout 20 min, full pytest) | Test gate |
| `lint.yml` | push/PR | YES (ruff `--exit-zero` advisory + `ruff check .` blocking) + Windows footgun checker | Lint + Windows-unsafe primitive gate |
| `uv-lockfile-check.yml` | push/PR touching pyproject/uv.lock | YES (`uv lock --check`) | Lockfile-drift gate |
| `contributor-check.yml` | PR (Python files only) | YES (`AUTHOR_MAP` coverage) | Attribution gate |
| `osv-scanner.yml` | PR + weekly schedule | NO (`fail-on-vuln: false`) | CVE detection (advisory) |
| `supply-chain-audit.yml` | PR | YES (.pth files, base64+exec, obfuscated subprocess, install hooks) | Anti-litellm-style supply-chain payload scan |
| `docker-publish.yml` | push/PR/release | YES on PR (build + smoke); pushes on main/release | Multi-arch Docker |
| `deploy-site.yml` | release/push to website | (deploys) | Docs deploy |
| `docs-site-checks.yml` | PR touching website | YES (Docusaurus build) | Docs build gate |
| `nix.yml` | push/PR | (advisory) | Nix flake build |
| `nix-lockfile-fix.yml` | push/PR | (advisory) | Nix lockfile maintenance |
| `skills-index.yml` | schedule (twice daily) + push | n/a | Skills hub index regen |
| `sync-upstream.yml` (fork-only) | schedule every 12h | n/a | Kryptobaseddev fork → upstream sync |

**Key observation**: The `lint.yml` workflow has two jobs —
`lint-diff` (advisory; produces PR comment showing ruff+ty diagnostics
diff vs base) and `ruff-blocking` (only enforces rules in
`pyproject.toml [tool.ruff.lint.select]`, currently just `PLW1514`).
This is a **deliberately narrow enforcement surface**. Quote
(`pyproject.toml:248-255`):

```toml
[tool.ruff.lint]
# All other lints are intentionally disabled (see comment history on this
# file) while we wrangle typechecks — but PLW1514 is too load-bearing to
# keep off.  Bare open()/read_text()/write_text() in text mode defaults to
# the system locale encoding on Windows (cp1252 on US-locale installs),
# which silently corrupts any non-ASCII file content.
```

This is gate philosophy at its purest: enforce only what catches real
production bugs; let everything else be advisory. CLEO's `pnpm biome
ci .` is the equivalent today (full repo-wide strict), but the Hermes
pattern of "block on the one rule that bites; advise on the rest" is
worth considering for CLEO's IVTR test gates.

### 3.7 Changelog generation — the `RELEASE_vX.Y.Z.md` artifact

**Source**: `scripts/release.py:1296-1397` + the 12 `RELEASE_v*.md`
files in repo root.

Hermes-agent commits the rendered changelog into the repo as
`RELEASE_v0.13.0.md` etc. — a permanent, browsable, agent-readable
artifact at the repo root. The script `release.py`:

1. Walks `git log <prev_tag>..HEAD --no-merges --format='%H|%an|%ae|%s\0%b\0'`.
2. Parses each commit's subject for Conventional-Commits prefix; falls
   back to keyword heuristics (`add `, `new `, `fix `, …).
3. Extracts `Co-authored-by:` trailers from the body, **filtering
   AI/bot emails** (`noreply@anthropic.com`, `cursor.com`, etc.) —
   see `release.py:1222-1225`.
4. Resolves git email → GitHub `@username` via:
   - Hand-maintained `AUTHOR_MAP` (~600+ entries in `release.py:41-1010`).
   - GitHub noreply pattern `\d+\+(.+)@users\.noreply\.github\.com`.
   - Fallback to git author name.
5. Groups by category (breaking, features, improvements, fixes, docs,
   tests, chore, other) with emoji headers.
6. Emits a "Contributors" section ordered by commit count, with the
   project owner (`@teknium1`) excluded by convention.
7. Appends the compare URL:
   `**Full Changelog**: [v2026.4.30...v2026.5.7](https://github.com/.../compare/v2026.4.30...v2026.5.7)`.

**Critical detail for CLEO** (`release.py:1316-1326`):
```python
all_authors = set()
teknium_aliases = {"@teknium1"}

for commit in commits:
    categories[commit["category"]].append(commit)
    author = commit["github_author"]
    if author not in teknium_aliases:
        all_authors.add(author)
    for coauthor in commit.get("coauthors", []):
        if coauthor not in teknium_aliases:
            all_authors.add(coauthor)
```

This is the only "provenance" Hermes tracks — author identity. There is
no task tracker, no issue↔commit graph, no epic linkage. **The
changelog is the provenance ledger.** CLEO already has 10× richer
provenance (tasks.db, BRAIN, acceptance gates) — but the discipline of
emitting one canonical, committed-to-repo artifact per release is
worth borrowing.

### 3.8 The contributor-attribution gate

**Source**: `.github/workflows/contributor-check.yml:1-73`.

This is a CI block specifically for protecting `release.py`'s author
resolution. Triggered on every PR that touches `.py` files. It:

1. Computes `git merge-base origin/main HEAD`.
2. Extracts every author email in the PR's commits.
3. Skips bot emails (`teknium`, `noreply@github.com`, `dependabot`,
   `github-actions`, `anthropic.com`, `cursor.com`).
4. Auto-resolves GitHub noreply emails (`\d+\+.+@users.noreply.github.com`).
5. For every remaining email, checks if it's quoted in
   `scripts/release.py` (just a `grep -qF`).
6. **Fails the job** if any email is unmapped, printing exact
   `AUTHOR_MAP` entries to add.

This is a **provenance enforcement** pattern. The build is blocked
until every contributor can be attributed in the changelog. CLEO has no
analogous gate — but if T9345 wants to track task↔commit↔release
identity, the pattern of "fail CI if attribution metadata is missing"
is directly applicable.

### 3.9 Branch + PR discipline

**Source**: `CONTRIBUTING.md:739-792` + `AGENTS.md:866-872`.

| Rule | Source | Notes |
|------|--------|-------|
| Branch naming: `fix/`, `feat/`, `docs/`, `test/`, `refactor/<slug>` | `CONTRIBUTING.md:741-749` | Strong convention, not CI-enforced. |
| One logical change per PR | `CONTRIBUTING.md:756` | Reviewer-enforced. |
| Conventional Commits required | `CONTRIBUTING.md:766-791` | Drives `release.py` categorization. |
| Squash merge default | `AGENTS.md:866-872` | Explicit warning: "Before squash-merging a PR, ensure the branch is up to date with `main`… a stale branch's version of an unrelated file will silently overwrite recent fixes on main when squashed." |
| Verify with `git diff HEAD~1..HEAD` after merge | `AGENTS.md:871-872` | Manual post-merge check; no automation. |
| `pytest tests/ -q` before opening PR | `CONTRIBUTING.md:753` | Plus `scripts/run_tests.sh` for CI parity. |
| Cross-platform impact assessment | `CONTRIBUTING.md:755`, plus `scripts/check-windows-footguns.py` CI gate | Explicit Windows-specific check enforced via lint workflow. |

**No mention** of branch protection rules in markdown. Branch protection
is a GitHub-API-side setting; no evidence of it in the local checkout.
The `permissions: contents: read` on most workflows hints at minimum-
privilege, but CLEO's `gh api -X PUT repos/:owner/:repo/branches/main/protection`
explicit setup (per CLEO `AGENTS.md`) is more rigorous than anything
Hermes documents publicly.

### 3.10 Supply-chain posture

**Source**: `pyproject.toml:13-63`, `osv-scanner.yml`, `supply-chain-audit.yml`,
`dependabot.yml`.

Hermes-agent is **paranoid** about supply chain (response to the
"Mini Shai-Hulud worm" on mistralai 2.4.6 — see `pyproject.toml:18-26`):

- **Every direct dependency is exact-pinned** (`==X.Y.Z`, no ranges):

  ```toml
  "openai==2.24.0",
  "python-dotenv==1.2.1",
  "fire==0.7.1",
  ...
  ```

- **`uv.lock` mandatory + drift-checked in CI** (`uv-lockfile-check.yml`).
- **Dependabot scoped to GitHub Actions only** — explicitly NOT to pip
  or npm, because automatic version-bump PRs would defeat the pinning
  strategy. Quote (`dependabot.yml:1-22`):
  > "We do NOT enable Dependabot for pip / npm / any source-dependency
  > ecosystem because we pin source dependencies exactly … Automatic
  > version-bump PRs against those pins would undermine the strategy"
- **OSV-Scanner** runs on every PR touching lockfiles + weekly. Findings
  upload to GitHub Security tab as SARIF. **`fail-on-vuln: false`** —
  detection only, pin moves are deliberate.
- **Supply-chain-audit** scans diffs for litellm-style attack patterns:
  `.pth` files, `base64.decode + exec/eval` combos, obfuscated subprocess
  args, install-hook files. **Fails CI** on hits.
- **Lazy deps** (`tools/lazy_deps.py`) — provider-specific packages
  (anthropic, firecrawl, exa-py, fal-client, edge-tts, modal, daytona,
  vercel, mautrix, …) are NOT in `[all]` and lazy-install at first use,
  to keep the install blast radius minimal.

**For CLEO T9345**: This is best-in-class supply-chain posture for an
agent framework. CLEO's pnpm-based stack has analogous concerns (the
recent npm-supply-chain incidents in 2025-2026); the patterns of
exact pinning + lockfile-drift CI + scoped dependabot + diff-based
attack-pattern scanning are directly portable.

### 3.11 Release cadence (observed)

Tag history `git for-each-ref` shows:

```
v0.13.0  2026-05-07  (+7 days from v0.12.0)
v0.12.0  2026-04-30  (+7 days)
v0.11.0  2026-04-23  (+7 days)
v0.10.0  2026-04-16  (+3 days from v0.9.0 — short Tool Gateway release)
v0.9.0   2026-04-13  (+5 days from v0.8.0)
v0.8.0   2026-04-08  (+5 days)
v0.7.0   2026-04-03  (+4 days)
v0.6.0   2026-03-30  (+2 days from v0.5.0)
v0.5.0   2026-03-28  (+5 days from v0.4.0)
v0.4.0   2026-03-23  (+6 days)
v0.3.0   2026-03-17  (+5 days)
v0.2.0   2026-03-12  (first tagged release)
```

**Pattern**: weekly cadence with occasional 2-5 day off-cycle drops.
Annotated tags carry the message `Hermes Agent v<X.Y.Z> (<calver>)\n\nWeekly release`
(`release.py:1499`). No "release candidate" tags. No "next" branch.
Just `main` → tag → ship.

---

## 4. Project Structure

### 4.1 Top-level layout

Hermes-agent is a **single Python package** (not a monorepo) with some
hand-curated subdirs:

```
/mnt/projects/hermes-agent/
  agent/          # Core agent — credential_pool, transports, *_adapter.py
  acp_adapter/    # Agent Communication Protocol (Zed, VS Code, JetBrains)
  hermes_cli/     # CLI entry points + subcommands
  gateway/        # Messaging gateway (20 platforms)
  tui_gateway/    # Python JSON-RPC backend for the Ink/React TUI
  ui-tui/         # The Ink/React TUI itself (Node.js)
  tools/          # Built-in tools — file_operations, terminal, web, etc.
  toolsets.py     # Toolset definitions
  skills/         # Bundled skills (in-repo)
  optional-skills/  # Lazy-installable skills
  plugins/        # General plugins
    model-providers/  # ProviderProfile ABC — user-extensible
    memory/           # Memory-provider plugins
  providers/      # Bundled provider profiles (Anthropic, Bedrock, etc.)
  cron/           # Cron scheduler
  environments/   # RL/Atropos training environments
  scripts/        # Maintenance scripts incl. release.py
  tests/          # Pytest suite (3,289+ tests per v0.2.0 highlights)
  website/        # Docusaurus docs site (deploys to hermes-agent.nousresearch.com)
  docker/         # Dockerfile inputs
  nix/            # Nix flake
  ...
```

No `packages/`, no workspace nesting. Even `ui-tui/` (Node.js TUI)
sits at top level rather than under a `packages/` umbrella. The build
system is `setuptools` + `uv` (NOT poetry, NOT hatchling).

### 4.2 Versioning artifacts

The "version is the version" is encoded in exactly two places:
- `hermes_cli/__init__.py` — `__version__` and `__release_date__`
- `pyproject.toml` — `[project] version = "..."`

`release.py:1085-1109` updates both atomically. The git tag is a
**third** identity (CalVer) computed from "today".

### 4.3 Test layout + invocation

Per `CONTRIBUTING.md:106-118` and `AGENTS.md:897-940`:

- Test wrapper: **`scripts/run_tests.sh`** — MANDATORY (closes 5 sources
  of local↔CI drift: API keys, HOME path, TZ, locale, xdist worker count).
- Direct `pytest` invocation is permitted only with `-n 4` and `.venv`
  activated.
- "Change-detector tests" are forbidden (`AGENTS.md:942-989`) — tests
  asserting "the catalog contains gemini-2.5-pro" are deleted in favor
  of invariant tests ("every catalog entry has a context length").

This is **deep test discipline**, but it operates at the gate-runner
level, not the release-pipeline level. There is no "epic test gate" or
"per-task test gate" — just one suite that runs on every PR.

### 4.4 Portability — can the patterns work for non-Hermes projects?

**HIGH portability** (mechanical patterns):
- The `release.py` shape works for **any** language ecosystem — it's
  pure subprocess + git + gh CLI. Drop in different `update_version_files`
  for Cargo/Node/etc.
- The dual CalVer + SemVer pattern with `next_available_tag` collision
  suffixing works anywhere git tags work.
- The Docker `:main` + `:latest` ancestor check works for any project
  that publishes container images.
- The `release: published` event-driven downstream automation works for
  any GitHub-hosted project.
- The contributor-attribution gate works for any project that wants to
  emit a credited changelog.
- The supply-chain audit + OSV scanner patterns work for any project
  that pins direct deps.

**LOW portability** (project-specific assumptions):
- `release.py` AUTHOR_MAP is a 600+ entry hand-maintained file. CLEO's
  smaller contributor base needs less, but the file-as-source-of-truth
  pattern still applies.
- The lazy-deps pattern is Python-specific (`tools/lazy_deps.py`
  intercepts `ImportError` at first use). CLEO already pins via
  workspace pnpm.
- The `:latest` vs `:main` Docker bifurcation assumes a stable-vs-dev
  channel. CLEO doesn't currently publish containers.
- The `release.py` "weekly release" assumption (annotated tag message)
  doesn't fit CLEO's CalVer-on-demand cadence.

---

## 5. CLEO Failure-Mode Mapping

This section directly addresses the 7 CLEO failure modes from the
T9345 charter. For each, does Hermes-agent have a solution?

### 5.1 Mid-pipeline failure recovery

**Hermes status**: **Partial**. `release.py` is structured so each step
prints its own success/failure marker (`✓`/`✗`). Failed steps print
manual-recovery commands (e.g. `release.py:1554-1558` — if `gh release
create` fails, prints the exact retry command and the path to the
saved release notes file). But there is no resumable state machine —
if step 9 (tag) succeeds and step 12 (gh release) fails, the operator
re-runs step 12 by hand.

**Borrowable**: The "print exact recovery command on failure" pattern.
CLEO already emits structured errors; adding "here's the exact command
to resume" is a small UX win.

**Not borrowable**: No transactional rollback. Hermes accepts partial
state and human cleanup.

### 5.2 Epic-scoped completeness checks

**Hermes status**: **No equivalent**. Hermes has no concept of an epic.
Releases are time-driven ("everything since the last tag"), not
scope-driven ("everything in epic T9261"). The completeness check is
implicit: "if it's merged to main since the last tag, it ships."

**Borrowable**: Nothing. CLEO's epic completeness check is a
CLEO-specific invariant; Hermes provides no precedent.

**Implication for T9345**: CLEO's epic-completeness check (`cleo release
verify --epic TXXXX` per the workflow doc) is *unique* and must be
designed without external reference. Hermes-agent provides no template.

### 5.3 Real gate runners (not theater)

**Hermes status**: **Partial — strong CI gates, weak release gates**.
Hermes CI runs `tests`, `lint` (blocking on PLW1514 only), `windows-footguns`,
`uv-lockfile-check`, `supply-chain-audit` on every PR. These are
**real gates** with no bypass. But the **release pipeline itself
(release.py) runs no gates** — it trusts main is green. The release
is therefore "merge-time gates only".

**Borrowable**: The "gate runner = subprocess that exits non-zero or
posts SARIF" pattern. Specifically:
- `scripts/check-windows-footguns.py` (lint.yml line 202) is invoked
  as a plain Python script with `--all` flag, exit non-zero on hit.
  CLEO's gate runners (per ADR-051 evidence) could adopt the same
  "tool returns canonical name → exit code → cached result" shape that
  Hermes already uses for ruff/ty/`uv lock --check`.
- The supply-chain-audit "scan diff for narrow attack patterns and
  post PR comment" pattern is portable as an extra gate.

**Not borrowable**: No "wait for CI green before tagging" step in
release.py. CLEO's current `cleo release ship` step 11 (15-minute CI
timeout) is more rigorous than anything Hermes does.

### 5.4 Hotfix bypass paths

**Hermes status**: **Implicit pattern**. There are no hotfix branches.
Same-day patches use the suffix mechanism:

```python
# release.py:1044-1053
def next_available_tag(base_tag: str) -> tuple[str, str]:
    """Return a tag/calver pair, suffixing same-day releases when needed."""
    if not git("tag", "--list", base_tag):
        return base_tag, base_tag.removeprefix("v")

    suffix = 2
    while git("tag", "--list", f"{base_tag}.{suffix}"):
        suffix += 1
    tag_name = f"{base_tag}.{suffix}"
    return tag_name, tag_name.removeprefix("v")
```

So if `v2026.5.7` shipped this morning and a P0 bug appears this
afternoon, the fix lands on main as a PR, then `release.py --publish`
creates `v2026.5.7.2`. No branch, no merge dance. Same-day `.3`, `.4`
if needed.

**Backport scenario** (older-release-branch hotfix): the `move-latest`
ancestor check (§3.4) is the only protection. If a backport release
SHA is NOT a descendant of the current `:latest`, `:latest` stays put.
Older releases get their tag but don't update the floating "latest"
pointer.

**Borrowable**: The same-day suffix pattern (`v<base>.<N>` starting at
`.2`) is elegant and avoids branch proliferation. CLEO currently jumps
the patch number (`v2026.5.74` after `v2026.5.73`), which works but
doesn't carry the "same-day patch" signal in the tag itself.

### 5.5 Tag-to-merge-commit alignment

**Hermes status**: **Strong** — see §3.4. The OCI revision label +
git merge-base ancestor check is the gold-standard protection against
floating tags regressing. The tag itself is annotated and created
locally by `release.py:1497-1504`, then pushed with `git push origin
HEAD --tags`. If `HEAD` advances on origin between local tag and push,
the push is forced to fail (no `--force` in `release.py:1507`).

**Borrowable**:
1. **OCI revision label + ancestor check** — directly portable to any
   floating-tag scheme.
2. **Annotated tags with structured messages** — `release.py:1499`
   creates `-a` annotated tags with message `Hermes Agent v<sem>
   (<calver>)\n\nWeekly release`, providing a permanent metadata
   record on the tag object itself.

### 5.6 Worker direct-push protection

**Hermes status**: **Weak — relies on GitHub branch protection**. The
local checkout has no `pre-push` hook (verified: no
`.git/hooks/pre-push`). All protection is server-side. Hermes does
NOT document its branch protection rules in any committed file. The
contributor-check gate (§3.8) protects attribution metadata but does
NOT block direct pushes by maintainers.

The owner's fork has the `sync-upstream.yml` workflow which uses
`secrets.GITHUB_TOKEN` (`sync-upstream.yml:26`) — i.e. the built-in
fork-scoped token. It runs as `github-actions[bot]` and pushes to
the fork's main branch directly. **This is allowed.**

**Borrowable**: Nothing. Hermes does not have a "worker direct-push
protection" pattern documented. CLEO's worktree shim (per ADR-055 /
T1140) — which blocks git operations at the PATH level — is more
rigorous than anything Hermes does.

**Recommendation for T9345**: Maintain CLEO's stronger model; do not
weaken to Hermes's "GitHub branch protection + trust the humans"
posture.

### 5.7 Provenance graph (feature → bug → hotfix → release)

**Hermes status**: **Minimal — commit messages + PR numbers only**. The
provenance Hermes tracks:

- **Commit ↔ PR**: via `(#NNNNN)` suffix in commit subjects (auto-
  appended by GitHub squash-merge). `release.py:1288-1293` extracts the
  PR number with a regex; `generate_changelog` links it as
  `[#NNNNN](repo_url/pull/NNNNN)`.
- **Commit ↔ author**: via git author + parsed `Co-authored-by:`
  trailers, resolved through `AUTHOR_MAP`.
- **PR ↔ issue**: via the "Fixes #NNN" trailer in PR descriptions —
  but this is GitHub-side metadata, not tracked in the repo.
- **Salvage chain**: many commits carry `salvage of #NNNNN` in their
  subject (e.g. `git log: "fix: dashboard board pin authoritative
  over server current file (#20879) ([#21230]"`). This is the
  closest Hermes gets to "this hotfix was inspired by that earlier
  PR/issue" — manually authored, not auto-tracked.
- **Release ↔ commits**: via the tag and the committed
  `RELEASE_vX.Y.Z.md` file. The compare URL provides the linear range.

**Not present**:
- No task tracker integration (no JIRA, no Linear, no GitHub Projects
  beyond informal use).
- No "this commit closes acceptance gate X for task Y" trailer.
- No automated provenance graph (commit → epic → release).

**Borrowable**: The "embed PR number in commit subject + extract for
changelog" pattern. CLEO already does this implicitly; making it a
**hard gate** (CI rejects merges to main without `(#NNN)` suffix)
would mirror Hermes's behavior.

**Not borrowable**: Hermes's "provenance" is provenance-by-grep —
useful at small scale, fails at the multi-tier task model CLEO
operates. CLEO's tasks.db + BRAIN + acceptance gates are 10× richer
than anything Hermes ships. The T9345 ask for a "true audit trail"
must be designed within CLEO's own framework; Hermes provides no
template here.

---

## 6. What CLEO Can Borrow — Prioritized Recommendations

Ranked by ROI for the T9345 IVTR Release System overhaul.

### Tier 1 — Adopt directly (HIGH confidence)

1. **Dual CalVer + SemVer**. Keep CLEO's CalVer tag (`v2026.5.74`) as
   the canonical git tag. Add a separate SemVer in `package.json` /
   `Cargo.toml` for downstream packagers (Homebrew, AUR, npm). Bump
   atomically. **Implementation reference**: `release.py:1085-1109`.
2. **Annotated tags with structured messages**. CLEO currently creates
   lightweight tags; switching to `git tag -a <tag> -m "CLEO v<sem>
   (<calver>)\n\n<release-context>"` would put metadata on the tag
   object itself, surviving rebases and merges.
   **Implementation reference**: `release.py:1496-1504`.
3. **`release: published` GitHub event for downstream fan-out**.
   Decouple docs deploy / Docker retag / sentinel notifications from
   the in-band ship pipeline. **Implementation reference**:
   `docker-publish.yml:24-26`, `deploy-site.yml:3-5`.
4. **OCI revision label + git merge-base ancestor check** for floating
   tags (`:main`, `:latest`, future CLEO equivalents). Prevents tag
   regression under race conditions. **Implementation reference**:
   `docker-publish.yml:345-406` and `461-522`.
5. **Same-day suffix for hotfix tags** (`v2026.5.74.2`,
   `v2026.5.74.3`, …). Avoids branch proliferation; preserves the
   "this is a same-day patch" signal in the tag.
   **Implementation reference**: `release.py:1044-1053`.
6. **Pinned direct deps + lockfile-drift CI**. Already partially in
   place via pnpm; the `uv-lockfile-check.yml` pattern of running
   `uv lock --check` (CLEO equivalent: `pnpm install --frozen-lockfile
   --no-cache`) as a blocking PR gate is directly portable.
   **Implementation reference**: `uv-lockfile-check.yml`.
7. **Supply-chain audit on PR diffs**. Block PRs that introduce
   `.pth`-equivalent install hooks, base64+exec patterns, obfuscated
   subprocess calls. Adapt patterns to TypeScript (e.g. dynamic
   `Function(decoded)`, post-install scripts in package.json).
   **Implementation reference**: `supply-chain-audit.yml:38-117`.
8. **Print exact recovery command on each release-step failure**. CLEO's
   `cleo release ship` already prints structured errors; appending
   "to resume from this step, run `cleo release <subcommand>`" would
   add operator-survivable resume hints. **Implementation reference**:
   `release.py:1500-1558`.

### Tier 2 — Adopt selectively (MEDIUM confidence)

9. **Conventional-Commits parsing → categorized changelog**. CLEO
   already generates changelogs; aligning the regex shape (`^feat[\s:(]`
   etc.) and emoji headers to a Hermes-style standard would aid
   cross-project readability. **Implementation reference**:
   `release.py:1168-1199`.
10. **`AUTHOR_MAP` for git-email → GitHub-username resolution**.
    CLEO has fewer contributors; the value is lower but still real for
    consistent attribution in the release notes. **Implementation
    reference**: `release.py:41-1010` (data) + `1147-1166` (logic).
11. **Contributor-attribution CI gate**. Block PRs whose author email
    isn't in `AUTHOR_MAP`. Lower urgency for CLEO; useful if CLEO
    starts accepting outside PRs. **Implementation reference**:
    `contributor-check.yml`.
12. **Smoke test before pushing**. Add `cleo --help` and one targeted
    subcommand check (`cleo briefing` equivalent of Hermes's
    `dashboard --help` regression guard) **between build and push** in
    the release pipeline. **Implementation reference**:
    `.github/actions/hermes-smoke-test/action.yml`.
13. **Commit the rendered release notes**. Hermes commits
    `RELEASE_v0.13.0.md` to the repo root. CLEO already maintains
    CHANGELOG.md; adding per-release files alongside would make the
    git history self-documenting and agent-readable. **Implementation
    reference**: 12 `RELEASE_v0.*.md` files at repo root.

### Tier 3 — Reference but adapt heavily (LOW confidence / mismatch)

14. **Filter AI/bot co-authors out of release attribution**. Hermes
    explicitly drops `noreply@anthropic.com`, `cursor.com`, etc. from
    co-authors. CLEO's culture is the opposite — many commits carry
    Claude co-authorship and the user wants this surfaced.
    **Implementation reference**: `release.py:1222-1233` — but invert
    the filter. Track AI co-authors with their own marker.
15. **"Narrow ruff enforcement"**. Hermes blocks on exactly one ruff
    rule (PLW1514). CLEO's `pnpm biome ci .` is wider. Worth
    considering "what's the one rule that bites" if biome perf becomes
    a release-pipeline bottleneck. **Implementation reference**:
    `pyproject.toml:248-256`.

### Not borrowable — CLEO must invent

- **Epic-scoped completeness check**. Hermes has no precedent (§5.2).
- **Per-task acceptance gate runners**. Hermes treats CI as the gate
  surface; CLEO has 10× more per-task structure (§5.3).
- **Worktree-by-default + PATH shim worker protection**. CLEO's
  ADR-055 already exceeds Hermes's posture (§5.6).
- **Task ↔ commit ↔ release provenance graph**. CLEO already has
  tasks.db; Hermes provides no template (§5.7).
- **Mid-pipeline transactional rollback**. Hermes uses operator-driven
  human recovery (§5.1).
- **IVTR multi-stage gate ladder**. Hermes has no such concept.

---

## 7. Specific File / Line Citations (Audit Trail)

Every claim in this document is anchored to one of:

| Section | Cited file (paths under `/mnt/projects/hermes-agent/`) |
|---------|-------|
| §1 (identification) | `LICENSE`, `README.md:1-12,191-194`, `pyproject.toml:5-12`, git remotes, `scripts/release.py:1296` |
| §1.3 (tag history) | `git for-each-ref --sort=-creatordate refs/tags/v20*` |
| §1.4 (license) | `LICENSE:1-21` |
| §2 (CLEO precedent) | `/mnt/projects/cleocode/docs/specs/hermes-agent-llm-provider-architecture.md:6,14-18,53-63` |
| §3.1 (versioning) | `scripts/release.py:1056-1109`, `pyproject.toml:7`, tag listing |
| §3.2 (release.py) | `scripts/release.py:1400-1564`, full file 1568 lines |
| §3.3 (release event) | `.github/workflows/docker-publish.yml:24-26`, `.github/workflows/deploy-site.yml:3-5` |
| §3.4 (ancestor check) | `.github/workflows/docker-publish.yml:290-535`, esp. 345-406 and 461-522 |
| §3.5 (multi-arch docker) | `.github/workflows/docker-publish.yml:42-289`, `.github/actions/hermes-smoke-test/action.yml` |
| §3.6 (CI gate inventory) | `.github/workflows/*.yml` (all 13 files) |
| §3.7 (changelog gen) | `scripts/release.py:1296-1397`, `RELEASE_v0.13.0.md`, `RELEASE_v0.2.0.md` |
| §3.8 (contributor gate) | `.github/workflows/contributor-check.yml:1-73` |
| §3.9 (branch/PR rules) | `CONTRIBUTING.md:739-792`, `AGENTS.md:866-872`, `.github/PULL_REQUEST_TEMPLATE.md` |
| §3.10 (supply chain) | `pyproject.toml:13-63,111-126`, `.github/workflows/osv-scanner.yml`, `.github/workflows/supply-chain-audit.yml`, `.github/dependabot.yml` |
| §3.11 (cadence) | tag dates |
| §4.1 (structure) | `ls /mnt/projects/hermes-agent/`, `pyproject.toml:217-225` |
| §4.3 (tests) | `CONTRIBUTING.md:106-118`, `AGENTS.md:897-989`, `scripts/run_tests.sh` |
| §5.1 (mid-pipeline) | `scripts/release.py:1500-1558` |
| §5.4 (hotfix suffix) | `scripts/release.py:1044-1053` |
| §5.5 (tag alignment) | `scripts/release.py:1496-1513`, `.github/workflows/docker-publish.yml:399-406` |
| §5.6 (push protection) | Negative evidence: no pre-push hook, no documented branch protection in repo |
| §5.7 (provenance) | `scripts/release.py:1214-1233` (co-author filter), `1288-1293` (PR extract) |

Web confirmation (used only to verify upstream identity, not for content):
- `WebSearch: NousResearch hermes-agent github repository` confirmed
  the canonical URL `https://github.com/NousResearch/hermes-agent`,
  the v0.13.0 / v2026.5.7 release identity, and the public-facing
  feature set. No content from the web search was used where local
  evidence exists.

---

## 8. Appendix A1 — Full LICENSE Text

```
MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 9. Appendix A2 — Critical Code Excerpts

### A2.1 The full `release.py main()` flow (annotated)

```python
# scripts/release.py:1400-1564 (lightly elided for length)

def main():
    parser = argparse.ArgumentParser(description="Hermes Agent Release Tool")
    parser.add_argument("--bump", choices=["major", "minor", "patch"])
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--date", type=str)
    parser.add_argument("--first-release", action="store_true")
    parser.add_argument("--output", type=str)
    args = parser.parse_args()

    # 1. Determine CalVer date (default today, override via --date)
    if args.date:
        calver_date = args.date
    else:
        now = datetime.now()
        calver_date = f"{now.year}.{now.month}.{now.day}"

    # 2. Resolve next available tag (handles same-day collisions)
    base_tag = f"v{calver_date}"
    tag_name, calver_date = next_available_tag(base_tag)

    # 3. Determine SemVer
    current_version = get_current_version()
    if args.bump:
        new_version = bump_version(current_version, args.bump)
    else:
        new_version = current_version

    # 4. Find previous tag (most recent v20*-prefixed)
    prev_tag = get_last_tag()

    # 5. Gather commits since prev tag
    commits = get_commits(since_tag=prev_tag)

    # 6. Generate categorized changelog
    changelog = generate_changelog(commits, tag_name, new_version,
                                    prev_tag=prev_tag,
                                    first_release=args.first_release)

    if args.publish:
        # 7. Update __init__.py + pyproject.toml versions
        if args.bump:
            update_version_files(new_version, calver_date)
            # 8. Commit version bump
            git_result("add", str(VERSION_FILE), str(PYPROJECT_FILE))
            git_result("commit", "-m",
                       f"chore: bump version to v{new_version} ({calver_date})")

        # 9. Create annotated tag with structured message
        git_result("tag", "-a", tag_name, "-m",
                   f"Hermes Agent v{new_version} ({calver_date})\n\nWeekly release")

        # 10. Push commits + tags
        git_result("push", "origin", "HEAD", "--tags")

        # 11. Build sdist + wheel (optional, non-fatal)
        artifacts = build_release_artifacts(new_version)

        # 12. Create GitHub release with notes file + artifacts
        gh_cmd = ["gh", "release", "create", tag_name,
                  "--title", f"Hermes Agent v{new_version} ({calver_date})",
                  "--notes-file", str(changelog_file)]
        gh_cmd.extend(str(path) for path in artifacts)
        subprocess.run(gh_cmd, capture_output=True, text=True,
                       cwd=str(REPO_ROOT))
```

### A2.2 The ancestor check (Docker `:main`)

```bash
# .github/workflows/docker-publish.yml:345-406 (excerpt)

- name: Decide whether to move :main
  id: main_check
  run: |
    set -euo pipefail
    image=nousresearch/hermes-agent

    # Pull the linux/amd64 sub-manifest config + extract OCI revision label
    image_json=$(
      docker buildx imagetools inspect "${image}:main" \
        --format '{{ json (index .Image "linux/amd64") }}' \
        2>/dev/null || true
    )

    if [ -z "${image_json}" ]; then
      echo "No existing :main — safe to publish."
      echo "push_main=true" >> "$GITHUB_OUTPUT"
      exit 0
    fi

    current_sha=$(
      printf '%s' "${image_json}" \
        | jq -r '.config.Labels."org.opencontainers.image.revision" // ""'
    )

    # Our SHA must be a descendant of the current :main
    if git merge-base --is-ancestor "${current_sha}" "${GITHUB_SHA}"; then
      echo "Our commit is a descendant of :main — safe to advance."
      echo "push_main=true" >> "$GITHUB_OUTPUT"
    else
      echo "Another run advanced :main past us (or diverged) — leaving it alone."
      echo "push_main=false" >> "$GITHUB_OUTPUT"
    fi
```

### A2.3 The supply-chain pattern scanner

```bash
# .github/workflows/supply-chain-audit.yml:43-117 (excerpt)

DIFF=$(git diff "$BASE".."$HEAD" -- . ':!uv.lock' ':!*.lock' ':!package-lock.json' || true)

# .pth files (the litellm attack mechanism)
PTH_FILES=$(git diff --name-only "$BASE".."$HEAD" | grep '\.pth$' || true)

# base64 decode + exec/eval combo
B64_EXEC_HITS=$(echo "$DIFF" | grep -n '^\+' \
  | grep -iE 'base64\.(b64decode|decodebytes|urlsafe_b64decode)' \
  | grep -iE 'exec\(|eval\(' | head -10 || true)

# subprocess with encoded/obfuscated command argument
PROC_HITS=$(echo "$DIFF" | grep -n '^\+' \
  | grep -E 'subprocess\.(Popen|call|run)\s*\(' \
  | grep -iE 'base64|\\x[0-9a-f]{2}|chr\(' | head -10 || true)

# Install-hook files
SETUP_HITS=$(git diff --name-only "$BASE".."$HEAD" \
  | grep -E '(^|/)(setup\.py|setup\.cfg|sitecustomize\.py|usercustomize\.py|__init__\.pth)$' || true)
```

---

## 10. Open Questions for the T9345 RCASD Phase

Items the research could NOT settle from local evidence — flag for
specification phase:

1. **Hermes branch protection rules** — what does NousResearch
   configure at the GitHub API level for `main`? Not committed to the
   repo. To get this, the T9345 spec author would need to ask Nous
   directly or read public security policy. Mitigation: assume
   CLEO's existing `gh api -X PUT .../protection` setup is at least
   as rigorous, do not weaken.
2. **How Hermes handles "release.py crashed at step 9"** — local
   evidence shows printed recovery commands, but no automated
   resume. Question for spec: should CLEO build a true resumable
   state machine (with sidecar state file) or replicate
   Hermes's "human-driven resume" pattern?
3. **The `RELEASE_v0.10.0.md`-style "minimal" release note**. Quote
   (`RELEASE_v0.10.0.md:15-17`): "This release includes 180+ commits
   with numerous bug fixes... Full details will be published in the
   v0.11.0 changelog." Hermes occasionally ships a minimal stub
   release note for ad-hoc cuts. Does CLEO want this option?
4. **No "release branch" model in Hermes**. CLEO currently uses
   `release/v<version>` branches (per ADR-065). Is the branch
   genuinely load-bearing, or could CLEO simplify to Hermes's
   "tag main directly"? The branch carries the changelog commit;
   removing it would require an alternative commit path.

---

## 11. Final Verdict

**Hermes-agent is the right precedent for CLEO Phase 4 (LLM provider
stack) — and it has already been used as such.**

**Hermes-agent is a PARTIAL precedent for T9345 (Release System
overhaul)**:

- **Strong precedent**: tagging, changelog generation, release-event
  fan-out, Docker floating-tag ancestor checks, supply-chain posture,
  pinning + lockfile gates, contributor attribution, smoke tests
  before publish.
- **Silent on**: epic completeness, multi-stage gate ladders, task-
  scoped provenance, worker direct-push protection, transactional
  rollback, IVTR-style lifecycle.

CLEO's IVTR overhaul should **borrow Hermes's mechanics** (the eight
Tier-1 items in §6) and **invent its own semantics** for the gate
ladder, epic completeness, and provenance graph (the "Not borrowable
— CLEO must invent" list in §6).

The single most valuable insight from this research is:
**Hermes-agent's release pipeline is a Python script, not a workflow**.
The maintainer runs `python scripts/release.py --bump minor --publish`
from their laptop. CI exists only to gate PRs (lint, tests, supply-
chain) and to react to the `release: published` event (Docker, docs).
This is a viable design point — "release pipeline as local imperative
script, CI as gate runner only" — that CLEO has explicitly rejected
in favor of `cleo release ship` orchestrating the full ship cycle.
T9345 should validate that decision: if `cleo release ship` is
mid-pipeline-fragile, the Hermes pattern of "local script + GH-event
fan-out" is the alternative architecture to consider.

---

*End of report. Total: ~1290 lines.*
