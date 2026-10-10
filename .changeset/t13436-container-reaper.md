---
id: t13436-container-reaper
tasks: [T13436]
kind: feat
summary: "Throwaway containers: a `--rm` / `cleo.task` + `cleo.ttl` label convention, and a bounded reaper behind `cleo doctor system --repair` (dry run first)"
---
Throwaway Postgres containers started with `docker run` and no `--rm` left 475 anonymous volumes (52 GB) on one machine, and 11 containers ran for as long as two days.

- **Convention (ct-task-executor 2.8.0):** start one-shot containers with `docker run --rm`. Containers reused across runs get a named volume. Both carry the labels `cleo.task=<id>` and `cleo.ttl=<duration>`.
- **Dry run:** `cleo doctor system --repair` adds a `repair` plan to the report. It lists stopped labelled containers created longer ago than their `cleo.ttl`, and anonymous dangling volumes (docker-generated 64-hex names, including volumes left by non-CLEO containers). A container whose ttl or start time cannot be read is listed under `invalidTtl` and left alone.
- **Running containers:** a running labelled container is never removed. One running past its ttl, counted from its last start (`State.StartedAt`, which a restart resets), goes under `runningExpired` and is reported only. A reused container started for a new test run is therefore never removed mid-test.
- **Apply:** `--repair --apply` removes exactly what the plan lists. Containers go with `docker rm -v`, never `-f`, so one started after the plan is refused by docker and reported (its anonymous volumes go with it, named ones never do). Volumes go with `docker volume rm`. Each removal has its own outcome. A volume that gained a user is refused by docker and reported, not forced.
- **Never touched:** an unlabelled container, running or not, and a named volume.
