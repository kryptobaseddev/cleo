---
id: node26-exodus-function-case
tasks: [T14068, T14067]
kind: fix
summary: "On Node 26, opening a store with legacy databases no longer aborts the exodus migration on CURRENT_TIMESTAMP"
---

Node 26 bundles SQLite 3.54, whose authorizer reports a `DEFAULT
CURRENT_TIMESTAMP` column as a call to the function `CURRENT_TIMESTAMP`.
Exodus refused it as an opaque function because `PRAGMA function_list` names
built-ins in lower case and the check compared names exactly. The migration
aborted, the consolidated `cleo.db` stayed empty, and every write to the
tables it fills failed with `E_EXODUS_ABORT_WRITE_UNSAFE` (SQLite errcode
1811 from the abort guard trigger). Function names are now compared
case-insensitively; an overridden or non-built-in function is still refused.
