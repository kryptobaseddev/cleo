---
id: flag-checker-reads-const-args
tasks: [T14667]
kind: fix
summary: "The command-existence gates now check flags on cleo docs update, docs migrate and the cleo doctor root"
---
- Gates 14, 15, 23, 31 and 42 share one flag checker. It now reads args passed
  as a module const built by `paramsToCittyArgs` (`cleo docs update`), a
  sub-command defined in another module (`cleo docs migrate`,
  `cleo doctor gate-text`) and a group root's own args (`cleo doctor --bogus`).
  These commands used to pass any flag unchecked.
- Wrong flags this exposed are fixed: the empty-identity doctor check named a
  nonexistent `cleo upgrade --refresh-identity`, and ct-epic-architect named
  `cleo list --tree` (now `cleo tree <id>`).
