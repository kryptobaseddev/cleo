---
id: t13226-fk-action-parent-uid
tasks: [T13226]
kind: fix
summary: Sync journal - an FK SET NULL or cascade fired by a parent delete now names the parent by uid, so the SET NULL is journaled as a U and cascaded child deletes carry the parent's uid in their key.
---
