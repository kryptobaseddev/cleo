---
id: t13574-bun-option-parsing
tasks: [T13574]
kind: fix
summary: "Typed-gate input capture parses bun's other subcommands, its -c config flag and --cwd"
---

Following T13566, bun's first positional argument is taken as the script only when it is an existing regular file (`bun a.ts`). Any other word (`install`, `add`, `pm`, `create`, `upgrade`, …) is a subcommand whose arguments name packages, so none of them is captured. bun's `-c` is now its `--config` flag, not inline eval, so `bun -c bunfig.toml test a.test.ts` still captures the test file. The values of bun's value flags (`-c`, `--config`, `--cwd`, `-r`, `--preload`, `--env-file`, `--tsconfig-override`) are never the script or an input, and `--cwd dir` (or `--cwd=dir`) resolves the named files from `dir`. Other interpreters are unchanged.
