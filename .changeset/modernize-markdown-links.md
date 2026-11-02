---
id: modernize-markdown-links
tasks: [T14185]
kind: fix
summary: "docs modernize --apply keeps relative markdown links (re-pointed at new paths) unless --wikilinks is given, writes only resolvable slugs, and edits kept files only by the link-fix rows the dry run lists"
---

Found in lane-d's T14108 group 1 run, which was rolled back:

- **Links stay markdown.** Relative links (and images) in moved files are
  re-pointed at their targets' new paths, so they still render on GitHub. A
  link to a merged file now points at its survivor. Rewriting links to
  `[[slug]]` is opt-in with `--wikilinks`. Both styles become `links-to`
  graph edges.
- **Only resolvable slugs.** Fold headings and merge notes cite the slug the
  merged file is actually stored under: its existing doc, or
  `<plan slug>-superseded`. They never use a folder-prefixed path id such as
  `specs-cleo-logging-contract`. A superseded file is stored even when its
  survivor's bytes already exist under another name, so the cited slug always
  resolves.
- **Keep means no unplanned edits.** In a file the plan marks `keep`, apply
  re-points only the hrefs of relative links whose targets move, and nothing
  else. Each such edit is a `link-fix` row in the dry-run plan (`linkFixes`),
  so apply never does what the dry run did not show, and a plan whose
  `link-fix` names a file it does not keep is refused. Folds into a kept file
  live in the store doc only.
