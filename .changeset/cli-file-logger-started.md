---
id: cli-file-logger-started
tasks: [T14605]
kind: fix
summary: "the CLI starts its pino file logger again, so .cleo/logs/cleo.log is written and info and debug lines are kept"
---

- Every non-help `cleo` call now starts the file logger once per process,
  using the merged `logging` config (level, `filePath`, rotation; `CLEO_LOG_LEVEL`
  and `CLEO_LOG_FILE` still override). Before this nothing called it, so every
  `getLogger()` fell back to the stderr warn logger, `.cleo/logs/cleo.log` was
  never written and the info half of each audit dual-write was dropped.
- Outside a project (no `.cleo/` directory) nothing starts and stderr warnings
  behave as before. `--quiet` still silences the logger.
