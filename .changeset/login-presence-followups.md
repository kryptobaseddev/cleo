---
id: login-presence-followups
tasks: [T13308]
kind: fix
summary: Login picker needs stdin and stderr on a terminal; presence refresh sends every origin in parallel
---

- **The login picker.** `cleo login`'s target picker opened whenever stdin was a
  terminal. With stderr redirected (`cleo login 2>log`), it drew into the log
  and waited on the keyboard, which looked like a hang. The picker and the
  first-run consent prompt now share one rule, `promptAllowed`: stdin and
  stderr must both be terminals, and the run must not be under CI. Otherwise the
  run picks the non-interactive target. The help text says that such a run
  links unattended without prompting.
- **The presence refresh.** It sends to every linked Nexus origin at once, so
  a project linked to several origins still costs at most one 3 s timeout at
  teardown.
- **No prompts.** A test pins that the device-credential read used by the
  refresh starts no process. The machine key and global salt are plain files,
  with no OS keychain, so a background refresh can never raise a prompt.
- **Server labels can't forge lines (#1958 review).** Project names, labels
  and restore commands in the first-run project list and the project-link
  summaries are folded to one line, so a label can't forge an extra row. The
  sanitizer also strips the direction marks U+200E, U+200F and U+061C, and
  treats U+2028/U+2029 as line breaks.
- **`cloud verify --deep` and missing blobs (#1947 review).** A snapshot the
  server lists, but whose checkpoint or bundle then answers 404, is reported as
  `problem: 'blob missing'`. That makes the verdict untrusted for the newest
  snapshot and adds a warning for older ones. Timeouts, 5xx and auth errors
  still fail the command.
