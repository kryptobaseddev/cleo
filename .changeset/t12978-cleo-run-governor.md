---
id: t12978-cleo-run-governor
tasks: [T12979, T12980, T12981]
kind: feat
summary: "cleo run: the governed front door for heavy commands, with a machine-wide budget per class, a soft stop (E_RESOURCE_DEFERRED, exit 75), pause-instead-of-kill under pressure, a macOS pressure backend and --passthrough for the provider hook"
prs: [1777]
---

`cleo run [--class test|build|full-build|db] [--wait [--timeout <s>]] [--passthrough] -- <command…>` admits a heavy command (test runner, compiler, build, install) through the machine-wide ResourceGovernor, so every agent, session and project shares one budget per class. Admitted, the command runs niced with the heavy-tool heap and worker caps as its own process group, and stdout carries one LAFS envelope at the end. Not admitted, it exits 75 with `E_RESOURCE_DEFERRED`, the running jobs and concrete ways forward; nothing was started. `--wait` joins the class's FIFO queue. The child's exit code passes through (128+n for a signal, 127 when it cannot start).

Under `backoff` only the oldest `cleo run` job keeps running; younger pausable jobs are SIGSTOPped as a group and resumed later (a 9-minute cap with a 5-minute run window), and nothing is killed. Installs, db-heavy work, cargo and CLEO's own commands (`cleo verify --evidence tool:test` holds tool locks and runs its tool detached) are never paused. A runner that dies leaves a record the next run uses to resume and stop its orphaned group, checked by process start time.

Watch, dev and serve commands are refused because they would hold a slot forever. An explicit `--class` overrides that. `--version`/`--help`, flag values (`pytest -k dev`, `vitest -t serve`), one-shot `next`/`vite` subcommands (`next lint`, `vite build`; `vite preview` still serves) and a `-w` that means write (`prettier -w`, `gofmt -w`) are not watchers.

`--passthrough` (what the T12983 hook emits) gives the child this process's stdin, stdout and stderr and exits with its code. cleo run writes nothing to stdout, an explicit ADR-086 exception: its own envelopes go to stderr, and it prints only a deferral, an ungoverned run, a pause or resume, or a one-line failure. With a terminal on stdin the child stays in the foreground process group (signalled by pid, never paused).

If the governor cannot write its state (a sandboxed or read-only CLEO home, a full disk, including a home whose slot directories already exist), the command runs ungoverned with a one-line notice instead of failing or queueing forever: only a held lock counts as a busy slot, and any other lock error fails open. Agent spawns and the sentient tick fail open the same way. A runner error under `--passthrough` goes to stderr, never into the child's stdout.

macOS now has a real pressure backend (`kern.memorystatus_vm_pressure_level`, free memory, load average), and CPU saturation narrows the class budgets too.
