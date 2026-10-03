---
id: t13111-token-usage-canonical-twin
tasks: [T13111]
kind: fix
summary: Token usage is recorded while a session is bound (it moves to tasks_token_usage)
---

Token rows were written to the bare `token_usage` table. That table's foreign keys point at the bare
`sessions` and `tasks` tables, which the runtime stopped writing in T11578, so they stay empty. With
foreign keys on, every token row that named a session or a task was refused, and the refusal was
silently swallowed. As a result, token accounting recorded nothing while a session was bound (the
normal agent case), and `cleo llm cost --session` found no rows.

Every token usage reader and writer now uses the prefixed twin `tasks_token_usage`. It has the same
columns, and its session and task ids are plain text with no cross-table foreign key. The twin
classification is unchanged (portable-personal, journal spec Q9). Exodus reconcile now lands legacy
token rows there as well, because its targets follow the runtime binding (T12355).

No data moves. Rows the bare table did store stay there: only commands run with no session bound
ever reached it. Those rows are still synced as the bare twin, and T13115 folds them in through the
T12535 twin collapse. A one-shot SQL carry was rejected because it fails the store open on a store
whose twin has a different shape.
