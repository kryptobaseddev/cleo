---
id: signal-reraise-drain-grace
tasks: [T13018]
kind: fix
summary: "an interrupted command that ran a tool lets pending best-effort memory drains finish before it dies by the signal"
---

When a command that runs a tool is interrupted (SIGTERM, SIGINT, SIGHUP), CLEO
stops the tool's process group and re-raises the signal. The brain writer and
the embedding and mental-model queues drain on that signal with
`process.once` and a 2 s deadline. The immediate re-raise let `signal-exit`
end the process mid-drain, so pending observations were lost. When such a
listener was registered, the re-raise now waits 2.5 s on a timer that keeps
the process alive; a drain that exits first ends it sooner. With no drain
listener, the re-raise is still immediate.
