---
id: cli-file-logger-started
tasks: [T14605]
kind: fix
summary: "the CLI starts its file logger again, writing .cleo/logs/cleo.*.log in-thread with no worker thread, so info and debug lines are kept"
---

- Every `cleo` call except `--help`/`--version` now starts the file logger once
  per process, from the merged `logging` config (level, `filePath`, `maxFileSize`,
  `maxFiles`; `CLEO_LOG_LEVEL` and `CLEO_LOG_FILE` still override). Before this
  nothing called it, so every `getLogger()` fell back to the stderr warn logger
  and the info half of each audit dual-write was dropped.
- Lines are written in the calling thread through `pino.destination`, not a
  pino-roll transport worker, so a CLI call starts no extra thread and uses no
  extra memory for logging. Buffered lines are flushed on exit and on SIGINT or
  SIGTERM (the signal is then re-raised, so exit status is unchanged).
  A logger that cannot start prints one `[cleo] File logger not started` line
  on stderr instead of failing silently, and an unknown `logging.level` falls
  back to `info` with a warning.
- Rotation now runs once at startup and keeps the existing file names
  (`cleo.<yyyy-MM-dd>.<n>.log`): today's newest file is reused until it reaches
  `maxFileSize`, and `maxFiles` older files are kept (at least one, since it may
  be another process's active file). A process that runs past midnight keeps
  the file it opened.
- Outside a project (no `.cleo/` directory) nothing starts and stderr warnings
  behave as before. `--quiet` still silences the logger.
