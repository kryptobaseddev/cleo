---
id: t13259-legacy-import-deferred-fk
tasks: [T13259]
kind: fix
summary: The legacy JSON import (cleo upgrade from todo.json) no longer fails tasks whose provenance session, parent or dependency comes later in the files; it runs in one transaction with foreign keys deferred, and drops every dangling reference with a warning naming it.
---
