---
id: modernize-repo-links
tasks: [T14196]
kind: fix
summary: "docs modernize re-points links into moved files from markdown outside the modernize root, such as the repo README and package READMEs; CHANGELOG and .changeset files are never rewritten"
---

`cleo docs modernize` only fixed links inside its root (kept files, and
excluded folders since T14194), so moving `docs/` files broke links from the
repository README, AGENTS.md and package READMEs.

- The dry run now finds tracked markdown outside the root that links to a
  moved or merged file, using `git grep` in the invoking checkout.
- Each such href becomes a `link-fix` row with `base: repo`: a path relative
  to the plan's new `repoRoot`, pinned by the file's sha256.
- `--apply` edits exactly those hrefs. It requires those files to be
  committed (unless `--allow-dirty`) and unchanged since the plan, and writes
  nothing to the store for them.
- The receipt records `repoRoot` and the base of each write, so
  `--rollback` restores them.
- CHANGELOG files, `.changeset/`, `.cleo/` and vendored or built folders are
  never rewritten; they stay listed in a row's `refs`.
- A plan or receipt whose `repoRoot` is not this repository's checkout, or
  does not hold the root, is refused.
