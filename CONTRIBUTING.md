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

## Post-tag reconciliation hook

`scripts/hooks/post-tag.sh` runs the registry-driven post-release invariants
gate (T1411 / ADR-056 D5) for a release tag. It invokes
`cleo reconcile release --tag <tag>`, which:

1. Reads the tag annotation and every commit between the previous tag and the
   target tag.
2. Extracts every `T\d+` task ID from those messages.
3. For each task ID:
   - If verification gates have all passed, stamp `status='done'`,
     `archive_reason='verified'`, and `release='<tag>'`.
   - If verification is null or incomplete, create a follow-up task
     `T-RECONCILE-FOLLOWUP-<tag>-<idx>` linked to the original.
4. Appends every mutation to `.cleo/audit/reconcile.jsonl`.

### When it runs

Git does not provide a native `post-tag` hook (the only tag-related hook is
`pre-push`, which fires *before* a push), so this script is invoked manually
or by CI runners that detect newly-created tags. Recommended patterns:

```bash
# Manual invocation immediately after `git tag`
scripts/hooks/post-tag.sh v2026.4.145

# CI runner that fans out from a tag-trigger event
- run: scripts/hooks/post-tag.sh "${{ github.ref_name }}"
```

### Exit codes

The hook forwards the CLI exit code:

- `0` — clean reconcile, no follow-ups.
- `1` — at least one invariant raised an error (operator MUST investigate).
- `2` — one or more unreconciled tasks; follow-up tasks were created.

### Dry run

```bash
cleo reconcile release --tag v2026.4.145 --dry-run
```

Dry-run mode reads the tag and commit range, extracts task IDs, and prints
what would happen, but writes nothing to `tasks.db` or
`.cleo/audit/reconcile.jsonl`. Useful for validating the cited task list
before tagging.

### JSON output

```bash
cleo reconcile release --tag v2026.4.145 --json
```

Emits the raw aggregated `InvariantReport` for downstream tooling (release
gates, dashboards).
