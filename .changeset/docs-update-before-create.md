---
id: docs-update-before-create
tasks: [T14109, T14115]
kind: feat
summary: "cleo docs add refuses a likely duplicate and routes to cleo docs update; --new-because adds it anyway, recorded"
---

Owner decision D11210 ("docs never rot"). `cleo docs add` now refuses a doc
that likely duplicates an existing one. Before, T10361 only warned about a
similar slug.

A doc counts as a likely duplicate when it has:
- the same content as an existing doc;
- a slug of the same kind that is at least 85% similar (task ids and
  numbers ignored);
- a title of the same kind whose words overlap at least 80%; or
- text in which at least 60% of the 5-word runs already appear in an
  existing doc of the same kind.

The refusal (`E_DOC_DUPLICATE`) names the existing doc's slug and title, and
how to read and update it: `cleo docs fetch <slug>`, then
`cleo docs update <slug>`.

To add a truly new doc anyway, pass `--new-because "<why>"` (at least 15
characters). The reason is recorded in `.cleo/audit/docs-new-because.jsonl`.

`--allow-similar` alone no longer bypasses the check. The thresholds are
fixed; the `.cleo/canon.yml` `similarity` block is no longer read.

CLEO-INJECTION, ct-documentor and ct-task-executor tell agents to find and
update first.

T14115: `cleo docs list --limit 0` silently returned 200 of 6,307 docs,
because the read model capped the project listing at 200. It now returns
every match, with or without `--type`. The envelope reports
`population: { matched, returned, truncated, limit }`, as `cleo list` does.
The duplicate check reads the whole store through the same listing.
