---
id: hook-stop-benign-session-end
tasks: [T13890]
kind: fix
summary: cleo hook stop no longer warns when session end finds no session to end (exit 24 or 31)
---

A Stop with no bound session makes `cleo session end` exit with
`E_SESSION_UNBOUND` (24) or `E_SESSION_NOT_FOUND` (31). The Stop dispatcher
printed "session end failed … (exit 24)" for that expected case. Those two
exits are now benign (`SESSION_END_BENIGN_EXITS`). Every other non-zero exit
still prints one warning line.
