---
id: doctor-log-file-dated
tasks: [T14641]
kind: fix
summary: "cleo doctor's log_file check finds the dated cleo.<date>.<n>.log files the logger writes, and the unused pino-roll dependency is gone"
---

- `cleo doctor` (and `cleo health --detailed`) looked for the configured
  `.cleo/logs/cleo.log`, which the logger never writes, so `log_file` warned
  even when logging worked. It now reads the same merged `logging` settings as
  the logger and reports the newest `cleo.<yyyy-MM-dd>.<n>.log` file.
- `pino-roll` is removed from `@cleocode/core`'s dependencies: since the
  in-thread logger nothing imports it.
