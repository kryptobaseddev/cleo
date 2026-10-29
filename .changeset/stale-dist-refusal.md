---
id: stale-dist-refusal
tasks: [T14123, T14097]
kind: fix
summary: "test runs and test-run receipts refuse a workspace package whose dist was built from other source than it holds (E_WORKSPACE_STALE_DIST)"
---

The root build stamps each workspace package's `dist/.source-stamp.json`
with a content hash of its tracked non-test `src/` files. `cleo run --class
test`, `tool:test`, `tool:test-affected` and `test-run:` receipts now refuse
a run when a package the tests load has a stamp whose hash differs from the
source it holds, with `E_WORKSPACE_STALE_DIST`. The refusal names the
packages and the rebuild command (`pnpm --filter "<pkg>" run build`).

File mtimes are never compared: a checkout or branch switch rewrites them
without changing content. A built package with no stamp (or an older-format
one) is never refused but warned about, in one summary line per run
(`W_WORKSPACE_UNSTAMPED_DIST`, fix: run the root build); `cleo run` prints it
on stderr, never into `--passthrough` stdout. A `dist/` file newer than its
stamp (a per-package rebuild) is not judged. The root build stamps every
package, so CI stays silent.

The stamp is kept in published packages and is now deterministic: it holds
only the schema and the source hash, so every build of the same source
ships the same bytes. Whether a rebuild followed the stamp is read from the
stamp file's own mtime, not from a field inside it.
