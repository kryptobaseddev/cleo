---
id: xplat-shell-path-tmp
tasks: [T12604, T12605, T12606]
kind: fix
summary: agent spawns, evidence runs, worktree hooks, the git shim and prompt files now work on Windows (no sh/which/rm/tar, ';' PATH, os.tmpdir())
---

Several runtime paths assumed a POSIX host. On Windows that broke them outright:

- **Spawn wrappers (T12604).** `buildSpawnArgs` (core) and `buildAgentSpawnArgs`
  (adapters) wrapped every command in `sh -c 'ulimit -c 0; exec "$@"'` when
  systemd-run was absent, so every agent spawn and `tool:test` evidence run
  failed with ENOENT. On win32 the command is now spawned directly. Windows
  writes no core files, so no suppression is needed there. POSIX keeps the
  ulimit wrapper.
- **Shell-outs (T12604).** Worktree hooks and release build commands now run
  through a single resolver, `shellInvocation` in `@cleocode/paths`: `/bin/sh -c`
  on POSIX and `%ComSpec% /d /s /c` on Windows. `which` probes (`commandExists`,
  dependency and runtime checks, adapter discovery, issue diagnostics, release
  artifacts, fs-harden detection) now use `findOnPath`. `rm -f index.lock` is
  replaced by `fs.rmSync`. The worktree-orphan, GC-quarantine and skills
  migration archives use the bundled `tar` library.
- **PATH (T12605).** The git-shim PATH was built as `${shimDir}:${PATH}`. On
  Windows that fused the shim dir with the first real entry and dropped both,
  so branch protection was silently absent. PATH is now composed with the
  platform delimiter under the existing `Path`/`PATH` key. `findOnPath` honours
  `PATHEXT`, so `cleo-dev.cmd` is found. On win32 the shim installs `git.cmd`
  plus an sh launcher instead of an extensionless symlink. The shim resolves
  real Git as `git.exe` there.
- **Temp paths (T12606).** The claude-code, codex and pi adapters wrote prompts
  to a literal `/tmp/…`. Each prompt now goes to a `mkdtemp` directory under
  `os.tmpdir()`, removed after the child exits. The prod-DB test guard, doctor
  temp classification and bundle export filter now share `isEphemeralPath`,
  which uses realpath and `path.relative` and takes an injectable platform.

Not changed: `captureWrapped` still refuses to run on Windows, because
process-group containment is unavailable there. `cleo-os` harness `/tmp` and
`which` sites are out of scope.
