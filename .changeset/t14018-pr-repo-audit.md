---
id: t14018-pr-repo-audit
tasks: [T14018]
kind: fix
summary: 'Release note: re-verify pr/ci evidence recorded before the per-repository PR cache in projects that span repositories'
---

**Who is affected.** Before T13912, the `pr:`/`ci:` result cache was keyed
by PR number alone. A project whose CLEO root spans several GitHub
repositories, such as a declared `evidence.gitRoot`, `CLEO_EVIDENCE_GIT_ROOT`
or child repositories, could have resolved one repository's PR #N from
another repository's cached entry. `cleo complete` trusts a recorded `pr:`
atom as it was captured, so such an atom is not checked again. A project
with a single repository is not affected.

**One-time audit.** List the open tasks:

```bash
cleo list --status active --output id --limit 0
cleo list --status pending --output id --limit 0
```

For each task, read its recorded implementation evidence:

```bash
cleo show <id> --field /data/task/verification/evidence/implemented
```

Re-record any `pr:` or `ci:` atom that names a PR from a repository other
than the one the evidence git root points at. Name the repository explicitly,
so the check runs against the right origin:

```bash
cleo verify <id> --gate implemented --evidence "pr:<owner>/<repo>#<n>;files:<paths>"
cleo verify <id> --gate testsPassed --evidence "ci:<owner>/<repo>#<n>"
```

Done tasks keep their history; nothing is re-verified for them. Also covered by tests now:
- a matching `pr:<owner>/<repo>#<n>` keeps `repo` on the persisted atom;
- `ci:<owner>/<repo>#<n>` is refused against another origin and accepted
  against its own;
- an ssh `origin` resolves and caches under its `owner/repo` slug.
