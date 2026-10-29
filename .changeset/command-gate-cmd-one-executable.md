---
id: command-gate-cmd-one-executable
tasks: [T14155]
kind: fix
summary: "A command gate whose cmd carries its arguments is refused on write and reports the fix when run"
---

A command gate runs `cmd` with `args` and no shell, so `"cmd": "node -e 0"` started a
program named `node -e 0` and failed with a bare `spawn node -e 0 ENOENT`.

- `cleo req add` and `cleo req replace` now refuse such a gate with
  `cmd is one executable; put its arguments in args` and the split it should be
  (`"cmd":"node","args":["-e","0"]`). A `cmd` naming an existing file whose path has a
  space in it is still accepted.
- Reading or parsing a stored gate never refuses, so tasks that already hold one keep
  loading. Running one reports the same message as an `error` result instead of ENOENT.
- `cleo req migrate` proposes the executable in `cmd` and its arguments in `args`.
