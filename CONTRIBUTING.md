# Contributing to CLEO

Thanks for contributing. This file documents the conventions and tooling that
keep CLEO's commit history machine-readable for orchestration and post-release
reconciliation.

## Quick start

```bash
pnpm install            # install workspace deps
pnpm run hooks:install  # wire up git hooks (simple-git-hooks)
pnpm run build          # build all packages
pnpm run test           # run the full vitest suite
pnpm biome check .      # lint + format check
```

## Commit conventions

Commits MUST follow the conventional-commits format that the existing
`.git/hooks/commit-msg` enforces:

```
<type>(<scope>): <subject>
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.

### Release commits — T-prefixed task IDs are MANDATORY

`scripts/hooks/commit-msg-release-lint.mjs` enforces an additional rule on
release commits — those whose subject begins with `chore(release):` or
`feat(release):`.

> **Every release commit MUST cite at least one `T<digit>+` task ID in the
> body.**

The task ID anchors post-release reconciliation (T1411): the reconciler reads
the release commit, extracts the cited task IDs, and stamps them done in
`.cleo/tasks.db`. Releases that ship work without naming the tasks they ship
break that pipeline.

#### How to comply

Add a `Refs:` line (or any line containing `T\d+`) to the commit body:

```
chore(release): v2026.4.145

Refs: T1407, T1410, T1411
```

#### Hook behavior

- Non-release commits: hook exits `0` immediately (perf-fast path).
- Release commit with one or more `T\d+` references: exit `0`.
- Release commit without any `T\d+` reference: exit `1` with an actionable
  error message.

#### Bypass (audited)

For genuine emergencies — incident hotfixes where an operator must ship before
a task can be filed — the hook supports an audited bypass:

```bash
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="incident NNNN hotfix" \
  git commit -m "chore(release): v2026.4.146"
```

Both env vars are required. The bypass appends one JSON-line record to
`.cleo/audit/force-bypass.jsonl` capturing the hook name, ISO-8601 timestamp,
the operator-supplied reason, and the offending commit subject. Use this
sparingly; every bypass is auditable.

## Hook installation details

CLEO uses [`simple-git-hooks`](https://github.com/toplenboren/simple-git-hooks)
for hook wiring (no postinstall scripts, no autoinstall). The hook config lives
under the `simple-git-hooks` key of the root `package.json`. After `pnpm
install` you MUST run:

```bash
pnpm run hooks:install
```

…once to register the hooks with git. Re-run it whenever the hook config
changes.

To skip hook setup in CI or for an unsupported environment, simply do not run
`hooks:install` — git will fall back to its built-in hooks (or none).
