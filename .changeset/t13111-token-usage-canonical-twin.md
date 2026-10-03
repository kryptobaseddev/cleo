---
id: t13111-token-usage-canonical-twin
tasks: [T13111]
kind: fix
summary: Token usage is recorded while a session is bound (it moves to tasks_token_usage)
---

Token rows were written to the bare `token_usage` table. That table's foreign keys point at the bare
`sessions` and `tasks` tables, which the runtime stopped writing in T11578, so they stay empty. With
foreign keys on, every token row that named a session or a task was refused, and the refusal was
silently swallowed. Token accounting recorded nothing while a session was bound (the normal agent
case), and `cleo llm cost --session` found no rows.

Every token usage reader and writer now uses the prefixed twin `tasks_token_usage`. It has the same
columns, and its session and task ids are plain text with no cross-table foreign key. The twin
classification is unchanged (portable-personal, journal spec Q9). Exodus reconcile now lands legacy
token rows in the twin too, because its targets follow the runtime binding (T12355). An additive
reconcile still fills them in: token, audit and pipeline-manifest rows are named as append-only
history instead of being inferred from the table rename.

No data moves yet. Rows the bare table already holds stay there and are still synced as the bare
twin; only commands run with no session bound ever reached it. Until T13115 folds those rows in
through the T12535 twin collapse:

- `cleo token list` / `summary` / `show` count only the new table;
- `cleo token delete` and `clear` remove matching rows from both tables, so a cleared row cannot sync
  on or come back with the fold.

A one-shot SQL carry migration was considered and not shipped. It has to hard-code the twin's column
set. Real stores all have the full set, but the representative exodus fixture's minimal twin showed
that such a migration fails the store open whenever the shape differs, and a store open must never
brick on a shape surprise.
