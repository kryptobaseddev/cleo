---
id: t12988-req-replace
tasks: [T12988, T13486]
kind: feat
summary: cleo req replace swaps a typed gate's definition in place (same AC row, ordinal and REQ-ID, superseded gate kept in history), and cleo verify --run --req runs and caches only the selected gates
---

**`cleo req replace <task> <REQ-ID> --gate '<json>' [--reason "<why>"]`**
replaces a typed acceptance gate's command, args, cwd or other fields in
place. Before this, the only way out was `cleo update --acceptance`, which
turns every typed gate on the task into plain text.

- The gate keeps its acceptance index, its AC row (id and ordinal; a REQ-ID
  row's id derives from the REQ-ID) and its REQ-ID. The gate JSON's `req` must
  be absent or equal the REQ-ID.
- The superseded gate is kept as an AC history row (reason `replace`), and in
  the task audit row with its last typed result.
- Evidence bindings stay on the row but go stale. Typed results and criterion
  links are pinned to the criterion text hash, so the new gate must be verified
  again.
- In a locked pipeline stage it needs `--reason`, as `cleo update
  --acceptance` does. An unknown REQ-ID is refused, naming the task's REQ-IDs.
  An identical gate writes nothing.
- Prefer a repo-relative command and `cwd`. Typed gates run in the checkout
  that verifies, so a gate with no absolute `--dir` works in any worktree.

**`cleo verify <id> --run --req REQ-A,REQ-B`** runs and caches only the named
gates. Each cached pass is keyed on its own gate's definition, plus HEAD, the
dirty-tree fingerprint, cwd and inputs. The gates left out keep whatever cached
passes they have, and replacing one gate never invalidates the others. An
unknown REQ-ID is refused. `--req` without `--run` is refused.
