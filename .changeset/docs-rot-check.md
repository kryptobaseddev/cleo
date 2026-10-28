---
id: docs-rot-check
tasks: [T14111]
kind: feat
summary: "cleo docs rot reports stale, duplicate and orphaned docs from git alone, and flags a merged change's tasks for the docs it left stale"
---

A doc declares the code it documents in its frontmatter (`covers:`, the same
glob grammar as a skill's `metadata.covers`). `cleo docs rot` then reports:

- **stale**: a covered file changed on main after the doc last did (a PR that
  changes code and its doc together is not stale);
- **duplicates**: `docs/` files with identical bodies or near-identical titles;
- **orphans**: a covers glob matching no tracked file, or a `docs/` file no
  other tracked file names.

`--changed <base>..<head>` lists the docs a merged change left stale, and
`flagDocsRotOnTasks` labels that change's tasks `docs-update` with a note per
doc (the post-merge sweep calls it). `--strict` exits 2 on any finding; the
release cut runs the same scan. It reads git only, never the store, and takes
about half a second on this repo.
