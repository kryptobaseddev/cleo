---
id: git-shell-alias-command-keys
tasks: [T14405]
kind: fix
summary: "cleo run keeps a git shell alias and inline command-running -c keys on the class plan"
---

`cleo run` charged `git <alias>` light even when the alias is a shell command
(`alias.t = !pnpm test`, configured or given inline with `-c`), and charged
`git -c core.sshCommand='<cmd>' fetch`, `-c core.fsmonitor='<cmd>'` and the
other config keys whose value git runs light too, so their commands ran under a
1 GiB charge. Both now keep the class plan. A value that runs nothing heavy
(`-c core.editor=true`, `-c core.pager=cat`, `-c core.fsmonitor=false`) and an
alias for another git command stay light.
