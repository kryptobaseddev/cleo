---
id: win32-cmd-spawn
tasks: [T12618]
kind: fix
summary: provider CLIs and evidence tools spawn on Windows via their resolved path; npm .cmd shims go through cmd.exe with injection-safe quoting
---

On Windows, every npm-installed CLI (`claude`, `codex`, `gemini`, `opencode`,
`pi`, `pnpm`) is a `.cmd` shim. Node's bare-name lookup only tries `.exe` and
`.com`, and since CVE-2024-27980 Node refuses to spawn a `.cmd` without a
shell. Every adapter spawn, and every evidence run of a `.cmd` tool, therefore
failed on Windows even after T12604 made detection work.

`resolveSpawnInvocation` (in `@cleocode/paths`) resolves the command to its
absolute path with `findOnPath`. A `.exe` is spawned directly. A `.cmd` or
`.bat` is launched through `%ComSpec% /d /s /c` with `windowsVerbatimArguments`.
Each argument is escaped by `quoteCmdArg`, which applies MSVCRT quoting and then
caret-escapes every cmd metacharacter twice (the cross-spawn scheme against the
BatBadBut class). An argument containing a line break is refused with
`E_UNSAFE_BATCH_ARG`, because cmd.exe cannot carry one into a batch file.

The resolver is used in these places:

- `spawnCli`, which the codex, gemini-cli, opencode and pi adapters call
- the win32 branch of `buildAgentSpawnArgs` (claude-code)
- the win32 pgid branch of core `buildSpawnArgs`/`spawnWrapped` (evidence tools)

POSIX is unchanged.
