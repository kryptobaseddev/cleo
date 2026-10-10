---
id: t13436-container-reaper
tasks: [T13436]
kind: feat
summary: "Throwaway containers: a `--rm` / `cleo.task` + `cleo.ttl` label convention, and a bounded reaper behind `cleo doctor system --repair` (dry run first)"
---
Throwaway Postgres containers started with `docker run` and no `--rm` left 475 anonymous volumes (52 GB) on one machine, and 11 containers ran for as long as two days.

- **Convention (ct-task-executor 2.8.0):** start one-shot containers with `docker run --rm`. Containers reused across runs get a named volume. Both carry the labels `cleo.task=<id>` and `cleo.ttl=<duration>`.
- **Dry run:** `cleo doctor system --repair` adds a `repair` plan to the report. It lists labelled containers whose age is past `cleo.ttl`, and anonymous dangling volumes (docker-generated 64-hex names). A container whose ttl cannot be parsed is listed under `invalidTtl` and left alone.
- **Apply:** `--repair --apply` removes exactly what the plan lists. Containers go with `docker rm -f -v` (their anonymous volumes go with them, named ones never do), and volumes with `docker volume rm`. Each removal has its own outcome. A volume that gained a user is refused by docker and reported, not forced.
- **Never touched:** an unlabelled container, running or not, and a named volume.
