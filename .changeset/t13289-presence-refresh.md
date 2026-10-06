---
id: t13289-presence-refresh
tasks: [T13289]
kind: fix
summary: a linked machine keeps its Cleo Nexus presence fresh during normal CLI use (at most hourly, best-effort, no daemon), so cloud status no longer goes stale a day after linking
---

Cloud presence was sent only when a project was linked, so `cleo cloud status` reported
a linked machine as stale ("attention") 24 hours later. Ordinary `cleo` commands now
refresh the presence of a project this machine linked:

- at most once an hour per project;
- started alongside the command and never awaited by it, with a 3-second timeout;
- registered with the background-op registry, so teardown drains it within its deadline.

It sends only for a replica attached from this device's own credential, with the same
path-free body as the attach. A failure is ignored, and the next attempt comes an hour
later. No daemon, timer or background process is added. Unlinked projects load nothing
extra, and `CLEO_DISABLE_PRESENCE_REFRESH=1` turns the refresh off.
